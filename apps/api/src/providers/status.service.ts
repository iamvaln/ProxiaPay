import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { dbNow, DB_TOKEN, type Db } from '../db/database';
import { log } from '../logging/logger';
import { TransactionService, type EventSource } from '../transactions/transaction.service';
import { ProviderUnavailableError, type StatusResult } from './adapter';
import { CircuitBreaker } from './circuit-breaker';
import { ProviderAccountService } from './provider-account.service';
import { JobQueue } from '../jobs/job-queue';

/** Decreasing frequency: 10 s, 20 s, 40 s … capped at ten minutes, until the ceiling (spec 5.6). */
export function nextCheckDelaySeconds(count: number): number {
  return Math.min(600, 10 * 2 ** Math.min(count, 10));
}

/**
 * Status acquisition (spec 5.6). Notifications from providers are triggers; the provider's
 * status interface is what moves state. The sweep covers everything open, and a transaction
 * still open at its ceiling moves to undetermined.
 */
@Injectable()
export class StatusService {
  private readonly logger = log('status');
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly transactions: TransactionService,
    private readonly accounts: ProviderAccountService,
    private readonly breaker: CircuitBreaker,
    private readonly queue: JobQueue,
  ) {}

  async check(transactionId: string, source: EventSource, actorId: string | null = null): Promise<string | null> {
    const prepared = await this.db.transaction().execute(async (tx) => {
      const txn = await this.transactions.lock(tx, transactionId);
      if (!['submitted', 'processing', 'action_required'].includes(txn.state)) return null;
      const now = await dbNow(tx);
      const attempt = txn.current_attempt_id ? await tx.selectFrom('transaction_attempt').selectAll().where('id', '=', txn.current_attempt_id).executeTakeFirst() : undefined;
      if (!attempt?.provider_reference) {
        // Sent and never acknowledged: nothing to ask the provider by. Wait for the ceiling, then hold.
        if (now >= txn.sweep_ceiling_at) await this.transactions.markUndetermined(tx, txn, { source, attemptId: attempt?.id ?? null, detail: { reason: 'no provider reference at ceiling' } });
        else await this.schedule(tx, txn.id, txn.status_check_count, now);
        return null;
      }
      const { ctx, adapterKey } = await this.accounts.context(tx, attempt.provider_account_id, txn.correlation_id, txn.id);
      return { txn, attempt, ctx, adapterKey };
    });
    if (!prepared) return null;
    const adapter = this.accounts.adapter(prepared.adapterKey);
    let result: StatusResult | null = null;
    try {
      result = await adapter.status(prepared.ctx, prepared.attempt.provider_reference!);
      await this.breaker.recordSuccess(prepared.attempt.provider_account_id);
    } catch (e) {
      if (!(e instanceof ProviderUnavailableError)) throw e;
      await this.breaker.recordFailure(prepared.attempt.provider_account_id);
      this.logger.warn({ transaction: prepared.txn.reference, err: e.message }, 'status check failed; will retry');
    }
    return this.db.transaction().execute(async (tx) => {
      const txn = await this.transactions.lock(tx, transactionId);
      if (!['submitted', 'processing', 'action_required'].includes(txn.state)) return txn.state;
      const now = await dbNow(tx);
      const d = { source, actorId, attemptId: prepared.attempt.id, payloadId: result?.payloadId ?? null };
      if (result?.state === 'succeeded') {
        await this.transactions.finalizeSuccess(tx, txn, { ...d, actualProviderFee: result.providerFee ?? null, chargedAmount: result.chargedAmount ?? null, operatorReference: result.operatorReference ?? null, providerAccountId: prepared.attempt.provider_account_id });
        return 'succeeded';
      }
      if (result?.state === 'failed') {
        await this.transactions.finalizeFailure(tx, txn, result.failureReason ?? 'PROVIDER_REJECTED', { ...d, providerCode: result.providerCode ?? null, providerMessage: result.providerMessage ?? null });
        return txn.state;
      }
      if (txn.state === 'action_required' && txn.action_expires_at && now >= txn.action_expires_at) {
        await this.transactions.finalizeFailure(tx, txn, 'ACTION_WINDOW_EXPIRED', { ...d, source: 'system' });
        return 'expired';
      }
      if (now >= txn.sweep_ceiling_at) {
        await this.transactions.markUndetermined(tx, txn, { ...d, detail: { reason: 'sweep ceiling reached', last_provider_state: result?.state ?? 'unreachable' } });
        return 'undetermined';
      }
      if (result && result.state === 'processing' && txn.state !== 'processing' && txn.state !== 'action_required') {
        await this.transactions.transitionTo(tx, txn, 'processing', d);
      }
      await this.schedule(tx, txn.id, txn.status_check_count, now);
      return txn.state;
    });
  }

  private async schedule(tx: import('../db/database').Tx, transactionId: string, count: number, now: Date): Promise<void> {
    await tx.updateTable('transaction').set({ next_status_check_at: new Date(now.getTime() + nextCheckDelaySeconds(count) * 1000), status_check_count: count + 1 }).where('id', '=', transactionId).execute();
  }

  /** One pass of the sweep: every open transaction whose check is due. Returns the number examined. */
  async sweep(limit = 100): Promise<number> {
    const due = await this.db
      .selectFrom('transaction')
      .select('id')
      .where('state', 'in', ['submitted', 'processing', 'action_required'])
      .where('next_status_check_at', '<=', sql<Date>`now()`)
      .orderBy('next_status_check_at')
      .limit(limit)
      .execute();
    // Push each check out before running it, so a slow provider does not make the next sweep pick the same rows.
    if (due.length) await this.db.updateTable('transaction').set({ next_status_check_at: sql`now() + interval '60 seconds'` }).where('id', 'in', due.map((d) => d.id)).execute();
    const batches: string[][] = [];
    for (let i = 0; i < due.length; i += 8) batches.push(due.slice(i, i + 8).map((d) => d.id));
    for (const batch of batches) {
      await Promise.all(batch.map((id) => this.check(id, 'status_check').catch((e) => this.logger.error({ transaction_id: id, err: e }, 'status check errored'))));
    }
    return due.length;
  }

  /** An inbound notification names a payment; the platform verifies by status check (spec 5.6). */
  async onProviderNotification(providerAccountId: string, providerReference: string, eventKey: string, externalReference: string | undefined, payloadId: string | null): Promise<'queued' | 'duplicate' | 'unmatched'> {
    return this.db.transaction().execute(async (tx) => {
      const receipt = await tx.insertInto('provider_notification_receipt').values({ provider_account_id: providerAccountId, provider_reference: providerReference, event_key: eventKey, payload_id: payloadId }).onConflict((oc) => oc.doNothing()).returning('provider_reference').executeTakeFirst();
      if (!receipt) return 'duplicate';
      let attempt = await tx.selectFrom('transaction_attempt').select('transaction_id').where('provider_account_id', '=', providerAccountId).where('provider_reference', '=', providerReference).executeTakeFirst();
      if (!attempt && externalReference) {
        const txn = await tx.selectFrom('transaction').select('id as transaction_id').where('reference', '=', externalReference).executeTakeFirst();
        attempt = txn ?? undefined;
      }
      if (!attempt) return 'unmatched';
      await tx.updateTable('transaction').set({ next_status_check_at: sql`now()` }).where('id', '=', attempt.transaction_id).execute();
      await this.queue.enqueue(tx, 'transaction.status_check', { transactionId: attempt.transaction_id, source: 'notification' }, { dedupeKey: `status:${attempt.transaction_id}` });
      await tx.insertInto('transaction_event').values({ transaction_id: attempt.transaction_id, prior_state: null, new_state: 'notification_received', source: 'notification', payload_id: payloadId, detail: JSON.stringify({ event: eventKey }) }).execute();
      return 'queued';
    });
  }
}
