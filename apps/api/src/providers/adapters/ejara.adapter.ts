import type { FailureReason } from '../../common/errors';
import { CryptoService } from '../../crypto/crypto.service';
import {
  fetchJson, ProviderUnavailableError, type AdapterCapabilities, type AdapterContext, type InboundEvent, type NormalisedState, type ProviderAdapter,
  type StatusResult, type SubmitRequest, type SubmitResult, type WalletBalance,
} from '../adapter';
import { log } from '../../logging/logger';
import { fromMajorUnits, toMajorUnits } from '../../money/money';

interface EjaraResponse { status?: string; code?: string; message?: string; data?: Record<string, unknown> }

/**
 * Ejara Pay (spec 12). Authentication exchanges client-key and client-secret headers for a
 * bearer token valid one hour; tokens are concurrent, so each instance caches its own and
 * renews ahead of expiry. One endpoint initiates both directions; status is read by the
 * provider's payment reference. Every error with no mapping becomes PROVIDER_REJECTED with the
 * provider's own code preserved on the attempt.
 */
export class EjaraAdapter implements ProviderAdapter {
  readonly key = 'ejara';
  private readonly logger = log('ejara');
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  capabilities(): AdapterCapabilities {
    return { supportsTransfers: false, supportsListing: false, hasTestEnvironment: false, tokenModel: 'concurrent', statementFormat: 'ejara_csv_v1', supportsCodeSubmission: false };
  }

  private async token(ctx: AdapterContext): Promise<string> {
    const cached = this.tokens.get(ctx.account.id);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const res = await fetchJson(`${ctx.account.baseUrl}/api/v1/accounts/authenticate`, {
      method: 'POST',
      headers: { 'client-key': ctx.account.credentials.clientKey ?? '', 'client-secret': ctx.account.credentials.clientSecret ?? '', 'content-type': 'application/json', accept: 'application/json' },
    });
    if (res.timedOut) throw new ProviderUnavailableError('ejara: authentication timed out');
    const body = res.body as { data?: { accessToken?: string; expiresIn?: number } };
    const token = body?.data?.accessToken;
    if (res.status !== 200 || !token) throw new ProviderUnavailableError(`ejara: authentication failed (${res.status})`);
    this.tokens.set(ctx.account.id, { token, expiresAt: Date.now() + (body.data?.expiresIn ?? 3600) * 1000 });
    return token;
  }

  private headers(ctx: AdapterContext, token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'client-key': ctx.account.credentials.clientKey ?? '',
      'client-secret': ctx.account.credentials.clientSecret ?? '',
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  async submit(ctx: AdapterContext, req: SubmitRequest): Promise<SubmitResult> {
    const token = await this.token(ctx);
    const payload = {
      phoneNumber: req.msisdn.replace(/^\+/, ''),
      transactionType: req.direction === 'collection' ? 'payin' : 'payout',
      amount: toProviderAmount(req.amount, req.currencyExponent),
      fullName: req.counterpartyName ?? 'Customer',
      emailAddress: req.counterpartyEmail ?? 'noreply@proxia-digital.com',
      currencyCode: req.currency,
      countryCode: req.country,
      paymentMode: req.paymentMethod,
      externalReference: req.transactionReference,
    };
    const requestPayloadId = await ctx.recordPayload('outbound_request', 'initiate-momo-payment', { ...payload, phoneNumber: '[redacted]' });
    const res = await fetchJson(`${ctx.account.baseUrl}/api/v1/transactions/initiate-momo-payment`, { method: 'POST', headers: this.headers(ctx, token), body: JSON.stringify(payload) });
    if (res.timedOut) return { outcome: 'undetermined', payloadId: requestPayloadId };
    const body = res.body as EjaraResponse;
    const payloadId = await ctx.recordPayload('outbound_response', 'initiate-momo-payment', { http_status: res.status, body });
    if (res.status === 401 || res.status === 403 || body?.code === 'INVALID_API_CLIENT' || body?.code === 'INCOMPLETE_REQUEST_HEADERS') {
      this.tokens.delete(ctx.account.id);
      throw new ProviderUnavailableError(`ejara: authentication rejected (${body?.code ?? res.status})`);
    }
    if (res.status >= 500) throw new ProviderUnavailableError(`ejara: server error ${res.status}`);
    const data = body?.data ?? {};
    const providerReference = String(data.paymentReference ?? data.reference ?? data.id ?? '');
    if (res.status >= 200 && res.status < 300 && providerReference) {
      const state = String(data.status ?? 'pending').toLowerCase();
      if (state === 'rejected') return { outcome: 'rejected', reason: mapFailure(body), providerCode: body.code, providerMessage: body.message, payloadId };
      return { outcome: 'accepted', providerReference, state: 'processing', payloadId };
    }
    if (body?.code === 'INSUFFICIENT_FUNDS') return { outcome: 'rejected', reason: 'PROVIDER_REJECTED', providerCode: 'INSUFFICIENT_FUNDS', providerMessage: 'merchant float insufficient', payloadId };
    return { outcome: 'rejected', reason: mapFailure(body), providerCode: body?.code ?? String(res.status), providerMessage: body?.message ?? 'provider refused the request', payloadId };
  }

  async status(ctx: AdapterContext, providerReference: string): Promise<StatusResult> {
    const token = await this.token(ctx);
    const res = await fetchJson(`${ctx.account.baseUrl}/api/v1/transactions/${encodeURIComponent(providerReference)}`, { headers: this.headers(ctx, token) });
    if (res.timedOut) throw new ProviderUnavailableError('ejara: status timed out');
    const body = res.body as EjaraResponse;
    const payloadId = await ctx.recordPayload('outbound_response', 'status', { http_status: res.status, body });
    if (res.status === 401 || res.status === 403) { this.tokens.delete(ctx.account.id); throw new ProviderUnavailableError('ejara: authentication rejected on status'); }
    if (res.status === 404 || body?.code === 'RESOURCE_NOT_FOUND') return { state: 'unknown', providerCode: 'RESOURCE_NOT_FOUND', payloadId };
    if (res.status >= 500) throw new ProviderUnavailableError(`ejara: server error ${res.status}`);
    const data = body?.data ?? {};
    const state = mapState(String(data.status ?? ''));
    const exponent = 0; // confirmed per spec 18 once a two-decimal route has run; the documented examples carry none.
    const result: StatusResult = {
      state,
      requestedAmount: data.rawAmount != null ? fromProviderAmount(data.rawAmount, exponent) : undefined,
      chargedAmount: data.amount != null ? fromProviderAmount(data.amount, exponent) : undefined,
      providerFee: data.fees != null ? fromProviderAmount(data.fees, exponent) : undefined,
      operatorReference: firstString(data, ['operatorReference', 'operatorTransactionId', 'providerReference', 'financialTransactionId']),
      providerCode: body?.code,
      providerMessage: body?.message,
      payloadId,
    };
    if (state === 'failed') result.failureReason = mapFailure(body, data);
    return result;
  }

  async parseNotification(_ctx: AdapterContext, _headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<InboundEvent | null> {
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as { event?: string; data?: Record<string, unknown> };
      const data = body.data ?? {};
      const providerReference = firstString(data, ['paymentReference', 'reference', 'id']);
      if (!providerReference || !body.event) return null;
      return { providerReference, externalReference: firstString(data, ['externalReference']), eventKey: body.event, asserts: body.event.endsWith('.confirmed') ? 'succeeded' : body.event.endsWith('.rejected') ? 'failed' : undefined };
    } catch {
      return null;
    }
  }

  async wallets(ctx: AdapterContext): Promise<WalletBalance[]> {
    const token = await this.token(ctx);
    const out: WalletBalance[] = [];
    for (const serviceType of ['collection', 'disbursement'] as const) {
      const res = await fetchJson(`${ctx.account.baseUrl}/api/v1/accounts/wallets?serviceType=${serviceType}&status=active`, { headers: this.headers(ctx, token) });
      if (res.timedOut) throw new ProviderUnavailableError('ejara: wallets timed out');
      const body = res.body as { data?: unknown };
      await ctx.recordPayload('outbound_response', 'wallets', { http_status: res.status, body });
      // Observed against the test box: the page sits inside the envelope, as
      // { data: { totalCount, data: [...], count } }. The flat form is kept as a fallback.
      const page = body?.data as { data?: unknown } | undefined;
      const list = Array.isArray(page?.data) ? page.data as Record<string, unknown>[]
        : Array.isArray(body?.data) ? body.data as Record<string, unknown>[]
        : [];
      for (const w of list) {
        // Observed: country and currency arrive as objects, not codes —
        // { shortCode: 'CM', name: 'Cameroon' } and { isoCode: 'XAF' }.
        const country = firstString(w, ['countryCode', 'country']) ?? nestedString(w.country, ['shortCode', 'code', 'isoCode']);
        const currency = firstString(w, ['currencyCode', 'currency']) ?? nestedString(w.currency, ['isoCode', 'code']);
        const balance = w.balance ?? w.availableBalance;
        if (!country || !currency || balance == null) continue;
        out.push({ country, currency, direction: serviceType, balance: fromProviderAmount(balance, 0), providerWalletId: firstString(w, ['id', 'walletId']) });
      }
    }
    return out;
  }
}

function mapState(status: string): NormalisedState {
  switch (status.toLowerCase()) {
    case 'confirmed': case 'success': case 'successful': return 'succeeded';
    case 'rejected': case 'failed': return 'failed';
    case 'pending': case 'processing': case 'initiated': return 'processing';
    default: return 'unknown';
  }
}

function mapFailure(body: EjaraResponse | undefined, data: Record<string, unknown> = {}): FailureReason {
  const code = String(body?.code ?? data.failureReason ?? data.reason ?? '').toUpperCase();
  const message = String(body?.message ?? data.message ?? '').toLowerCase();
  if (code.includes('INSUFFICIENT') && !code.includes('FUNDS')) return 'WALLET_BALANCE_INSUFFICIENT';
  if (message.includes('insufficient balance') || message.includes('insufficient funds in wallet')) return 'WALLET_BALANCE_INSUFFICIENT';
  if (code.includes('DECLINED') || message.includes('declined') || message.includes('cancelled by')) return 'PAYER_DECLINED';
  if (code.includes('TIMEOUT') || message.includes('timed out') || message.includes('not responded')) return 'PAYER_UNRESPONSIVE';
  if (code.includes('NOT_FOUND') && (message.includes('wallet') || message.includes('account'))) return 'WALLET_NOT_FOUND';
  if (message.includes('limit')) return 'WALLET_LIMIT_EXCEEDED';
  if (message.includes('inactive') || message.includes('blocked')) return 'WALLET_INACTIVE';
  return 'PROVIDER_REJECTED';
}

/** Reads a code out of a nested object the provider sends in place of a plain string. */
function nestedString(value: unknown, keys: string[]): string | undefined {
  return value && typeof value === 'object' ? firstString(value as Record<string, unknown>, keys) : undefined;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** The provider is assumed to speak in major units for currencies with no decimals; see spec 18 for the open point on CDF and USD. */
const toProviderAmount = toMajorUnits;
const fromProviderAmount = fromMajorUnits;

export const _internal = { mapState, mapFailure, toProviderAmount, fromProviderAmount, hash: CryptoService.sha256Hex };
