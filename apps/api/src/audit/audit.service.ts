import { Injectable } from '@nestjs/common';
import type { Executor } from '../db/database';
import { requestContext } from '../logging/logger';

export interface AuditInput {
  actorId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  prior?: unknown;
  next?: unknown;
  confirmationId?: string | null;
  approvedBy?: string | null;
}

/** Every configuration change and treasury action, with actor, time, and before and after state (spec 8.1). */
@Injectable()
export class AuditService {
  async record(exec: Executor, input: AuditInput): Promise<number> {
    const row = await exec
      .insertInto('audit_record')
      .values({
        actor_id: input.actorId,
        action: input.action,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        prior_state: input.prior === undefined ? null : JSON.stringify(input.prior),
        new_state: input.next === undefined ? null : JSON.stringify(input.next),
        confirmation_id: input.confirmationId ?? null,
        approved_by: input.approvedBy ?? null,
        correlation_id: requestContext.getStore()?.requestId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}
