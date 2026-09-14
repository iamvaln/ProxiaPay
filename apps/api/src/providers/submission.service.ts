import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { FailureReason } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { dbNow, DB_TOKEN, type Db } from '../db/database';
import { log } from '../logging/logger';
import { RouteResolver } from '../routes/route-resolver';
import { SettingsService } from '../settings/settings.service';
import { TransactionService } from '../transactions/transaction.service';
import { ProviderUnavailableError, type SubmitResult } from './adapter';
import { CircuitBreaker } from './circuit-breaker';
import { ProviderAccountService } from './provider-account.service';

/**
 * Sends a created transaction to a provider (spec 5.2–5.4). The request is recorded as sent
 * before the call and its outcome after, in separate transactions, so a process dying between
 * the two leaves a transaction that the sweep moves to undetermined rather than one that was
 * never sent. Fallback proceeds only where the platform knows no money moved.
 */
@Injectable()
export class SubmissionService {
  private readonly logger = log('submission');
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly transactions: TransactionService,
    private readonly resolver: RouteResolver,
    private readonly accounts: ProviderAccountService,
    private readonly breaker: CircuitBreaker,
    private readonly settings: SettingsService,
    private readonly crypto: CryptoService,
  ) {}

  async submit(transactionId: string): Promise<void> {
    for (let hop = 0; hop < 5; hop++) {
      const prepared = await this.prepareAttempt(transactionId);
      if (!prepared) return;
      const { attempt, txn, req, ctx, adapterKey } = prepared;
      const adapter = this.accounts.adapter(adapterKey);
      let result: SubmitResult | 'unavailable';
      let unavailableMessage = '';
      try {
        result = await adapter.submit(ctx, req);
      } catch (e) {
        if (!(e instanceof ProviderUnavailableError)) throw e;
        result = 'unavailable';
        unavailableMessage = e.message;
        this.logger.warn({ transaction: txn.reference, provider_account: attempt.provider_account_id, err: e.message }, 'provider unavailable');
      }
      const continueFallback = await this.recordOutcome(transactionId, attempt.id, attempt.provider_account_id, result, unavailableMessage);
      if (!continueFallback) return;
    }
  }

  private async prepareAttempt(transactionId: string) {
    return this.db.transaction().execute(async (tx) => {
      const txn = await this.transactions.lock(tx, transactionId);
      if (txn.state !== 'created') return null;
      const tried = (await tx.selectFrom('transaction_attempt').select('provider_account_id').where('transaction_id', '=', txn.id).execute()).map((a) => a.provider_account_id);
      const candidates = (await this.resolver.availableBindings(tx, txn.route_version_id, txn.requested_amount)).filter((b) => !tried.includes(b.provider_account_id));
      // Preferred: the binding selected at confirmation; then fallback order.
      const ordered = [...candidates.filter((b) => b.id === txn.binding_id), ...candidates.filter((b) => b.id !== txn.binding_id)];
      let binding = ordered[0];
      // A breaker that is open may admit one probe per interval.
      if (!binding) {
        const all = await tx.selectFrom('route_binding as b').innerJoin('circuit_breaker as cb', 'cb.provider_account_id', 'b.provider_account_id').innerJoin('provider_account as pa', 'pa.id', 'b.provider_account_id').innerJoin('provider as p', 'p.code', 'pa.provider_code')
          .selectAll('b').select(['p.code as provider_code', 'p.adapter_key', 'pa.status as account_status', 'cb.state as breaker_state'])
          .where('b.route_version_id', '=', txn.route_version_id).where('b.enabled', '=', true).where('cb.state', '=', 'open').where('pa.status', '<>', 'suspended').orderBy('b.priority').execute();
        for (const b of all) {
          if (tried.includes(b.provider_account_id)) continue;
          if (await this.breaker.allowProbe(b.provider_account_id)) { binding = b; break; }
        }
      }
      if (!binding) {
        await this.transactions.finalizeFailure(tx, txn, 'NO_PROVIDER_AVAILABLE', { source: 'system', detail: { attempts: tried.length } });
        return null;
      }
      const seq = tried.length + 1;
      const attempt = await tx
        .insertInto('transaction_attempt')
        .values({
          transaction_id: txn.id, sequence: seq, provider_account_id: binding.provider_account_id, binding_id: binding.id,
          binding_snapshot: JSON.stringify({ expected_fee_bps: binding.expected_fee_bps, expected_fee_fixed: binding.expected_fee_fixed, terms_status: binding.terms_status, priority: binding.priority }),
          state: 'submitting',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.transactions.transitionTo(tx, txn, 'submitted', { source: 'system', attemptId: attempt.id, detail: { attempt: seq, provider_account_id: binding.provider_account_id }, patch: { current_attempt_id: attempt.id, selected_provider_account_id: binding.provider_account_id } });
      const route = await tx.selectFrom('route').selectAll().where('id', '=', txn.route_id).executeTakeFirstOrThrow();
      const currency = await tx.selectFrom('currency').select('exponent').where('code', '=', txn.currency_code).executeTakeFirstOrThrow();
      const { ctx, adapterKey } = await this.accounts.context(tx, binding.provider_account_id, txn.correlation_id, txn.id);
      const req = {
        transactionReference: txn.reference, direction: txn.direction as 'collection' | 'disbursement', amount: txn.direction === 'collection' ? txn.requested_amount : txn.expected_settled_amount,
        currency: txn.currency_code, currencyExponent: currency.exponent, country: route.country_code, paymentMethod: route.payment_method_code,
        msisdn: this.crypto.openString(txn.msisdn_ciphertext, 'msisdn'), counterpartyName: txn.counterparty_name, counterpartyEmail: txn.counterparty_email,
      };
      return { attempt, txn, req, ctx, adapterKey };
    });
  }

  /** Returns true where fallback should try the next provider. */
  private async recordOutcome(transactionId: string, attemptId: string, providerAccountId: string, result: SubmitResult | 'unavailable', unavailableMessage: string): Promise<boolean> {
    if (result === 'unavailable') await this.breaker.recordFailure(providerAccountId);
    else await this.breaker.recordSuccess(providerAccountId);
    return this.db.transaction().execute(async (tx) => {
      const txn = await this.transactions.lock(tx, transactionId);
      if (txn.state !== 'submitted' || txn.current_attempt_id !== attemptId) return false;
      const routeVersion = await tx.selectFrom('route_version').select('disbursement_fallback').where('id', '=', txn.route_version_id).executeTakeFirstOrThrow();
      const fallbackAllowed = txn.direction === 'collection' || routeVersion.disbursement_fallback;
      const now = await dbNow(tx);

      if (result === 'unavailable') {
        return this.failAttempt(tx, txn, attemptId, 'PROVIDER_UNAVAILABLE', { providerCode: null, providerMessage: unavailableMessage, payloadId: null }, fallbackAllowed);
      }
      if (result.outcome === 'rejected') {
        return this.failAttempt(tx, txn, attemptId, result.reason, { providerCode: result.providerCode ?? null, providerMessage: result.providerMessage ?? null, payloadId: result.payloadId ?? null }, fallbackAllowed);
      }
      if (result.outcome === 'undetermined') {
        await tx.updateTable('transaction_attempt').set({ provider_reference: result.providerReference ?? null, response_payload_id: result.payloadId ?? null }).where('id', '=', attemptId).execute();
        await this.transactions.markUndetermined(tx, txn, { source: 'provider_response', attemptId, payloadId: result.payloadId ?? null, detail: { reason: 'submission timed out' } });
        return false;
      }
      // Accepted.
      const interval = 10;
      const patch: Record<string, unknown> = { next_status_check_at: new Date(now.getTime() + interval * 1000), status_check_count: 0 };
      if (result.state === 'action_required' && result.action) {
        const windowSeconds = await this.settings.number(result.action.type === 'code' ? 'payer.code_window_seconds' : 'payer.browser_window_seconds');
        patch.action_expires_at = result.action.expiresAt ?? new Date(now.getTime() + windowSeconds * 1000);
        patch.payer_action = result.action.type;
        if (result.action.type === 'code') patch.code_attempts_remaining = await this.settings.number('payer.code_attempts');
        if (result.action.type === 'browser' && result.action.url) patch.action_url_ciphertext = this.crypto.seal(result.action.url, `action_url:${txn.id}`);
      }
      await tx.updateTable('transaction_attempt').set({ state: result.state, provider_reference: result.providerReference, response_payload_id: result.payloadId ?? null }).where('id', '=', attemptId).execute();
      await this.transactions.transitionTo(tx, txn, result.state, { source: 'provider_response', attemptId, payloadId: result.payloadId ?? null, detail: { provider_reference: result.providerReference }, patch });
      return false;
    });
  }

  private async failAttempt(tx: import('../db/database').Tx, txn: import('../transactions/transaction-reader').TransactionRow, attemptId: string, reason: FailureReason, p: { providerCode: string | null; providerMessage: string | null; payloadId: string | null }, fallbackAllowed: boolean): Promise<boolean> {
    await tx.updateTable('transaction_attempt').set({ state: 'failed', failure_reason: reason, provider_error_code: p.providerCode, provider_error_message: p.providerMessage, response_payload_id: p.payloadId, ended_at: sql`now()` }).where('id', '=', attemptId).execute();
    if (fallbackAllowed) {
      await this.transactions.transitionTo(tx, txn, 'created', { source: 'provider_response', attemptId, payloadId: p.payloadId, detail: { fallback_from_attempt: attemptId, reason } });
      return true;
    }
    await this.transactions.finalizeFailure(tx, txn, reason, { source: 'provider_response', attemptId, payloadId: p.payloadId, providerCode: p.providerCode, providerMessage: p.providerMessage });
    return false;
  }
}
