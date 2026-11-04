import { sql, type SelectQueryBuilder } from 'kysely';
import { z } from 'zod';
import { fieldInvalid } from '../common/errors';
import type { DB } from '../db/schema.generated';

/** The one query-string contract of every console list. Query-string values arrive as text, hence the coercion. */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().pipe(z.union([z.literal(25), z.literal(50), z.literal(100)])).default(25),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().max(128).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;
export type Page<T> = { data: T[]; total: number; page: number; page_size: number };

/** Escapes LIKE's own metacharacters so a search for `txn_` means those four characters, then anchors it as a prefix. */
export const prefixPattern = (q: string): string => q.replace(/[\\%_]/g, '\\$&') + '%';

/** The shortest search that matches a fragment; anything shorter keeps to the start of a reference (lists) or all of it (global search). */
export const FRAGMENT_MIN = 4;

/** Escapes LIKE's metacharacters, then wraps the text so it matches anywhere in a value. Compared as `lower(col) like lower(pattern)`. */
export const containsPattern = (q: string): string => '%' + q.replace(/[\\%_]/g, '\\$&') + '%';

/**
 * Pages a filtered select: the total counts the same query with selection and ordering cleared, and the page
 * orders by the requested key and then the id, both in the requested direction, so rows sharing a sort value
 * never repeat or vanish across pages. A page past the end is empty, not an error.
 */
export async function paginate<T>(
  // The table alias set differs per endpoint, so the builder's table parameter cannot be named here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: SelectQueryBuilder<DB, any, T>,
  p: PageQuery,
  opts: { sorts: Record<string, string>; defaultSort: string; id: string },
): Promise<Page<T>> {
  const key = p.sort ?? opts.defaultSort;
  // hasOwn: a key such as `constructor` must not resolve through the prototype.
  if (!Object.hasOwn(opts.sorts, key)) throw fieldInvalid('sort', `sort: must be one of ${Object.keys(opts.sorts).join(', ')}`);
  const column = opts.sorts[key]!;

  const counted = await query.clearSelect().clearOrderBy().select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow();
  const data = await query
    .orderBy(sql.ref(column), p.order)
    .orderBy(sql.ref(opts.id), p.order)
    .limit(p.page_size)
    .offset((p.page - 1) * p.page_size)
    .execute();
  return { data, total: Number((counted as { n: string }).n), page: p.page, page_size: p.page_size };
}
