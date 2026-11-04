import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { paginate, pageQuerySchema, prefixPattern } from './pagination';

let t: TestContext;
beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(() => t.reset());

const sorts = { occurred_at: 'a.occurred_at', subject: 'a.subject_id' };
const opts = { sorts, defaultSort: 'occurred_at', id: 'a.id' };
const base = () => t.db.selectFrom('audit_record as a').select(['a.id', 'a.subject_id']);
const q = (over: Record<string, unknown> = {}) => pageQuerySchema.parse(over);

async function seed(n: number, subject = (i: number) => `s${i}`, at: Date | ((i: number) => Date) = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i))) {
  await t.db.insertInto('audit_record').values(Array.from({ length: n }, (_, i) => ({
    action: 'test.seed', subject_type: 'test', subject_id: subject(i), occurred_at: typeof at === 'function' ? at(i) : at,
  }))).execute();
}

describe('paginate', () => {
  it('returns one page, the total, and the page asked for', async () => {
    await seed(60);
    const r = await paginate(base(), q({ page: 2, page_size: 25 }), opts);
    expect(r.data).toHaveLength(25);
    expect(r).toMatchObject({ total: 60, page: 2, page_size: 25 });
  });

  it('returns an empty page past the end with the true total', async () => {
    await seed(60);
    const r = await paginate(base(), q({ page: 9 }), opts);
    expect(r.data).toEqual([]);
    expect(r.total).toBe(60);
  });

  it('refuses a sort key outside the allow-list', async () => {
    await expect(paginate(base(), q({ sort: 'nope' }), opts)).rejects.toMatchObject({ code: 'FIELD_INVALID', options: { field: 'sort' } });
  });

  it('ties broken by id give a stable order', async () => {
    await seed(30, (i) => `s${i}`, new Date(Date.UTC(2026, 0, 1)));
    const one = await paginate(base(), q({ page: 1, page_size: 25 }), opts);
    const two = await paginate(base(), q({ page: 2, page_size: 25 }), opts);
    const ids = [...one.data, ...two.data].map((r) => r.id);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  it('orders by the requested key in the requested direction', async () => {
    await seed(3);
    const r = await paginate(base(), q({ sort: 'subject', order: 'asc' }), opts);
    expect(r.data.map((x) => x.subject_id)).toEqual(['s0', 's1', 's2']);
  });

  it('escapes LIKE wildcards in a prefix search', async () => {
    expect(prefixPattern('txn_%')).toBe('txn\\_\\%%');
    expect(prefixPattern('a\\b')).toBe('a\\\\b%');
    await seed(1, () => 'txnA');
    const r = await paginate(base().where('a.subject_id', 'like', prefixPattern('txn_')), q(), opts);
    expect(r.total).toBe(0);
  });

  it('counts with the same filters as the page', async () => {
    await seed(40, (i) => (i < 12 ? `keep${i}` : `drop${i}`));
    const r = await paginate(base().where('a.subject_id', 'like', prefixPattern('keep')), q(), opts);
    expect(r.total).toBe(12);
    expect(r.data).toHaveLength(12);
  });
});

describe('pageQuerySchema', () => {
  it('applies defaults and rejects bad sizes', () => {
    expect(q()).toEqual({ page: 1, page_size: 25, order: 'desc' });
    expect(() => q({ page_size: 30 })).toThrow();
    expect(() => q({ page: 0 })).toThrow();
    expect(() => q({ q: 'x'.repeat(129) })).toThrow();
    expect(q({ page: '3', page_size: '50' })).toMatchObject({ page: 3, page_size: 50 });
  });
});
