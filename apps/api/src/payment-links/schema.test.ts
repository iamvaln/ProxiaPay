import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, testDb, truncateAll } from '../test/db';
import type { Db } from '../db/database';
import { seedReferenceData } from '../seed/seed';

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(() => closeTestDb());
beforeEach(async () => { await truncateAll(db); await seedReferenceData(db, { withRoutes: false }); });

const holders = async (key: string) =>
  (await db.selectFrom('role_permission as rp').innerJoin('role as r', 'r.id', 'rp.role_id').select('r.name').where('rp.permission_key', '=', key).execute()).map((r) => r.name).sort();

async function project() {
  const admin = await db.insertInto('administrator').values({ name: 'A', email: 'a@example.com', password_hash: null }).returning('id').executeTakeFirstOrThrow();
  const p = await db.insertInto('project').values({ code: 'shop', name: 'Shop' }).returning('id').executeTakeFirstOrThrow();
  return { adminId: admin.id, projectId: p.id };
}

async function link(over: Record<string, unknown>) {
  // The project is made once per test: a second link in the same test reuses it.
  const existing = await db.selectFrom('project').select('id').executeTakeFirst();
  const { adminId, projectId } = existing
    ? { adminId: (await db.selectFrom('administrator').select('id').executeTakeFirstOrThrow()).id, projectId: existing.id }
    : await project();
  return db.insertInto('payment_link').values({
    code: 'abc', project_id: projectId, title: 'Donate', currency_code: 'XAF', amount_type: 'free', primary_color: '#112233', created_by: adminId, ...over,
  } as never).execute();
}

describe('payment link schema', () => {
  it('gives links.manage to Owner and Client owner only', async () => {
    expect(await holders('links.manage')).toEqual(['Client owner', 'Owner']);
  });

  it('refuses a fixed link without an amount', async () => {
    await expect(link({ amount_type: 'fixed', amount: null })).rejects.toThrow();
  });

  it('refuses a free link with an amount', async () => {
    await expect(link({ amount_type: 'free', amount: 1000 })).rejects.toThrow();
  });

  it('accepts a fixed link with an amount and a free link without', async () => {
    await link({ amount_type: 'fixed', amount: 1000 });
    await db.deleteFrom('payment_link').execute();
    await link({ amount_type: 'free', amount: null });
    expect(await db.selectFrom('payment_link').select(['amount', 'minimum_amount']).execute()).toEqual([{ amount: null, minimum_amount: 0 }]);
  });

  it('refuses a zero or negative amount and a negative minimum', async () => {
    await expect(link({ amount_type: 'fixed', amount: 0 })).rejects.toThrow();
    await expect(link({ amount_type: 'fixed', amount: -5 })).rejects.toThrow();
    await expect(link({ amount_type: 'free', amount: null, minimum_amount: -1 })).rejects.toThrow();
  });

  it('refuses an SVG brand asset', async () => {
    const { projectId } = await project();
    await expect(db.insertInto('brand_asset').values({ project_id: projectId, bytes: Buffer.from('x'), content_type: 'image/svg+xml', sha256: 'x' }).execute()).rejects.toThrow();
  });
});
