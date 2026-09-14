import { randomBytes } from 'node:crypto';
import { computeFee, sum } from '../../money/money';
import {
  ProviderUnavailableError, type AdapterCapabilities, type AdapterContext, type InboundEvent, type ProviderAdapter, type ProviderTransactionRecord,
  type StatusResult, type SubmitRequest, type SubmitResult, type WalletBalance,
} from '../adapter';

/**
 * Stands in for a provider in the sandbox and in verification (spec 11, 15.8). Behaviour is
 * chosen by the last two digits of the counterparty number, so a project can exercise every
 * outcome deliberately, and the provider reference carries everything a later status call needs,
 * so the simulator holds no state and works across processes.
 *
 *   …00  rejected at submission (WALLET_NOT_FOUND)
 *   …01  accepted, then fails (PAYER_DECLINED)
 *   …02  accepted, stays processing until the sweep ceiling (undetermined)
 *   …03  provider unreachable (fallback applies)
 *   …04  submission times out (undetermined)
 *   …05  accepted, wallet balance insufficient
 *   …06  accepted, requires a one-time code; the code is 123456
 *   …07  accepted, requires a browser step
 *   else accepted, succeeds after a few seconds at a 2 percent provider fee
 */
export class SimulatorAdapter implements ProviderAdapter {
  readonly key = 'simulator';
  /** Wallet balances the simulator reports, settable by tests and by the sandbox seed. */
  static wallets: WalletBalance[] = [];
  static listed: ProviderTransactionRecord[] = [];
  static settleAfterMs = 2000;

  capabilities(): AdapterCapabilities {
    return { supportsTransfers: false, supportsListing: false, hasTestEnvironment: true, tokenModel: 'concurrent', statementFormat: 'ejara_csv_v1', supportsCodeSubmission: true };
  }

  async submit(ctx: AdapterContext, req: SubmitRequest): Promise<SubmitResult> {
    const tail = req.msisdn.slice(-2);
    const requestPayloadId = await ctx.recordPayload('outbound_request', 'initiate', { ...req, msisdn: '[redacted]' });
    if (tail === '03') throw new ProviderUnavailableError('simulator: provider unreachable');
    if (tail === '04') return { outcome: 'undetermined', payloadId: requestPayloadId };
    if (tail === '00') {
      const payloadId = await ctx.recordPayload('outbound_response', 'initiate', { status: 'rejected', code: 'WALLET_NOT_FOUND' });
      return { outcome: 'rejected', reason: 'WALLET_NOT_FOUND', providerCode: 'WALLET_NOT_FOUND', providerMessage: 'no wallet for number', payloadId };
    }
    const behaviour = { '01': 'decline', '02': 'hang', '05': 'nofunds', '06': 'code', '07': 'browser' }[tail] ?? 'ok';
    const ref = `SIM-${behaviour}-${req.direction[0]}-${req.amount}-${req.currency}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const payloadId = await ctx.recordPayload('outbound_response', 'initiate', { status: 'pending', paymentReference: ref });
    if (behaviour === 'code') return { outcome: 'accepted', providerReference: ref, state: 'action_required', action: { type: 'code' }, payloadId };
    if (behaviour === 'browser') return { outcome: 'accepted', providerReference: ref, state: 'action_required', action: { type: 'browser', url: `https://simulator.invalid/pay/${ref}` }, payloadId };
    return { outcome: 'accepted', providerReference: ref, state: 'processing', payloadId };
  }

  async status(ctx: AdapterContext, providerReference: string): Promise<StatusResult> {
    const parsed = parse(providerReference);
    if (!parsed) return { state: 'unknown', providerCode: 'RESOURCE_NOT_FOUND' };
    const elapsed = Date.now() - parsed.createdAt;
    const settled = elapsed >= SimulatorAdapter.settleAfterMs;
    const fee = computeFee(parsed.amount, { bps: 200, fixed: 0 }).amount;
    let result: StatusResult;
    switch (parsed.behaviour) {
      case 'decline': result = settled ? { state: 'failed', failureReason: 'PAYER_DECLINED', providerCode: 'REJECTED' } : { state: 'processing' }; break;
      case 'nofunds': result = settled ? { state: 'failed', failureReason: 'WALLET_BALANCE_INSUFFICIENT', providerCode: 'INSUFFICIENT_BALANCE' } : { state: 'processing' }; break;
      case 'hang': result = { state: 'processing' }; break;
      case 'code': case 'browser': result = providerReference.endsWith('#confirmed') || parsed.confirmed
        ? { state: 'succeeded', requestedAmount: parsed.amount, chargedAmount: sum(parsed.amount, fee), providerFee: fee, operatorReference: `MP${parsed.createdAt.toString(36).toUpperCase()}` }
        : { state: 'action_required' }; break;
      default: result = settled
        ? { state: 'succeeded', requestedAmount: parsed.amount, chargedAmount: sum(parsed.amount, fee), providerFee: fee, operatorReference: `MP${parsed.createdAt.toString(36).toUpperCase()}` }
        : { state: 'processing' };
    }
    result.payloadId = await ctx.recordPayload('outbound_response', 'status', { paymentReference: providerReference, ...result });
    return result;
  }

  async submitCode(ctx: AdapterContext, providerReference: string, code: string): Promise<StatusResult> {
    const parsed = parse(providerReference);
    if (!parsed || parsed.behaviour !== 'code') return { state: 'unknown' };
    if (code !== '123456') return { state: 'action_required', providerCode: 'INVALID_OTP' };
    const fee = computeFee(parsed.amount, { bps: 200, fixed: 0 }).amount;
    const r: StatusResult = { state: 'succeeded', requestedAmount: parsed.amount, chargedAmount: sum(parsed.amount, fee), providerFee: fee, operatorReference: `MP${parsed.createdAt.toString(36).toUpperCase()}` };
    r.payloadId = await ctx.recordPayload('outbound_response', 'otp', { paymentReference: providerReference, status: 'confirmed' });
    return r;
  }

  /** Inbound notifications name our reference; the platform verifies by status check regardless. */
  async parseNotification(_ctx: AdapterContext, _headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<InboundEvent | null> {
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as { event?: string; paymentReference?: string; externalReference?: string };
      if (!body.paymentReference || !body.event) return null;
      return { providerReference: body.paymentReference, externalReference: body.externalReference, eventKey: body.event };
    } catch {
      return null;
    }
  }

  async wallets(): Promise<WalletBalance[]> {
    return SimulatorAdapter.wallets;
  }

  async listTransactions(_ctx: AdapterContext, period: { start: Date; end: Date }): Promise<ProviderTransactionRecord[]> {
    return SimulatorAdapter.listed.filter((t) => t.occurredAt >= period.start && t.occurredAt <= period.end);
  }
}

function parse(ref: string): { behaviour: string; amount: number; createdAt: number; confirmed: boolean } | null {
  const m = /^SIM-(\w+)-[cd]-(\d+)-[A-Z]{3}-(\d+)-[0-9a-f]{8}(#confirmed)?$/.exec(ref);
  if (!m) return null;
  return { behaviour: m[1]!, amount: Number(m[2]), createdAt: Number(m[3]), confirmed: m[4] != null };
}
