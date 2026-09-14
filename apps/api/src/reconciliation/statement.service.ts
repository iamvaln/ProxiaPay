import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db } from '../db/database';
import { AuditService } from '../audit/audit.service';
import { parseStatement } from './statement-format';

/**
 * Statement upload (spec 9.3): parsed against the provider's declared format, checksummed so
 * one file is never processed twice, and checked against the period it claims to cover.
 */
@Injectable()
export class StatementService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly audit: AuditService) {}

  async upload(args: { providerAccountId: string; filename: string; content: Buffer; periodStart: Date; periodEnd: Date; uploadedBy: string }) {
    if (args.content.length > 25 * 1024 * 1024) throw new PlatformError('FIELD_INVALID', 'The statement exceeds 25 MB.', { field: 'file' });
    if (!(args.periodEnd > args.periodStart)) throw new PlatformError('FIELD_INVALID', 'The period end must follow its start.', { field: 'period_end' });
    const account = await this.db.selectFrom('provider_account').select(['id', 'statement_format']).where('id', '=', args.providerAccountId).executeTakeFirst();
    if (!account) throw new PlatformError('NOT_FOUND', 'No such provider account.');
    if (!account.statement_format) throw new PlatformError('RULE_VIOLATION', 'This provider account declares no statement format.');
    const checksum = createHash('sha256').update(args.content).digest();
    const dup = await this.db.selectFrom('statement_import').select(['id', 'created_at']).where('checksum', '=', checksum).executeTakeFirst();
    if (dup) throw new PlatformError('CONFLICT', 'This file was already uploaded.', { details: { import: dup.id, uploaded_at: dup.created_at.toISOString() } });
    const currencies = new Map((await this.db.selectFrom('currency').select(['code', 'exponent']).execute()).map((c) => [c.code, c.exponent]));
    const parsed = parseStatement(account.statement_format, args.content.toString('utf8'), (c) => currencies.get(c));
    const dates = parsed.rows.map((r) => r.occurredAt).filter((d): d is Date => d != null);
    const observedStart = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
    const observedEnd = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    const periodDisagrees = (observedStart && observedStart < args.periodStart) || (observedEnd && observedEnd > args.periodEnd);
    const row = await this.db.transaction().execute(async (tx) => {
      const imp = await tx
        .insertInto('statement_import')
        .values({
          provider_account_id: account.id, filename: args.filename.slice(0, 256), checksum, declared_period_start: args.periodStart, declared_period_end: args.periodEnd,
          observed_period_start: observedStart, observed_period_end: observedEnd, row_count: parsed.rows.length, rows_rejected: parsed.rejected.length,
          rejected_rows: JSON.stringify(parsed.rejected.slice(0, 200)), uploaded_by: args.uploadedBy,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (parsed.rows.length) {
        for (let i = 0; i < parsed.rows.length; i += 500) {
          await tx.insertInto('statement_row').values(parsed.rows.slice(i, i + 500).map((r) => ({
            import_id: imp.id, row_number: r.rowNumber, provider_reference: r.providerReference, external_reference: r.externalReference, direction: r.direction,
            amount: r.amount, fee: r.fee, currency_code: r.currency, status: r.status, occurred_at: r.occurredAt, raw: JSON.stringify(r.raw),
          }))).execute();
        }
      }
      await this.audit.record(tx, { actorId: args.uploadedBy, action: 'statement.upload', subjectType: 'statement_import', subjectId: imp.id, next: { provider_account_id: account.id, filename: args.filename, rows: parsed.rows.length, rejected: parsed.rejected.length } });
      return imp;
    });
    return { import: row, rejected: parsed.rejected, period_disagrees: Boolean(periodDisagrees), observed_period: { start: observedStart, end: observedEnd } };
  }

  async get(importId: string) {
    return this.db.selectFrom('statement_import').selectAll().where('id', '=', importId).executeTakeFirst();
  }

  async list(providerScope: string[] | null, limit = 50) {
    let q = this.db.selectFrom('statement_import').selectAll().orderBy('created_at', 'desc').limit(limit);
    if (providerScope) q = q.where('provider_account_id', 'in', providerScope.length ? providerScope : ['00000000-0000-0000-0000-000000000000']);
    return q.execute();
  }
}
