import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { CONFIG, type AppConfig } from '../config/config';
import { DB_TOKEN, type Db } from '../db/database';
import { newExportReference } from '../crypto/references';
import { PlatformError } from '../common/errors';

/**
 * Exports carry a provenance block and a signature over the rows (console spec 3.3, 10.4),
 * and the platform keeps a record of each, so a file circulating for weeks can be checked
 * against what was actually produced. The signing key derives from the master key.
 */
@Injectable()
export class ExportService {
  private readonly key: Buffer;
  constructor(@Inject(DB_TOKEN) private readonly db: Db, @Inject(CONFIG) private readonly config: Pick<AppConfig, 'MASTER_KEY_BASE64' | 'PROXIAPAY_ENV'>) {
    this.key = createHmac('sha256', config.MASTER_KEY_BASE64).update('proxiapay:export-signing').digest();
  }

  static csvRows(columns: string[], rows: Record<string, unknown>[]): string {
    const esc = (v: unknown) => {
      const s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
  }

  async produce(administratorId: string, subject: string, filters: Record<string, unknown>, columns: string[], rows: Record<string, unknown>[]): Promise<{ export_id: string; csv: string; row_count: number }> {
    const body = ExportService.csvRows(columns, rows);
    const signature = createHmac('sha256', this.key).update(body).digest('hex');
    const exportId = newExportReference();
    const admin = await this.db.selectFrom('administrator').select('email').where('id', '=', administratorId).executeTakeFirstOrThrow();
    const record = await this.db.insertInto('export_record').values({ administrator_id: administratorId, subject, filters: JSON.stringify(filters), row_count: rows.length, environment: this.config.PROXIAPAY_ENV, signature }).returning(['id', 'created_at']).executeTakeFirstOrThrow();
    const block = [
      `# ProxiaPay export ${exportId}`, `# record: ${record.id}`, `# requested_by: ${admin.email}`, `# at: ${record.created_at.toISOString()}`, `# environment: ${this.config.PROXIAPAY_ENV}`,
      `# subject: ${subject}`, `# filters: ${JSON.stringify(filters)}`, `# rows: ${rows.length}`, `# signature: sha256-hmac ${signature}`, '',
    ].join('\n');
    return { export_id: record.id, csv: block + body, row_count: rows.length };
  }

  /** Verifies a file or an identifier alone against the record kept (console spec 10.4). */
  async verify(input: { export_id?: string; content?: string }) {
    let recordId = input.export_id;
    let body: string | undefined;
    if (input.content) {
      const lines = input.content.split('\n');
      const header = lines.filter((l) => l.startsWith('# '));
      recordId = recordId ?? header.find((l) => l.startsWith('# record: '))?.slice('# record: '.length).trim();
      body = lines.filter((l) => !l.startsWith('# ')).join('\n').replace(/^\n/, '');
    }
    if (!recordId) throw new PlatformError('FIELD_INVALID', 'Provide an export identifier or the file.', { field: 'export_id' });
    const record = await this.db.selectFrom('export_record as e').innerJoin('administrator as a', 'a.id', 'e.administrator_id').selectAll('e').select('a.email as requested_by').where('e.id', '=', recordId).executeTakeFirst();
    if (!record) return { known: false };
    const rowsUnchanged = body === undefined ? null : createHmac('sha256', this.key).update(body).digest('hex') === record.signature;
    return { known: true, record: { id: record.id, requested_by: record.requested_by, at: record.created_at, environment: record.environment, subject: record.subject, filters: record.filters, row_count: record.row_count }, rows_unchanged: rowsUnchanged };
  }

  async history(limit = 100) {
    return this.db.selectFrom('export_record as e').innerJoin('administrator as a', 'a.id', 'e.administrator_id').selectAll('e').select('a.email as requested_by').orderBy('e.created_at', 'desc').limit(limit).execute();
  }
}
