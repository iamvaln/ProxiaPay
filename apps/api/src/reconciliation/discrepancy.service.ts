import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError, type FailureReason } from '../common/errors';
import { DB_TOKEN, type Db, type Tx } from '../db/database';
import { LedgerService, type Posting } from '../ledger/ledger.service';
import { SettingsService } from '../settings/settings.service';
import { TransactionService } from '../transactions/transaction.service';
import { TreasuryService } from '../treasury/treasury.service';
import { AuditService } from '../audit/audit.service';
import { AlertService } from '../alerts/alert.service';

export interface Decision {
  decision: 'accepted' | 'rejected';
  comment: string;
  /** What follows an acceptance: nothing, a correction of the transaction, or a ledger adjustment. */
  follow: 'none' | 'correct_transaction' | 'post_adjustment';
  adjustment?: { postings: Posting[]; justification: string };
  confirmationId?: string;
}

/**
 * The review of discrepancies (spec 9.5–9.7): assignment, comments, a decision with its
 * consequence, second approval above the adjustment threshold, and corrections written as
 * events on the transactions they touch with the project told.
 */
@Injectable()
export class DiscrepancyService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly transactions: TransactionService,
    private readonly treasury: TreasuryService,
    private readonly audit: AuditService,
    private readonly alerts: AlertService,
  ) {}

  async assign(discrepancyId: string, assigneeId: string | null, actorId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const d = await tx.selectFrom('discrepancy').select(['status', 'assignee_id']).where('id', '=', discrepancyId).forUpdate().executeTakeFirstOrThrow();
      if (d.status === 'resolved') throw new PlatformError('CONFLICT', 'The discrepancy is resolved.');
      await tx.updateTable('discrepancy').set({ assignee_id: assigneeId, status: assigneeId ? 'under_review' : 'open' }).where('id', '=', discrepancyId).execute();
      await this.audit.record(tx, { actorId, action: 'discrepancy.assign', subjectType: 'discrepancy', subjectId: discrepancyId, prior: { assignee: d.assignee_id }, next: { assignee: assigneeId } });
    });
  }

  async comment(discrepancyId: string, authorId: string, body: string): Promise<void> {
    await this.db.insertInto('discrepancy_comment').values({ discrepancy_id: discrepancyId, author_id: authorId, body: body.trim() }).execute();
  }

  /** Previews what a decision would write, so the console shows the entry and the correction before committing. */
  async preview(discrepancyId: string, follow: Decision['follow']) {
    const d = await this.db.selectFrom('discrepancy').selectAll().where('id', '=', discrepancyId).executeTakeFirstOrThrow();
    const threshold = await this.settings.number('adjustment.second_approval_above');
    const out: Record<string, unknown> = { threshold };
    if (follow === 'correct_transaction' && d.transaction_id) {
      const t = await this.db.selectFrom('transaction').select(['reference', 'state', 'failure_reason', 'direction', 'requested_amount', 'currency_code']).where('id', '=', d.transaction_id).executeTakeFirstOrThrow();
      const observed = d.observed as { state?: string };
      out.correction = { transaction: t.reference, from: { state: t.state, failure_reason: t.failure_reason }, to: { state: observed.state === 'succeeded' ? 'succeeded' : 'failed' }, notification: 'transaction.corrected', amount: t.requested_amount, currency: t.currency_code };
      out.requires_approval = t.requested_amount > threshold;
    }
    if (follow === 'post_adjustment') {
      out.suggested_postings = await this.suggestedPostings(d);
      out.requires_approval = Math.abs(d.difference ?? 0) > threshold;
    }
    return out;
  }

  private async suggestedPostings(d: { type: string; float_account_id: string | null; difference: number | null; currency_code: string | null }): Promise<Posting[]> {
    if (d.type === 'float_drift' && d.float_account_id && d.difference && d.currency_code) {
      const suspense = await this.ledger.getOrCreateAccount(this.db, { type: 'suspense', currency: d.currency_code });
      const amount = Math.abs(d.difference);
      // Wallet holds more than the ledger: float up, suspense up; less: the reverse.
      return d.difference > 0
        ? [{ accountId: d.float_account_id, side: 'debit', amount }, { accountId: suspense, side: 'credit', amount }]
        : [{ accountId: d.float_account_id, side: 'credit', amount }, { accountId: suspense, side: 'debit', amount }];
    }
    return [];
  }

  async decide(discrepancyId: string, actorId: string, input: Decision): Promise<{ status: 'resolved' | 'pending_approval' }> {
    if (!input.comment.trim()) throw new PlatformError('FIELD_INVALID', 'A decision requires a comment.', { field: 'comment' });
    const threshold = await this.settings.number('adjustment.second_approval_above');
    return this.db.transaction().execute(async (tx) => {
      const d = await tx.selectFrom('discrepancy').selectAll().where('id', '=', discrepancyId).forUpdate().executeTakeFirstOrThrow();
      if (d.status === 'resolved') throw new PlatformError('CONFLICT', 'The discrepancy is already resolved.');
      await tx.insertInto('discrepancy_comment').values({ discrepancy_id: d.id, author_id: actorId, body: input.comment.trim() }).execute();
      const follow = input.decision === 'rejected' ? 'none' : input.follow;
      let magnitude = 0;
      if (follow === 'post_adjustment') {
        const postings = input.adjustment?.postings ?? await this.suggestedPostings(d);
        if (!postings.length) throw new PlatformError('FIELD_INVALID', 'An adjustment needs postings.', { field: 'adjustment.postings' });
        magnitude = Math.max(...postings.map((p) => p.amount));
        if (magnitude > threshold) return this.queueApproval(tx, d.id, actorId, input, { postings, justification: input.adjustment?.justification ?? input.comment });
        const entryId = await this.ledger.postAdjustment(tx, { postings, authorId: actorId, justification: input.adjustment?.justification ?? input.comment, discrepancyId: d.id, transactionId: d.transaction_id ?? undefined });
        await this.resolve(tx, d.id, actorId, input.decision, true, entryId, null, input.confirmationId);
        if (d.transaction_id) await tx.updateTable('transaction').set({ reconciliation_status: 'examined' }).where('id', '=', d.transaction_id).where('reconciliation_status', '=', 'disputed').execute();
        return { status: 'resolved' as const };
      }
      if (follow === 'correct_transaction') {
        if (!d.transaction_id) throw new PlatformError('RULE_VIOLATION', 'This discrepancy names no transaction to correct.');
        const t = await tx.selectFrom('transaction').select(['requested_amount']).where('id', '=', d.transaction_id).executeTakeFirstOrThrow();
        if (t.requested_amount > threshold) return this.queueApproval(tx, d.id, actorId, input, null);
        await this.applyCorrection(tx, d, actorId, null);
        await this.resolve(tx, d.id, actorId, input.decision, true, null, null, input.confirmationId);
        return { status: 'resolved' as const };
      }
      await this.resolve(tx, d.id, actorId, input.decision, false, null, null, input.confirmationId);
      if (d.transaction_id) await tx.updateTable('transaction').set({ reconciliation_status: 'examined' }).where('id', '=', d.transaction_id).where('reconciliation_status', '=', 'disputed').execute();
      if (d.type === 'unconfirmed_transfer' && d.float_transfer_id && input.decision === 'accepted') await this.treasury.confirmTransfer(tx, d.float_transfer_id, d.run_id);
      return { status: 'resolved' as const };
    });
  }

  private async queueApproval(tx: Tx, discrepancyId: string, actorId: string, input: Decision, adjustment: { postings: Posting[]; justification: string } | null): Promise<{ status: 'pending_approval' }> {
    await tx.insertInto('approval_request').values({
      type: 'discrepancy_resolution', subject: JSON.stringify({ discrepancy_id: discrepancyId, decision: input.decision, follow: input.follow, adjustment }),
      summary: `Discrepancy resolution with ${input.follow === 'post_adjustment' ? 'an adjustment' : 'a transaction correction'}`, initiated_by: actorId, justification: input.comment,
    }).execute();
    await this.audit.record(tx, { actorId, action: 'discrepancy.decision_queued', subjectType: 'discrepancy', subjectId: discrepancyId, next: { decision: input.decision, follow: input.follow }, confirmationId: input.confirmationId });
    await this.alerts.raise({ category: 'security', severity: 'informational', subjectType: 'discrepancy', subjectReference: discrepancyId, fingerprint: `approval:discrepancy:${discrepancyId}`, title: 'Discrepancy resolution awaiting a second approver', actionReference: '/approvals' }, tx);
    return { status: 'pending_approval' };
  }

  /** Executed by the approval queue once a second administrator agrees. */
  async executeApproved(tx: Tx, subject: { discrepancy_id: string; decision: 'accepted' | 'rejected'; follow: Decision['follow']; adjustment: { postings: Posting[]; justification: string } | null }, initiatorId: string, approverId: string): Promise<void> {
    const d = await tx.selectFrom('discrepancy').selectAll().where('id', '=', subject.discrepancy_id).forUpdate().executeTakeFirstOrThrow();
    if (d.status === 'resolved') return;
    let entryId: string | null = null;
    if (subject.follow === 'post_adjustment' && subject.adjustment) {
      entryId = await this.ledger.postAdjustment(tx, { postings: subject.adjustment.postings, authorId: initiatorId, justification: subject.adjustment.justification, discrepancyId: d.id, transactionId: d.transaction_id ?? undefined });
    }
    if (subject.follow === 'correct_transaction') await this.applyCorrection(tx, d, initiatorId, approverId);
    await this.resolve(tx, d.id, initiatorId, subject.decision, subject.follow !== 'none', entryId, approverId);
    await this.alerts.clear(`approval:discrepancy:${d.id}`, tx);
  }

  private async applyCorrection(tx: Tx, d: { id: string; transaction_id: string | null; observed: unknown; run_id: string }, actorId: string, approverId: string | null): Promise<void> {
    const observed = d.observed as { state?: string; provider_fee?: number; failure_reason?: string };
    const target = observed.state === 'succeeded' ? 'succeeded' : 'failed';
    await this.transactions.applyCorrection(tx, d.transaction_id!, target, {
      actualProviderFee: typeof observed.provider_fee === 'number' ? observed.provider_fee : null, discrepancyId: d.id, actorId, runId: d.run_id,
      failureReason: (observed.failure_reason as FailureReason | undefined) ?? 'PROVIDER_REJECTED',
    });
    await this.audit.record(tx, { actorId, action: 'transaction.corrected', subjectType: 'discrepancy', subjectId: d.id, next: { target }, approvedBy: approverId });
  }

  private async resolve(tx: Tx, id: string, actorId: string, decision: 'accepted' | 'rejected', adjustmentPosted: boolean, entryId: string | null, approverId: string | null, confirmationId?: string): Promise<void> {
    await tx.updateTable('discrepancy').set({ status: 'resolved', decision, adjustment_posted: adjustmentPosted, resolving_entry_id: entryId, resolved_by: actorId, approved_by: approverId, decided_at: sql`now()` }).where('id', '=', id).execute();
    await this.audit.record(tx, { actorId, action: 'discrepancy.resolve', subjectType: 'discrepancy', subjectId: id, next: { decision, adjustment_posted: adjustmentPosted, entry: entryId }, approvedBy: approverId, confirmationId });
    const d = await tx.selectFrom('discrepancy').select(['transaction_id']).where('id', '=', id).executeTakeFirstOrThrow();
    if (d.transaction_id && !adjustmentPosted) await tx.updateTable('transaction').set({ reconciliation_status: 'examined' }).where('id', '=', d.transaction_id).where('reconciliation_status', '=', 'disputed').execute();
  }

  async list(filters: { run?: string; type?: string; status?: string; assignee?: string; providerAccountId?: string; recurred?: boolean }, providerScope: string[] | null, limit = 100) {
    let q = this.db
      .selectFrom('discrepancy as d')
      .leftJoin('administrator as a', 'a.id', 'd.assignee_id')
      .leftJoin('transaction as t', 't.id', 'd.transaction_id')
      .selectAll('d')
      .select(['a.name as assignee_name', 't.reference as transaction_reference'])
      .orderBy('d.first_detected_at', 'desc')
      .limit(limit);
    if (providerScope) q = q.where('d.provider_account_id', 'in', providerScope.length ? providerScope : ['00000000-0000-0000-0000-000000000000']);
    if (filters.run) q = q.where('d.run_id', '=', filters.run);
    if (filters.type) q = q.where('d.type', '=', filters.type);
    if (filters.status) q = q.where('d.status', '=', filters.status);
    if (filters.assignee) q = q.where('d.assignee_id', '=', filters.assignee);
    if (filters.providerAccountId) q = q.where('d.provider_account_id', '=', filters.providerAccountId);
    if (filters.recurred) q = q.where('d.recurrences_after_resolution', '>', 0);
    return q.execute();
  }

  async detail(id: string) {
    const d = await this.db.selectFrom('discrepancy').selectAll().where('id', '=', id).executeTakeFirst();
    if (!d) throw new PlatformError('NOT_FOUND', 'No such discrepancy.');
    const comments = await this.db.selectFrom('discrepancy_comment as c').innerJoin('administrator as a', 'a.id', 'c.author_id').select(['c.id', 'c.body', 'c.created_at', 'a.name as author']).where('c.discrepancy_id', '=', id).orderBy('c.id').execute();
    const transaction = d.transaction_id ? await this.db.selectFrom('transaction').select(['reference', 'state', 'failure_reason', 'direction', 'requested_amount', 'currency_code', 'reconciliation_status']).where('id', '=', d.transaction_id).executeTakeFirst() : null;
    return { ...d, comments, transaction };
  }
}
