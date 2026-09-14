import type { FailureReason } from '../common/errors';
import type { Direction } from '../money/money';

/** The internal contract every provider presents (spec 11). */
export interface AdapterCapabilities {
  supportsTransfers: boolean;
  supportsListing: boolean;
  hasTestEnvironment: boolean;
  /** Whether several access tokens may be valid at once (per-instance caching) or only one (shared under a lock). */
  tokenModel: 'concurrent' | 'single';
  statementFormat?: string;
  supportsCodeSubmission: boolean;
}

export interface AdapterAccount {
  id: string;
  baseUrl: string;
  credentials: Record<string, string>;
}

export interface AdapterContext {
  account: AdapterAccount;
  correlationId: string;
  transactionId?: string;
  /** Records a raw exchange for investigation, retained per spec 14.3. Returns the payload id. */
  recordPayload(flow: 'outbound_request' | 'outbound_response' | 'inbound_notification', kind: string, body: unknown): Promise<string>;
}

export interface SubmitRequest {
  transactionReference: string;
  direction: Direction;
  amount: number;
  currency: string;
  currencyExponent: number;
  country: string;
  paymentMethod: string;
  msisdn: string;
  counterpartyName?: string | null;
  counterpartyEmail?: string | null;
}

export type NormalisedState = 'processing' | 'action_required' | 'succeeded' | 'failed' | 'unknown';

export interface PayerAction { type: 'code' | 'browser'; url?: string; expiresAt?: Date }

export type SubmitResult =
  | { outcome: 'accepted'; providerReference: string; state: 'processing' | 'action_required'; action?: PayerAction; payloadId?: string }
  | { outcome: 'rejected'; reason: FailureReason; providerCode?: string; providerMessage?: string; payloadId?: string }
  | { outcome: 'undetermined'; payloadId?: string; providerReference?: string };

export interface StatusResult {
  state: NormalisedState;
  failureReason?: FailureReason;
  requestedAmount?: number;
  chargedAmount?: number;
  providerFee?: number;
  operatorReference?: string;
  providerCode?: string;
  providerMessage?: string;
  payloadId?: string;
}

export interface InboundEvent {
  providerReference: string;
  /** Our own transaction reference where the provider echoes it. */
  externalReference?: string;
  eventKey: string;
  asserts?: NormalisedState;
}

export interface WalletBalance { country: string; currency: string; direction: Direction; balance: number; providerWalletId?: string }

export interface ProviderTransactionRecord {
  providerReference: string;
  externalReference?: string;
  direction: Direction;
  amount: number;
  fee: number;
  currency: string;
  state: NormalisedState;
  occurredAt: Date;
}

/** Raised when the provider could not be reached or refused authentication; fallback applies. */
export class ProviderUnavailableError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export interface ProviderAdapter {
  readonly key: string;
  capabilities(): AdapterCapabilities;
  submit(ctx: AdapterContext, req: SubmitRequest): Promise<SubmitResult>;
  status(ctx: AdapterContext, providerReference: string): Promise<StatusResult>;
  parseNotification(ctx: AdapterContext, headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<InboundEvent | null>;
  wallets(ctx: AdapterContext): Promise<WalletBalance[]>;
  listTransactions?(ctx: AdapterContext, period: { start: Date; end: Date }): Promise<ProviderTransactionRecord[]>;
  submitCode?(ctx: AdapterContext, providerReference: string, code: string): Promise<StatusResult>;
}

/** Provider calls carry a connection timeout of 5 seconds and a read timeout of 30 (spec 14.2). */
export const PROVIDER_TIMEOUT_MS = 30_000;

export async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: unknown; timedOut: false } | { timedOut: true }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: res.status, body, timedOut: false };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { timedOut: true };
    throw new ProviderUnavailableError(`request to ${new URL(url).host} failed: ${(e as Error).message}`, e);
  } finally {
    clearTimeout(timer);
  }
}
