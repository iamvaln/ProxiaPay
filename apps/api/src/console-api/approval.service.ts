import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db, type Tx } from '../db/database';
import { LedgerService, type Posting } from '../ledger/ledger.service';
import { TreasuryService } from '../treasury/treasury.service';
import { DiscrepancyService } from '../reconciliation/discrepancy.service';
import { AuditService } from '../audit/audit.service';
import { AlertService } from '../alerts/alert.service';
import { RoleService } from './role.service';

/**
 * The approval queue (console spec 4.3, 11.2). Approving executes the request as the initiator
 * framed it; declining records the reason and leaves everything unchanged. The platform refuses
 * an approval from the initiator, whatever permissions they hold.
 */
@Injectable()
export class ApprovalService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly treasury: TreasuryService,
    private readonly discrepancies: DiscrepancyService,
    private readonly roles: RoleService,
    private readonly audit: AuditService,
    private readonly alerts: AlertService,
  ) {}

  async pending(administratorId: string, permissions: string[]) {
    const rows = await this.db
      .selectFrom('approval_request as r')
      .innerJoin('administrator as a', 'a.id', 'r.initiated_by')
      .selectAll('r')
      .select(['a.name as initiator_name'])
      .where('r.status', '=', 'pending')
      .orderBy('r.created_at')
      .execute();
    return rows.map((r) => ({ ...r, own: r.initiated_by === administratorId, can_act: r.initiated_by !== administratorId && permissions.includes(APPROVE_PERMISSION[r.type] ?? '') }));
  }

  async decide(id: string, approverId: string, decision: 'approve' | 'decline', reason: string, permissions: string[], confirmationId?: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const r = await tx.selectFrom('approval_request').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      if (r.status !== 'pending') throw new PlatformError('CONFLICT', 'The request was already decided.');
      if (r.initiated_by === approverId) throw new PlatformError('PERMISSION_DENIED', 'The approver is a different person from the initiator.');
      const needed = APPROVE_PERMISSION[r.type];
      if (!needed || !permissions.includes(needed)) throw new PlatformError('PERMISSION_DENIED', `This approval requires the permission "${needed}".`, { details: { permission: needed } });
      if (decision === 'approve') await this.execute(tx, r.type, r.subject as Record<string, unknown>, r.initiated_by, approverId);
      else if (!reason.trim()) throw new PlatformError('FIELD_INVALID', 'Declining requires a reason.', { field: 'reason' });
      await tx.updateTable('approval_request').set({ status: decision === 'approve' ? 'approved' : 'declined', decided_by: approverId, decision_reason: reason, decided_at: sql`now()` }).where('id', '=', id).execute();
      await this.audit.record(tx, { actorId: approverId, action: `approval.${decision}`, subjectType: 'approval_request', subjectId: id, prior: { type: r.type, initiated_by: r.initiated_by }, next: { decision, reason }, confirmationId, approvedBy: decision === 'approve' ? approverId : null });
      const subject = r.subject as Record<string, unknown>;
      for (const fp of [`approval:cashout:${subject.cashout_id}`, `approval:discrepancy:${subject.discrepancy_id}`, `approval:role:${subject.role_id}`, `approval:adjustment:${id}`]) await this.alerts.clear(fp, tx);
    });
  }

  private async execute(tx: Tx, type: string, subject: Record<string, unknown>, initiatorId: string, approverId: string): Promise<void> {
    switch (type) {
      case 'cashout':
        await this.treasury.executeCashout(tx, String(subject.cashout_id), approverId);
        return;
      case 'adjustment': {
        const postings = subject.postings as Posting[];
        const entryId = await this.ledger.postAdjustment(tx, { postings, authorId: initiatorId, justification: String(subject.justification), discrepancyId: subject.discrepancy_id ? String(subject.discrepancy_id) : undefined, reference: subject.reference ? String(subject.reference) : undefined });
        await this.audit.record(tx, { actorId: initiatorId, action: 'adjustment.post', subjectType: 'ledger_entry', subjectId: entryId, next: subject, approvedBy: approverId });
        return;
      }
      case 'discrepancy_resolution':
        await this.discrepancies.executeApproved(tx, subject as never, initiatorId, approverId);
        return;
      case 'role_change':
        await this.roles.applyChange(tx, subject as never, initiatorId, approverId);
        return;
      default:
        throw new PlatformError('RULE_VIOLATION', `Unknown approval type ${type}.`);
    }
  }
}

const APPROVE_PERMISSION: Record<string, string> = {
  cashout: 'treasury.cashout.approve',
  adjustment: 'treasury.adjustment.approve',
  discrepancy_resolution: 'reconciliation.approve_adjustment',
  role_change: 'admin.roles',
};
