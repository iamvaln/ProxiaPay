import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { newLinkPaymentSuffix } from '../crypto/references';
import { CONFIG, type AppConfig } from '../config/config';
import { DB_TOKEN, type Db } from '../db/database';
import { log } from '../logging/logger';
import { Mailer } from '../alerts/mailer';
import { subtract } from '../money/money';
import { normaliseMsisdn } from '../msisdn/msisdn';
import { RateLimiter } from '../project-auth/rate-limiter';
import { SubmissionService } from '../providers/submission.service';
import { PreviewService } from '../transactions/preview.service';
import { TERMINAL_STATES, TransactionService } from '../transactions/transaction.service';
import { failureText, payerLanguage, type PayerLanguage } from './failure-text';
import { maskEmail, receiptMail, receiptSender } from './receipt';
import { amountRefusal, isUuid, LINK_UNAVAILABLE_MESSAGE, linkPrincipal, METHOD_UNAVAILABLE_MESSAGE, neutralProviderLimit, PublicLinkService } from './public-view';

export const ADDRESS_LIMITED = 'Too many requests from this connection. Wait a minute and try again.';
const NUMBER_LIMITED = 'Too many payment requests to this number. Wait a few minutes and try again.';
const LINK_LIMITED = 'This link is taking too many payments at once. Wait a minute and try again.';
const TOTAL_EXPIRED = 'This total has expired; start again.';
const IN_PROGRESS = 'A payment is already in progress on this link';
const BEING_CHECKED = 'A payment on this link is being checked';
const PAYMENT_GONE = 'This payment is no longer available';
const NOT_STARTED = 'We could not start this payment. Please try again.';
const RECEIPTS_PER_PAYMENT = 3;
/**
 * Previews and confirmations per address a minute. Generous because many payers share one address behind a carrier's NAT;
 * the limits per number and per link are what bound abuse.
 */
const PER_ADDRESS = 20;
const EMAIL = /^[^\s@<>",;]{1,64}@[^\s@<>",;]+\.[^\s@<>",;]+$/;
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
    // Anything else was written for a developer (field paths, references, rules): the payer hears only that it did not start.
    default: return new PlatformError(e.code, NOT_STARTED);
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

/** A payment as the page follows it once confirmed: its state, how to approve it, and in the end its outcome in plain words. */
export interface FollowedPayment {
  state: string;
  reference: string;
  amount: number;
  charged_amount: number;
  currency: string;
  method: { country: string; name: string };
  /** The route's own instructions in the page's language, or null for the page's generic text. */
  instructions: string | null;
  /** Null until the payment is final; a failure carries why, in the payer's words. */
  outcome: { failure_reason_text: string | null } | null;
  /**
   * What the receipt shows, read from the payment itself so a reload keeps it once the link is gone (a single-use link
   * completes on success): the project's face, the link's title, the masked number, and when the payment became final.
   */
  project_name: string;
  title: string;
  exponent: number;
  sandbox: boolean;
  msisdn_masked: string;
  completed_at: string | null;
  brand: { logo_url: string | null; primary_color: string };
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
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'PROXIAPAY_ENV'>,
    private readonly links: PublicLinkService,
    private readonly previews: PreviewService,
    private readonly transactions: TransactionService,
    private readonly submission: SubmissionService,
    private readonly crypto: CryptoService,
    private readonly limiter: RateLimiter,
    private readonly mailer: Mailer,
  ) {}

  /** Prices the payment as a real preview and returns the review the page shows, with the token that follows the payment. */
  async preview(code: string, body: unknown, clientAddress: string): Promise<{ token: string; review: LinkPaymentReview }> {
    await enforceLimit(this.limiter, `paylink:preview:${clientAddress}`, PER_ADDRESS, 60);
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
    const payment = TOKEN.test(token)
      ? await this.db.selectFrom('payment_link_payment as pp')
        .innerJoin('preview as pv', 'pv.id', 'pp.preview_id')
        .innerJoin('payment_link as l', 'l.id', 'pp.link_id')
        .leftJoin('transaction as t', 't.id', 'pp.transaction_id')
        .select(['pp.id', 'pp.link_id', 'pp.expires_at', 'pv.reference as preview_reference', 'pv.msisdn_index', 'pv.route_id', 'l.code', 't.reference as transaction_reference'])
        .where('pp.token_hash', '=', CryptoService.tokenHash(token)).executeTakeFirst()
      : undefined;
    // A repeat of a confirmed payment answers before every limit: it asks the operator for nothing, so it spends no budget,
    // and a payer retrying after a lost answer is never refused the payment they already made.
    if (payment?.transaction_reference) return { reference: payment.transaction_reference };
    // Anything else is charged to the address, an unknown token included: that is what bounds guessing at tokens.
    await enforceLimit(this.limiter, `paylink:confirm:${clientAddress}`, PER_ADDRESS, 60);
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
        if (others.length > 0) {
          throw others.every((o) => o.state === 'undetermined') ? new PlatformError('LINK_PAYMENT_BEING_CHECKED', BEING_CHECKED) : new PlatformError('LINK_PAYMENT_IN_PROGRESS', IN_PROGRESS);
        }
      }
      // The method must still be on offer as the page shows it, not merely resolvable.
      if (!(await this.links.methods(tx, link)).some((m) => m.routeId === payment.route_id)) throw methodUnavailable();

      // The project-facing confirmation speaks to developers; only its refusals are put in the payer's words.
      const { transactionId } = await this.transactions.confirmCollectionIn(tx, linkPrincipal(link), payment.preview_reference).catch((e: unknown) => { throw forPayer(e); });
      const txn = await tx.updateTable('transaction').set({ payment_link_id: link.id }).where('id', '=', transactionId).returning('reference').executeTakeFirstOrThrow();
      await tx.updateTable('payment_link_payment').set({ transaction_id: transactionId }).where('id', '=', payment.id).execute();
      return { reference: txn.reference, transactionId };
    });

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

  /**
   * The payment as the page follows it after confirming. The payer types nothing more: the state moves when the provider's
   * callback or the status checks settle the transaction, and the page polls this until the outcome is in. The token is
   * what the page holds, so an unknown, unconfirmed or past-its-day token all answer the same.
   */
  async follow(token: string, lang: unknown): Promise<FollowedPayment> {
    const gone = () => new PlatformError('NOT_FOUND', PAYMENT_GONE);
    if (!TOKEN.test(token)) throw gone();
    const hash = CryptoService.tokenHash(token);
    const row = await this.db.selectFrom('payment_link_payment as pp')
      .innerJoin('transaction as t', 't.id', 'pp.transaction_id')
      .innerJoin('route as r', 'r.id', 't.route_id')
      .innerJoin('payment_method as pm', 'pm.code', 'r.payment_method_code')
      .innerJoin('payment_link as l', 'l.id', 'pp.link_id')
      .innerJoin('project as p', 'p.id', 'l.project_id')
      .innerJoin('currency as c', 'c.code', 't.currency_code')
      .select(['t.state', 't.reference', 't.requested_amount', 't.charged_amount', 't.currency_code', 't.failure_reason', 't.msisdn_masked', 't.terminal_at', 't.updated_at',
        'r.country_code', 'pm.name', 'r.payer_instructions', 'l.title', 'l.logo_asset_id', 'l.primary_color', 'p.name as project_name', 'c.exponent'])
      .where('pp.token_hash', '=', hash).where('pp.expires_at', '>', sql<Date>`now()`).executeTakeFirst();
    if (!row) throw gone();
    // Charged only for a token that exists, so a guess writes nothing; the controller's per-address ceiling covers the guessing.
    // Keyed on the token's hash: the window table never holds a token.
    await enforceLimit(this.limiter, `paylink:payment:${hash.toString('hex')}`, 60, 60);
    const language = payerLanguage(lang);
    const given = (row.payer_instructions as Partial<Record<PayerLanguage, unknown>> | null)?.[language];
    const final = (TERMINAL_STATES as readonly string[]).includes(row.state);
    return {
      state: row.state, reference: row.reference, amount: row.requested_amount, charged_amount: row.charged_amount, currency: row.currency_code,
      method: { country: row.country_code, name: row.name },
      instructions: typeof given === 'string' && given.trim() !== '' ? given : null,
      outcome: final ? { failure_reason_text: row.state === 'succeeded' ? null : failureText(row.failure_reason, language) } : null,
      project_name: row.project_name, title: row.title, exponent: row.exponent, sandbox: this.config.PROXIAPAY_ENV === 'sandbox',
      msisdn_masked: row.msisdn_masked, completed_at: final ? (row.terminal_at ?? row.updated_at).toISOString() : null,
      brand: { logo_url: row.logo_asset_id ? `/pay-api/v1/assets/${row.logo_asset_id}` : null, primary_color: row.primary_color },
    };
  }

  /**
   * Sends the receipt of a succeeded payment to an address the payer types. The address is used for this send and kept nowhere:
   * the payment records only how many receipts went out, when, and the masked form. The send is counted before it is made, so
   * concurrent requests cannot pass the limit of three; the answer says whether the mailer took it.
   */
  async sendReceipt(token: string, body: unknown): Promise<{ status: 'sent' | 'failed' }> {
    const gone = () => new PlatformError('NOT_FOUND', PAYMENT_GONE);
    if (!TOKEN.test(token)) throw gone();
    const input = (typeof body === 'object' && body !== null ? body : {}) as { email?: unknown; language?: unknown };
    const hash = CryptoService.tokenHash(token);
    const row = await this.db.selectFrom('payment_link_payment as pp')
      .innerJoin('transaction as t', 't.id', 'pp.transaction_id')
      .innerJoin('payment_link as l', 'l.id', 'pp.link_id')
      .innerJoin('project as pr', 'pr.id', 'l.project_id')
      .innerJoin('currency as c', 'c.code', 't.currency_code')
      .innerJoin('route as r', 'r.id', 't.route_id')
      .innerJoin('payment_method as pm', 'pm.code', 'r.payment_method_code')
      .select(['pp.id', 't.state', 't.reference', 't.requested_amount', 't.charged_amount', 't.currency_code', 't.msisdn_masked', 't.terminal_at', 't.updated_at', 'c.exponent', 'l.title', 'pr.name as project_name', 'pm.name as method_name', 'r.country_code'])
      .where('pp.token_hash', '=', hash).where('pp.expires_at', '>', sql<Date>`now()`).executeTakeFirst();
    if (!row) throw gone();
    await enforceLimit(this.limiter, `paylink:receipt:${hash.toString('hex')}`, 60, 60);
    if (typeof input.email !== 'string' || input.email.length > 254 || !EMAIL.test(input.email.trim())) throw new PlatformError('FIELD_INVALID', 'Enter a valid email address.', { field: 'email' });
    if (input.language !== undefined && input.language !== 'en' && input.language !== 'fr') throw new PlatformError('FIELD_INVALID', 'language: must be en or fr.', { field: 'language' });
    if (row.state !== 'succeeded') throw new PlatformError('RECEIPT_NOT_READY', 'A receipt is available once the payment has succeeded.');
    const reserved = await this.db.updateTable('payment_link_payment').set({ receipts_sent: sql<number>`receipts_sent + 1` })
      .where('id', '=', row.id).where('receipts_sent', '<', RECEIPTS_PER_PAYMENT).returning('id').executeTakeFirst();
    if (!reserved) throw new PlatformError('RECEIPT_LIMIT_REACHED', 'The receipt has already been sent three times.');

    const email = input.email.trim();
    const masked = maskEmail(email);
    const mail = receiptMail({
      projectName: row.project_name, title: row.title, reference: row.reference, paidAt: row.terminal_at ?? row.updated_at, country: row.country_code,
      amount: row.requested_amount, fees: subtract(row.charged_amount, row.requested_amount), total: row.charged_amount, exponent: row.exponent,
      currency: row.currency_code, method: row.method_name, maskedNumber: row.msisdn_masked,
    }, input.language === 'fr' ? 'fr' : 'en');
    try {
      await this.mailer.send({ to: email, ...mail, fromName: receiptSender(row.project_name), recipientLabel: masked });
    } catch (e) {
      // Neither the address nor the mailer's detail (which may repeat it) is logged.
      this.logger.warn({ transaction: row.reference, err: (e as Error).name }, 'receipt email could not be sent');
      return { status: 'failed' };
    }
    try {
      await this.db.updateTable('payment_link_payment').set({ receipt_sent_at: sql<Date>`now()`, receipt_sent_to: masked }).where('id', '=', row.id).execute();
    } catch (e) {
      // The mail went out: the payer is told so. Only the record of when and to whom is missing.
      this.logger.warn({ transaction: row.reference, err: (e as Error).name }, 'receipt sent but not recorded');
    }
    return { status: 'sent' };
  }
}
