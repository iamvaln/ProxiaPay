import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError, type FailureReason } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { newTransactionReference } from '../crypto/references';
import { dbNow, DB_TOKEN, type Db, type Tx } from '../db/database';
import { InsufficientBalanceError, LedgerService } from '../ledger/ledger.service';
import { log } from '../logging/logger';
import { sum, type Bearer } from '../money/money';
import { NotificationService, type NotificationEvent } from '../notifications/notification.service';
import type { ProjectPrincipal } from '../project-auth/project-auth.service';
import { RouteResolver } from '../routes/route-resolver';
import { SettingsService } from '../settings/settings.service';
import { FloatInsufficientError, TreasuryService } from '../treasury/treasury.service';
import { JobQueue } from '../jobs/job-queue';
import { AlertService } from '../alerts/alert.service';
import { TransactionReader, type ApiTransaction, type TransactionRow } from './transaction-reader';
import { AuditService } from '../audit/audit.service';

export type EventSource = 'provider_response' | 'notification' | 'status_check' | 'reconciliation' | 'administrator' | 'system';
export const OPEN_STATES = ['created', 'action_required', 'submitted', 'processing'] as const;
export const TERMINAL_STATES = ['succeeded', 'failed', 'expired'] as const;

export interface OutcomeDetail {
  source: EventSource;
  attemptId?: string | null;
  payloadId?: string | null;
  actorId?: string | null;
  discrepancyId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * The transaction state machine (spec 5.1–5.3): confirmation from a preview, the outcome
 * transitions with their ledger effects, and code submission. Every change writes an event; a
 * terminal state is left only through reconciliation's correction path.
 */
@Injectable()
export class TransactionService {
  private readonly logger = log('transactions');
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly resolver: RouteResolver,
    private readonly ledger: LedgerService,
    private readonly treasury: TreasuryService,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
    private readonly crypto: CryptoService,
    private readonly reader: TransactionReader,
    private readonly queue: JobQueue,
    private readonly alerts: AlertService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Confirms a preview (spec 5.2, 5.3, 5.5). Idempotent on the preview: a second confirmation
   * returns the transaction the first created. Disbursements reserve funds and check liquidity
   * here, under their locks, before any provider is contacted.
   */
  async confirm(principal: ProjectPrincipal, previewReference: string, direction: 'collection' | 'disbursement'): Promise<{ transactionId: string; created: boolean }> {
    if (!principal.scopes.includes(direction)) throw new PlatformError('SCOPE_INSUFFICIENT', `The credential lacks the ${direction} scope.`);
    const result = await this.db.transaction().execute(async (tx) => {
      const preview = await tx.selectFrom('preview').selectAll().where('reference', '=', previewReference).where('project_id', '=', principal.projectId).forUpdate().executeTakeFirst();
      if (!preview) throw new PlatformError('PREVIEW_NOT_FOUND', 'The preview reference is unrecognised.');
      if (preview.direction !== direction) throw new PlatformError('PREVIEW_DIRECTION_MISMATCH', `The preview was raised as a ${preview.direction}.`);
      if (preview.status === 'confirmed' && preview.transaction_id) return { transactionId: preview.transaction_id, created: false };
      const now = await dbNow(tx);
      if (preview.status === 'expired' || preview.expires_at.getTime() <= now.getTime()) {
        if (preview.status === 'open') await tx.updateTable('preview').set({ status: 'expired' }).where('id', '=', preview.id).execute();
        throw new PlatformError('PREVIEW_EXPIRED', 'The preview window closed; raise a new preview.');
      }

      const resolution = await this.resolver.resolve(tx, { projectId: principal.projectId, direction, country: await countryOf(tx, preview.route_id), currency: preview.currency_code, paymentMethod: await methodOf(tx, preview.route_id), amount: preview.requested_amount });
      // Velocity and the duplicate guard, under the entitlement lock (spec 15.4).
      await this.resolver.checkVelocity(tx, resolution, preview.requested_amount);
      const pending = await tx.selectFrom('transaction').select('reference').where('project_id', '=', principal.projectId).where('route_id', '=', preview.route_id)
        .where('requested_amount', '=', preview.requested_amount).where('msisdn_index', '=', preview.msisdn_index).where('state', 'in', [...OPEN_STATES, 'undetermined']).executeTakeFirst();
      if (pending) throw new PlatformError('SIMILAR_PAYMENT_PENDING', 'A similar payment is already pending for this counterparty.', { details: { transaction: pending.reference } });

      const bindings = await this.resolver.availableBindings(tx, preview.route_version_id, preview.requested_amount);
      if (bindings.length === 0) throw new PlatformError('NO_PROVIDER_AVAILABLE', 'No provider is available for this route at the moment.');
      const binding = bindings.find((b) => b.id === preview.binding_id) ?? bindings[0]!;

      const ceiling = await this.settings.number(direction === 'collection' ? 'sweep.ceiling_collection_seconds' : 'sweep.ceiling_disbursement_seconds');
      const reference = newTransactionReference();
      const projectFees = sum(preview.processing_fee_bearer === 'project' ? preview.processing_fee : 0, preview.platform_fee_bearer === 'project' ? preview.platform_fee : 0);
      const reservedAmount = direction === 'disbursement' ? sum(preview.requested_amount, projectFees) : 0;

      const txn = await tx
        .insertInto('transaction')
        .values({
          reference,
          preview_id: preview.id,
          project_id: preview.project_id,
          route_id: preview.route_id,
          route_version_id: preview.route_version_id,
          entitlement_version_id: preview.entitlement_version_id,
          direction,
          state: 'created',
          currency_code: preview.currency_code,
          requested_amount: preview.requested_amount,
          charged_amount: preview.charged_amount,
          expected_settled_amount: preview.settled_amount,
          processing_fee: preview.processing_fee,
          platform_fee: preview.platform_fee,
          processing_fee_bearer: preview.processing_fee_bearer,
          platform_fee_bearer: preview.platform_fee_bearer,
          expected_provider_fee: preview.expected_provider_fee,
          reserved_amount: reservedAmount,
          msisdn_ciphertext: preview.msisdn_ciphertext,
          msisdn_index: preview.msisdn_index,
          msisdn_masked: preview.msisdn_masked,
          counterparty_name: preview.counterparty_name,
          counterparty_email: preview.counterparty_email,
          project_reference: preview.project_reference,
          metadata: JSON.stringify(preview.metadata),
          terms_snapshot: JSON.stringify(preview.terms_snapshot),
          limits_snapshot: JSON.stringify(preview.limits_snapshot),
          payer_action: preview.payer_action,
          binding_id: binding.id,
          selected_provider_account_id: binding.provider_account_id,
          sweep_ceiling_at: new Date(now.getTime() + ceiling * 1000),
          correlation_id: preview.correlation_id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx.updateTable('preview').set({ status: 'confirmed', transaction_id: txn.id, confirmed_at: sql`now()` }).where('id', '=', preview.id).execute();
      await this.event(tx, txn.id, null, 'created', { source: 'system', detail: { preview: preview.reference, binding_id: binding.id } });

      if (direction === 'disbursement') {
        try {
          await this.ledger.reserve(tx, { transactionId: txn.id, projectId: preview.project_id, currency: preview.currency_code, amount: reservedAmount });
        } catch (e) {
          if (e instanceof InsufficientBalanceError) throw new PlatformError('BALANCE_INSUFFICIENT', "The project's available balance falls short.", { details: { shortfall: e.shortfall, currency: e.currency } });
          throw e;
        }
        const floatAccount = await this.ledger.getOrCreateAccount(tx, { type: 'float', providerAccountId: binding.provider_account_id, countryCode: resolution.route.countryCode, currency: preview.currency_code, direction: 'disbursement' });
        try {
          await this.treasury.checkLiquidity(tx, floatAccount, sum(preview.settled_amount, preview.expected_provider_fee), txn.id);
        } catch (e) {
          if (e instanceof FloatInsufficientError) {
            // The whole transaction rolls back (no record, no reservation); the alert is raised outside it.
            throw new FloatShort(floatAccount, sum(preview.settled_amount, preview.expected_provider_fee));
          }
          throw e;
        }
      }
      // Safety net: if the synchronous submission below is interrupted, the worker submits within a minute.
      await this.queue.enqueue(tx, 'transaction.submit', { transactionId: txn.id }, { runAt: new Date(now.getTime() + 60_000), dedupeKey: `submit:${txn.id}` });
      return { transactionId: txn.id, created: true };
    }).catch(async (e) => {
      if (e instanceof FloatShort) {
        await this.treasury.raiseFloatInsufficient(e.floatAccountId, e.required);
        throw new PlatformError('FLOAT_INSUFFICIENT', 'Platform liquidity on this route is short; retry later.');
      }
      throw e;
    });
    return result;
  }

  /** Records a state change in the append-only event log. */
  async event(tx: Tx, transactionId: string, prior: string | null, next: string, d: OutcomeDetail): Promise<void> {
    await tx.insertInto('transaction_event').values({
      transaction_id: transactionId, prior_state: prior, new_state: next, source: d.source, actor_id: d.actorId ?? null, payload_id: d.payloadId ?? null, discrepancy_id: d.discrepancyId ?? null, detail: JSON.stringify(d.detail ?? {}),
    }).execute();
  }

  async lock(tx: Tx, transactionId: string): Promise<TransactionRow> {
    return tx.selectFrom('transaction').selectAll().where('id', '=', transactionId).forUpdate().executeTakeFirstOrThrow();
  }

  private fees(txn: TransactionRow, actualProviderFee: number) {
    return {
      requested: txn.requested_amount, processingFee: txn.processing_fee, platformFee: txn.platform_fee,
      processingBearer: txn.processing_fee_bearer as Bearer, platformBearer: txn.platform_fee_bearer as Bearer, actualProviderFee,
    };
  }

  private async floatAccountFor(tx: Tx, txn: TransactionRow, providerAccountId: string): Promise<string> {
    const route = await tx.selectFrom('route').select('country_code').where('id', '=', txn.route_id).executeTakeFirstOrThrow();
    return this.ledger.getOrCreateAccount(tx, { type: 'float', providerAccountId, countryCode: route.country_code, currency: txn.currency_code, direction: txn.direction as 'collection' | 'disbursement' });
  }

  /** Success: amounts and fees recorded, ledger posted, project notified. From processing, action_required or undetermined (via correction). */
  async finalizeSuccess(tx: Tx, txn: TransactionRow, r: { actualProviderFee: number | null; chargedAmount?: number | null; operatorReference?: string | null; providerAccountId: string } & OutcomeDetail): Promise<void> {
    if (TERMINAL_STATES.includes(txn.state as never)) return;
    const actualFee = r.actualProviderFee ?? txn.expected_provider_fee;
    const settled = txn.expected_settled_amount;
    const floatAccount = await this.floatAccountFor(tx, txn, r.providerAccountId);
    if (txn.direction === 'collection') {
      await this.ledger.postCollection(tx, { transactionId: txn.id, projectId: txn.project_id, currency: txn.currency_code, floatAccountId: floatAccount, fees: this.fees(txn, actualFee) });
    } else {
      await this.ledger.settleDisbursement(tx, { transactionId: txn.id, projectId: txn.project_id, currency: txn.currency_code, floatAccountId: floatAccount, fees: this.fees(txn, actualFee), from: txn.state === 'undetermined' ? 'suspense' : 'reserved' });
    }
    await tx.updateTable('transaction').set({
      state: 'succeeded', settled_amount: settled, actual_provider_fee: actualFee, terminal_at: sql`now()`, next_status_check_at: null, action_url_ciphertext: null,
      ...(r.chargedAmount != null && r.chargedAmount !== txn.charged_amount ? {} : {}),
      ...(r.discrepancyId ? { reconciliation_status: 'corrected' } : {}),
    }).where('id', '=', txn.id).execute();
    if (r.attemptId) await tx.updateTable('transaction_attempt').set({ state: 'succeeded', actual_provider_fee: actualFee, operator_reference: r.operatorReference ?? null, ended_at: sql`now()`, response_payload_id: r.payloadId ?? null }).where('id', '=', r.attemptId).execute();
    await this.event(tx, txn.id, txn.state, 'succeeded', { ...r, detail: { ...(r.detail ?? {}), actual_provider_fee: actualFee, provider_charged_amount: r.chargedAmount ?? null } });
    await this.notify(tx, txn.id, 'transaction.succeeded');
    await this.alerts.clear(`undetermined:${txn.id}`, tx);
  }

  /** Definite failure: no money moved, a reservation is released, the project is notified. */
  async finalizeFailure(tx: Tx, txn: TransactionRow, reason: FailureReason, r: OutcomeDetail & { providerCode?: string | null; providerMessage?: string | null }): Promise<void> {
    if (TERMINAL_STATES.includes(txn.state as never)) return;
    if (txn.direction === 'disbursement' && txn.reserved_amount > 0) {
      await this.ledger.releaseReservation(tx, { transactionId: txn.id, projectId: txn.project_id, currency: txn.currency_code, amount: txn.reserved_amount, from: txn.state === 'undetermined' ? 'suspense' : 'reserved' });
    }
    const next = reason === 'ACTION_WINDOW_EXPIRED' ? 'expired' : 'failed';
    await tx.updateTable('transaction').set({ state: next, failure_reason: reason, terminal_at: sql`now()`, next_status_check_at: null, action_url_ciphertext: null, ...(r.discrepancyId ? { reconciliation_status: 'corrected' } : {}) }).where('id', '=', txn.id).execute();
    if (r.attemptId) await tx.updateTable('transaction_attempt').set({ state: 'failed', failure_reason: reason, provider_error_code: r.providerCode ?? null, provider_error_message: r.providerMessage ?? null, ended_at: sql`now()`, response_payload_id: r.payloadId ?? null }).where('id', '=', r.attemptId).execute();
    await this.event(tx, txn.id, txn.state, next, { ...r, detail: { ...(r.detail ?? {}), failure_reason: reason, provider_code: r.providerCode ?? null } });
    await this.notify(tx, txn.id, next === 'expired' ? 'transaction.expired' : 'transaction.failed');
    await this.alerts.clear(`undetermined:${txn.id}`, tx);
  }

  /** No conclusive outcome: a disbursement's reservation moves to suspense and the transaction waits for reconciliation. */
  async markUndetermined(tx: Tx, txn: TransactionRow, r: OutcomeDetail): Promise<void> {
    if (TERMINAL_STATES.includes(txn.state as never) || txn.state === 'undetermined') return;
    if (txn.direction === 'disbursement' && txn.reserved_amount > 0) {
      await this.ledger.suspendReservation(tx, { transactionId: txn.id, projectId: txn.project_id, currency: txn.currency_code, amount: txn.reserved_amount });
    }
    await tx.updateTable('transaction').set({ state: 'undetermined', failure_reason: 'OUTCOME_UNDETERMINED', next_status_check_at: null }).where('id', '=', txn.id).execute();
    if (r.attemptId) await tx.updateTable('transaction_attempt').set({ state: 'undetermined', ended_at: sql`now()` }).where('id', '=', r.attemptId).execute();
    await this.event(tx, txn.id, txn.state, 'undetermined', r);
    await this.notify(tx, txn.id, 'transaction.undetermined');
    await this.alerts.raise({
      category: 'reconciliation', severity: txn.direction === 'disbursement' ? 'critical' : 'warning', subjectType: 'transaction', subjectReference: txn.reference, projectId: txn.project_id,
      fingerprint: `undetermined:${txn.id}`, title: `${txn.direction} held undetermined`, detail: { reference: txn.reference, amount: txn.requested_amount, currency: txn.currency_code }, actionReference: `/transactions/${txn.reference}`,
    }, tx);
  }

  async transitionTo(tx: Tx, txn: TransactionRow, next: 'submitted' | 'processing' | 'action_required' | 'created', r: OutcomeDetail & { patch?: Record<string, unknown> }): Promise<void> {
    await tx.updateTable('transaction').set({ state: next, ...(r.patch ?? {}) }).where('id', '=', txn.id).execute();
    await this.event(tx, txn.id, txn.state, next, r);
    if (next === 'action_required') await this.notify(tx, txn.id, 'transaction.action_required');
  }

  /**
   * Reconciliation established that the outcome differed from what was recorded (spec 9.7).
   * The prior state stands in the history and the project receives a distinct correction event.
   */
  async applyCorrection(tx: Tx, transactionId: string, target: 'succeeded' | 'failed', r: { actualProviderFee?: number | null; operatorReference?: string | null; discrepancyId: string; actorId: string; failureReason?: FailureReason; runId?: string }): Promise<void> {
    const txn = await this.lock(tx, transactionId);
    const priorState = txn.state;
    const priorReason = txn.failure_reason;
    const attempt = txn.current_attempt_id ? await tx.selectFrom('transaction_attempt').selectAll().where('id', '=', txn.current_attempt_id).executeTakeFirst() : undefined;
    const providerAccountId = attempt?.provider_account_id ?? txn.selected_provider_account_id;
    if (!providerAccountId) throw new PlatformError('RULE_VIOLATION', 'The transaction reached no provider; nothing to correct against.');
    const detail: OutcomeDetail = { source: 'reconciliation', actorId: r.actorId, discrepancyId: r.discrepancyId, attemptId: attempt?.id ?? null, detail: { run_id: r.runId ?? null, previous_state: priorState } };

    if (target === 'succeeded') {
      if (priorState === 'succeeded') return;
      if (priorState === 'failed' || priorState === 'expired') {
        // A failed disbursement already released its reservation; re-reserve from available so the settlement recipe holds.
        if (txn.direction === 'disbursement' && txn.reserved_amount > 0) {
          await this.ledger.reserve(tx, { transactionId: txn.id, projectId: txn.project_id, currency: txn.currency_code, amount: txn.reserved_amount });
        }
        await tx.updateTable('transaction').set({ state: 'processing', failure_reason: null, terminal_at: null }).where('id', '=', txn.id).execute();
        await this.event(tx, txn.id, priorState, 'processing', { ...detail, detail: { ...detail.detail, reopened_for_correction: true } });
        const reopened = { ...txn, state: 'processing', failure_reason: null } as TransactionRow;
        await this.finalizeSuccess(tx, reopened, { ...detail, actualProviderFee: r.actualProviderFee ?? null, operatorReference: r.operatorReference ?? attempt?.operator_reference ?? null, providerAccountId });
      } else {
        await this.finalizeSuccess(tx, txn, { ...detail, actualProviderFee: r.actualProviderFee ?? null, operatorReference: r.operatorReference ?? null, providerAccountId });
      }
    } else {
      if (priorState === 'failed') return;
      if (priorState === 'succeeded') {
        // Money recorded as moved did not: reverse the settlement or collection entry.
        const entries = await tx.selectFrom('ledger_entry').select('id').where('transaction_id', '=', txn.id).where('entry_type', 'in', ['collection', 'disbursement_settlement', 'suspense_settlement', 'refund']).execute();
        for (const e of entries) await this.ledger.reverse(tx, e.id, r.actorId, `reconciliation correction of ${txn.reference}`, r.discrepancyId);
        if (txn.direction === 'disbursement' && txn.reserved_amount > 0) {
          // The reversal restored the reserved balance; release it back to available.
          await this.ledger.releaseReservation(tx, { transactionId: txn.id, projectId: txn.project_id, currency: txn.currency_code, amount: txn.reserved_amount, from: 'reserved' });
        }
        await tx.updateTable('transaction').set({ state: 'processing', settled_amount: null, terminal_at: null }).where('id', '=', txn.id).execute();
        await this.event(tx, txn.id, priorState, 'processing', { ...detail, detail: { ...detail.detail, reopened_for_correction: true } });
        const reopened = { ...txn, state: 'processing', reserved_amount: 0 } as TransactionRow;
        await this.finalizeFailure(tx, reopened, r.failureReason ?? 'PROVIDER_REJECTED', detail);
      } else {
        await this.finalizeFailure(tx, txn, r.failureReason ?? 'PROVIDER_REJECTED', detail);
      }
    }
    await tx.updateTable('transaction').set({ reconciliation_status: 'corrected' }).where('id', '=', txn.id).execute();
    await this.notify(tx, txn.id, 'transaction.corrected', { previous_state: priorState, previous_failure_reason: priorReason, reconciliation_run: r.runId ?? null, discrepancy: r.discrepancyId });
  }

  private async notify(tx: Tx, transactionId: string, event: NotificationEvent, extra: Record<string, unknown> = {}): Promise<void> {
    const { txn, attempt, route } = await this.reader.load(tx, transactionId);
    const data = { transaction: this.reader.toApi(txn, attempt, route, { revealMsisdn: true, revealAction: true }), ...extra };
    await this.notifications.enqueue(tx, { projectId: txn.project_id, transactionId, event, data });
  }

  /** Code submission (spec 5.2, API reference 5.4). Attempts are recorded as events without the code itself. */
  async submitCode(principal: ProjectPrincipal, reference: string, code: string, submitToProvider: (txn: TransactionRow, providerReference: string, code: string) => Promise<{ state: string; actualProviderFee?: number | null; operatorReference?: string | null; failureReason?: FailureReason; payloadId?: string }>): Promise<ApiTransaction> {
    const outcome = await this.db.transaction().execute(async (tx) => {
      const found = await tx.selectFrom('transaction').select('id').where('reference', '=', reference).where('project_id', '=', principal.projectId).executeTakeFirst();
      if (!found) throw new PlatformError('TRANSACTION_NOT_FOUND', 'No such transaction.');
      const txn = await this.lock(tx, found.id);
      if (txn.state !== 'action_required' || txn.payer_action !== 'code') throw new PlatformError('ACTION_NOT_AVAILABLE', 'The transaction is not awaiting a code.');
      const now = await dbNow(tx);
      if (txn.action_expires_at && txn.action_expires_at.getTime() <= now.getTime()) {
        await this.finalizeFailure(tx, txn, 'ACTION_WINDOW_EXPIRED', { source: 'system' });
        throw new PlatformError('ACTION_NOT_AVAILABLE', 'The action window closed.');
      }
      if ((txn.code_attempts_remaining ?? 0) <= 0) throw new PlatformError('CODE_ATTEMPTS_EXHAUSTED', 'The attempt limit was reached.');
      const attempt = await tx.selectFrom('transaction_attempt').selectAll().where('id', '=', txn.current_attempt_id!).executeTakeFirstOrThrow();
      return { txn, attempt };
    });
    const result = await submitToProvider(outcome.txn, outcome.attempt.provider_reference!, code);
    return this.db.transaction().execute(async (tx) => {
      const txn = await this.lock(tx, outcome.txn.id);
      if (result.state === 'succeeded') {
        await this.event(tx, txn.id, txn.state, txn.state, { source: 'provider_response', attemptId: outcome.attempt.id, payloadId: result.payloadId, detail: { code_attempt: 'accepted' } });
        await this.finalizeSuccess(tx, txn, { source: 'provider_response', attemptId: outcome.attempt.id, payloadId: result.payloadId, actualProviderFee: result.actualProviderFee ?? null, operatorReference: result.operatorReference ?? null, providerAccountId: outcome.attempt.provider_account_id });
      } else if (result.state === 'failed') {
        await this.finalizeFailure(tx, txn, result.failureReason ?? 'PROVIDER_REJECTED', { source: 'provider_response', attemptId: outcome.attempt.id, payloadId: result.payloadId });
      } else {
        const remaining = (txn.code_attempts_remaining ?? 1) - 1;
        await tx.updateTable('transaction').set({ code_attempts_remaining: remaining }).where('id', '=', txn.id).execute();
        await this.event(tx, txn.id, txn.state, txn.state, { source: 'provider_response', attemptId: outcome.attempt.id, payloadId: result.payloadId, detail: { code_attempt: 'rejected', attempts_remaining: remaining } });
        if (remaining <= 0) {
          await this.finalizeFailure(tx, { ...txn, code_attempts_remaining: 0 }, 'CODE_ATTEMPTS_EXHAUSTED', { source: 'system', attemptId: outcome.attempt.id });
          throw new PlatformError('CODE_ATTEMPTS_EXHAUSTED', 'The attempt limit was reached.');
        }
        throw new PlatformError('CODE_INVALID', 'The submitted code was wrong.', { details: { attempts_remaining: remaining } });
      }
      return this.reader.apiById(tx, txn.id, { revealMsisdn: true, revealAction: true });
    });
  }

  /** An administrator forces a status re-check (console spec 5.2). */
  async forceRecheck(reference: string, actorId: string): Promise<void> {
    const txn = await this.db.selectFrom('transaction').select(['id', 'state']).where('reference', '=', reference).executeTakeFirst();
    if (!txn) throw new PlatformError('NOT_FOUND', 'No such transaction.');
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable('transaction').set({ next_status_check_at: sql`now()` }).where('id', '=', txn.id).execute();
      await this.queue.enqueue(tx, 'transaction.status_check', { transactionId: txn.id, source: 'administrator', actorId }, { dedupeKey: `status:${txn.id}` });
      await this.audit.record(tx, { actorId, action: 'transaction.force_recheck', subjectType: 'transaction', subjectId: reference, prior: { state: txn.state } });
    });
  }

  async apiByReference(principal: ProjectPrincipal, reference: string): Promise<ApiTransaction> {
    const found = await this.db.selectFrom('transaction').select('id').where('reference', '=', reference).where('project_id', '=', principal.projectId).executeTakeFirst();
    if (!found) throw new PlatformError('TRANSACTION_NOT_FOUND', 'No such transaction.');
    return this.reader.apiById(this.db, found.id, { revealMsisdn: true, revealAction: true });
  }
}

class FloatShort extends Error {
  constructor(readonly floatAccountId: string, readonly required: number) {
    super('float short');
  }
}

async function countryOf(tx: Tx, routeId: string): Promise<string> {
  return (await tx.selectFrom('route').select('country_code').where('id', '=', routeId).executeTakeFirstOrThrow()).country_code;
}
async function methodOf(tx: Tx, routeId: string): Promise<string> {
  return (await tx.selectFrom('route').select('payment_method_code').where('id', '=', routeId).executeTakeFirstOrThrow()).payment_method_code;
}
