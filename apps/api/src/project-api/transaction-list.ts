import { z } from 'zod';
import type { Db } from '../db/database';
import type { TransactionReader } from '../transactions/transaction-reader';

export const listQuerySchema = z.object({
  project_reference: z.string().max(128).optional(),
  provider_reference: z.string().max(128).optional(),
  operator_reference: z.string().max(128).optional(),
  state: z.array(z.enum(['created', 'action_required', 'submitted', 'processing', 'succeeded', 'failed', 'expired', 'undetermined'])).optional(),
  direction: z.enum(['collection', 'disbursement']).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  payment_method: z.string().max(16).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

/** Cursor pagination (API reference 2.6): the cursor encodes the last row's creation time and id. */
export async function listTransactions(db: Db, reader: TransactionReader, projectId: string, q: ListQuery) {
  let query = db
    .selectFrom('transaction as t')
    .innerJoin('route as r', 'r.id', 't.route_id')
    .leftJoin('transaction_attempt as a', 'a.id', 't.current_attempt_id')
    .selectAll('t')
    .select(['r.country_code', 'r.payment_method_code', 'r.direction as route_direction', 'a.provider_reference', 'a.operator_reference'])
    .where('t.project_id', '=', projectId)
    .orderBy('t.created_at', 'desc')
    .orderBy('t.id', 'desc')
    .limit(q.limit + 1);
  if (q.project_reference) query = query.where('t.project_reference', '=', q.project_reference);
  if (q.provider_reference) query = query.where('a.provider_reference', '=', q.provider_reference);
  if (q.operator_reference) query = query.where('a.operator_reference', '=', q.operator_reference);
  if (q.state?.length) query = query.where('t.state', 'in', q.state);
  if (q.direction) query = query.where('t.direction', '=', q.direction);
  if (q.country) query = query.where('r.country_code', '=', q.country);
  if (q.payment_method) query = query.where('r.payment_method_code', '=', q.payment_method);
  if (q.currency) query = query.where('t.currency_code', '=', q.currency);
  if (q.created_after) query = query.where('t.created_at', '>', new Date(q.created_after));
  if (q.created_before) query = query.where('t.created_at', '<', new Date(q.created_before));
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (c) query = query.where((eb) => eb.or([eb('t.created_at', '<', c.at), eb.and([eb('t.created_at', '=', c.at), eb('t.id', '<', c.id)])]));
  }
  const rows = await query.execute();
  const page = rows.slice(0, q.limit);
  const data = page.map((row) => reader.toApi(row, row.provider_reference !== undefined ? ({ provider_reference: row.provider_reference, operator_reference: row.operator_reference } as never) : undefined, { country_code: row.country_code, payment_method_code: row.payment_method_code, direction: row.route_direction }, { revealMsisdn: true, revealAction: false }));
  const last = page[page.length - 1];
  return { data, next_cursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null, has_more: rows.length > q.limit };
}

export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, at: at.toISOString(), id })).toString('base64url');
}
export function decodeCursor(cursor: string): { at: Date; id: string } | null {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at: string; id: string };
    const at = new Date(c.at);
    if (Number.isNaN(at.getTime()) || typeof c.id !== 'string') return null;
    return { at, id: c.id };
  } catch {
    return null;
  }
}
