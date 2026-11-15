import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { newLinkPaymentSuffix } from '../crypto/references';
import { DB_TOKEN, type Db } from '../db/database';
import { log } from '../logging/logger';
import { subtract } from '../money/money';
import { normaliseMsisdn } from '../msisdn/msisdn';
import { RateLimiter } from '../project-auth/rate-limiter';
import { SubmissionService } from '../providers/submission.service';
import { PreviewService } from '../transactions/preview.service';
import { TERMINAL_STATES, TransactionService } from '../transactions/transaction.service';
import { amountRefusal, isUuid, LINK_UNAVAILABLE_MESSAGE, linkPrincipal, METHOD_UNAVAILABLE_MESSAGE, neutralProviderLimit, PublicLinkService } from './public-view';

export const ADDRESS_LIMITED = 'Too many requests from this connection. Wait a minute and try again.';
const NUMBER_LIMITED = 'Too many payment requests to this number. Wait a few minutes and try again.';
const LINK_LIMITED = 'This link is taking too many payments at once. Wait a minute and try again.';
const TOTAL_EXPIRED = 'This total has expired; start again.';
const IN_PROGRESS = 'A payment is already in progress on this link';
const BEING_CHECKED = 'A payment on this link is being checked';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Counts a request against a fixed window in the store; past the limit the caller is told plainly when to come back. */
export async function enforceLimit(limiter: RateLimiter, key: string, limit: number, windowSeconds: number, message = ADDRESS_LIMITED): Promise<void> {
  const rl = await limiter.hit(key, limit, windowSeconds);
  if (!rl.exceeded) return;
  const retryAfter = String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000)));
  throw new PlatformError('RATE_LIMITED', message, { headers: { 'Retry-After': retryAfter } });
}

/** An E.164 number as people read it: the prefix, then the national number in pairs, an odd leading digit kept with the first pair. */
export function formatMsisdn(msisdn: string, diallingPrefix: string): string {
  const nsn = msisdn.slice(diallingPrefix.length);
  const head = nsn.length % 2 === 1 ? 3 : 2;
  const pairs = nsn.slice(head).match(/.{2}/g) ?? [];
  return [diallingPrefix, nsn.slice(0, head), ...pairs].join(' ');
}

const methodUnavailable = () => new PlatformError('FIELD_INVALID', METHOD_UNAVAILABLE_MESSAGE, { field: 'method' });
const noSuchPayment = () => new PlatformError('NOT_FOUND', 'No such payment.');
/** What the route resolver says of a route, country or entitlement that stopped taking payments: to the payer, the method is gone. */
const METHOD_GONE = new Set(['COUNTRY_DISABLED', 'COUNTRY_UNKNOWN', 'ROUTE_UNAVAILABLE', 'ROUTE_DISABLED', 'ENTITLEMENT_MISSING', 'ENTITLEMENT_DISABLED', 'PAYMENT_METHOD_UNKNOWN']);

/**
 * The project-facing services speak to a project's developers: references, caps, provider figures. The payer sees only what
 * concerns them, in plain words, and never the details.
 */
function forPayer(e: unknown): unknown {
  if (!(e instanceof PlatformError)) return e;
  const neutral = neutralProviderLimit(e);
  if (neutral !== e) return neutral;
  if (METHOD_GONE.has(e.code)) return methodUnavailable();
  switch (e.code) {
    case 'PAYER_IDENTIFIER_INVALID': return new PlatformError(e.code, e.message, { field: 'msisdn' });
    case 'PREVIEW_EXPIRED': return new PlatformError(e.code, TOTAL_EXPIRED);
    case 'SIMILAR_PAYMENT_PENDING': return new PlatformError(e.code, 'A payment from this number is already in progress.');
    case 'VELOCITY_COUNT_EXCEEDED': case 'VELOCITY_VALUE_EXCEEDED': return new PlatformError(e.code, 'This link cannot take more payments right now. Try again later.');
    case 'NO_PROVIDER_AVAILABLE': case 'FLOAT_INSUFFICIENT': return new PlatformError(e.code, 'This payment method is not available right now. Try again later.');
    default: return new PlatformError(e.code, e.message, e.options.field ? { field: e.options.field } : {});
  }
}

export interface LinkPaymentReview {
  amount: number;
  fees_borne_by_payer: number;
  total: number;
  currency: string;
  method: { country: string; name: string };
  msisdn_formatted: string;
  expires_at: string;
}

/**
 * Paying through a link (spec: payment links, paying), in the two steps the page shows: review the total, then confirm.
 * There is no second payment path: the preview, the confirmation, the submission and the ledger are the project API's own.
 *
 * Single use is enforced at confirmation, where money is first asked for. The confirmation runs in one store transaction
 * that locks the link row first and holds it until the new transaction is recorded on the link: a second confirmation on
 * the same link waits on that lock, then sees the first payment and stops. An unconfirmed preview holds nothing.
 */
@Injectable()
export class LinkPaymentsService {
  private readonly logger = log('payment-links');
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly links: PublicLinkService,
    private readonly previews: PreviewService,
    private readonly transactions: TransactionService,
    private readonly submission: SubmissionService,
    private readonly crypto: CryptoService,
    private readonly limiter: RateLimiter,
  ) {}

  /** Prices the payment as a real preview and returns the review the page shows, with the token that follows the payment. */
  async preview(code: string, body: unknown, clientAddress: string): Promise<{ token: string; review: LinkPaymentReview }> {
    await enforceLimit(this.limiter, `paylink:preview:${clientAddress}`, 5, 60);
    const input = (typeof body === 'object' && body !== null ? body : {}) as { method?: unknown; msisdn?: unknown; amount?: unknown };
    const link = await this.links.open(this.db, code);
    const method = typeof input.method === 'string' && isUuid(input.method) ? (await this.links.methods(this.db, link)).find((m) => m.key === input.method) : undefined;
    if (!method) throw methodUnavailable();
    if (typeof input.msisdn !== 'string' || input.msisdn.trim() === '' || input.msisdn.length > 32) throw new PlatformError('FIELD_INVALID', 'Enter the number to pay from.', { field: 'msisdn' });
    // Keyed on the number's blind index, as the platform stores it: the window table never holds a phone number.
    // A number that does not normalise is refused by the preview below, and no request reaches it.
    const number = normaliseMsisdn(input.msisdn, { code: method.country, diallingPrefix: method.diallingPrefix });
    if (number.ok) await enforceLimit(this.limiter, `paylink:preview-number:${this.crypto.blindIndex(number.msisdn).toString('hex')}`, 10, 600, NUMBER_LIMITED);
    const amount = this.links.amountOf(link, input.amount);
    const refusal = amountRefusal(method, amount, link.currency_code, link.exponent);
    // A fixed amount the method no longer takes means the method is gone, as the page already shows it.
    if (refusal) throw link.amount_type === 'fixed' ? methodUnavailable() : refusal;

    let preview;
    try {
      preview = await this.previews.create(linkPrincipal(link), {
        direction: 'collection', amount, currency: link.currency_code, country: method.country, payment_method: method.paymentMethod,
        counterparty: { msisdn: input.msisdn }, reference: `PL-${link.code}-${newLinkPaymentSuffix()}`,
      });
    } catch (e) {
      throw forPayer(e);
    }
    const token = CryptoService.randomToken(32);
    const { id: previewId } = await this.db.selectFrom('preview').select('id').where('reference', '=', preview.reference).executeTakeFirstOrThrow();
    await this.db.insertInto('payment_link_payment').values({
      link_id: link.id, preview_id: previewId, token_hash: CryptoService.tokenHash(token), expires_at: sql<Date>`now() + interval '24 hours'`,
    }).execute();
    return {
      token,
      review: {
        amount: preview.requested_amount, fees_borne_by_payer: subtract(preview.charged_amount, preview.requested_amount), total: preview.charged_amount,
        currency: link.currency_code, method: { country: method.country, name: method.name },
        msisdn_formatted: formatMsisdn(preview.counterparty.msisdn, method.diallingPrefix), expires_at: preview.expires_at,
      },
    };
  }

  /**
   * Confirms the reviewed payment and asks the operator for it. Confirming again returns the same payment. Steps that can
   * refuse run inside one store transaction under the link's lock; the provider is called only once it has committed.
   */
  async confirm(token: string, clientAddress: string): Promise<{ reference: string }> {
    await enforceLimit(this.limiter, `paylink:confirm:${clientAddress}`, 5, 60);
    if (!TOKEN.test(token)) throw noSuchPayment();
    const payment = await this.db.selectFrom('payment_link_payment as pp')
      .innerJoin('preview as pv', 'pv.id', 'pp.preview_id')
      .innerJoin('payment_link as l', 'l.id', 'pp.link_id')
      .select(['pp.id', 'pp.link_id', 'pp.expires_at', 'pv.reference as preview_reference', 'pv.msisdn_index', 'pv.route_id', 'l.code'])
      .where('pp.token_hash', '=', CryptoService.tokenHash(token)).executeTakeFirst();
    if (!payment) throw noSuchPayment();
    // The operator pushes a request to the number here, so this is where the number and the link are limited.
    await enforceLimit(this.limiter, `paylink:confirm-number:${payment.msisdn_index.toString('hex')}`, 3, 600, NUMBER_LIMITED);
    await enforceLimit(this.limiter, `paylink:confirm-link:${payment.link_id}`, 30, 60, LINK_LIMITED);
    if (payment.expires_at.getTime() <= Date.now()) throw new PlatformError('PREVIEW_EXPIRED', TOTAL_EXPIRED);

    const outcome = await this.db.transaction().execute(async (tx) => {
      // Every confirmation on this link queues here until the one ahead has recorded its transaction on the link, or failed.
      await tx.selectFrom('payment_link').select('id').where('id', '=', payment.link_id).forUpdate().executeTakeFirst();
      const done = await tx.selectFrom('payment_link_payment as pp').innerJoin('transaction as t', 't.id', 'pp.transaction_id')
        .select('t.reference').where('pp.id', '=', payment.id).executeTakeFirst();
      if (done) return { reference: done.reference, transactionId: null };

      // Read again under the lock: the link may have been disabled, completed or expired, or its project suspended, meanwhile.
      const link = await this.links.open(tx, payment.code);
      if (link.single_use) {
        // Every payment on the link not yet final (undetermined included), and any success.
        const others = await tx.selectFrom('transaction').select('state').where('payment_link_id', '=', link.id).where('state', 'not in', TERMINAL_STATES.filter((s) => s !== 'succeeded')).execute();
        // A success is final for a single-use link even before anything marks it completed: it never collects twice.
        if (others.some((o) => o.state === 'succeeded')) throw new PlatformError('LINK_UNAVAILABLE', LINK_UNAVAILABLE_MESSAGE);
        if (others.length > 0) throw new PlatformError('CONFLICT', others.every((o) => o.state === 'undetermined') ? BEING_CHECKED : IN_PROGRESS);
      }
      // The method must still be on offer as the page shows it, not merely resolvable.
      if (!(await this.links.methods(tx, link)).some((m) => m.routeId === payment.route_id)) throw methodUnavailable();

      const { transactionId } = await this.transactions.confirmCollectionIn(tx, linkPrincipal(link), payment.preview_reference);
      const txn = await tx.updateTable('transaction').set({ payment_link_id: link.id }).where('id', '=', transactionId).returning('reference').executeTakeFirstOrThrow();
      await tx.updateTable('payment_link_payment').set({ transaction_id: transactionId }).where('id', '=', payment.id).execute();
      return { reference: txn.reference, transactionId };
    }).catch((e: unknown) => { throw forPayer(e); });

    if (outcome.transactionId) {
      // The transaction is committed and its submission queued as a safety net, so a fault here leaves a payment the worker
      // submits within a minute; the payer follows it by the token either way.
      try {
        await this.submission.submit(outcome.transactionId);
      } catch (e) {
        this.logger.error({ err: e, transaction: outcome.reference }, 'link payment submission failed; the queued submission will retry');
      }
    }
    return { reference: outcome.reference };
  }
}
