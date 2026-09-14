import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { closeTestDb, testDb, truncateAll } from '../test/db';
import type { Db } from '../db/database';
import { InsufficientBalanceError, LedgerService } from './ledger.service';
import { seedReferenceData } from '../seed/seed';

let db: Db;
let ledger: LedgerService;
let projectId: string;
let providerAccountId: string;

beforeAll(async () => {
  db = await testDb();
  ledger = new LedgerService(db);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await truncateAll(db);
  await seedReferenceData(db, { withRoutes: false });
  projectId = (await db.insertInto('project').values({ code: 'shop', name: 'Shop' }).returning('id').executeTakeFirstOrThrow()).id;
  providerAccountId = (await db.selectFrom('provider_account').select('id').executeTakeFirstOrThrow()).id;
});

const fees = { requested: 1000, processingFee: 25, platformFee: 5, processingBearer: 'counterparty' as const, platformBearer: 'counterparty' as const, actualProviderFee: 20 };

describe('ledger', () => {
  it('posts the worked collection of spec 6.1 with five postings', async () => {
    await db.transaction().execute(async (tx) => {
      const float = await ledger.getOrCreateAccount(tx, { type: 'float', providerAccountId, countryCode: 'CM', currency: 'XAF', direction: 'collection' });
      const entryId = await ledger.postCollection(tx, { transactionId: null as unknown as string, projectId, currency: 'XAF', floatAccountId: float, fees });
      const postings = await tx.selectFrom('ledger_posting').selectAll().where('entry_id', '=', entryId).execute();
      expect(postings).toHaveLength(5);
    });
    expect(await ledger.balanceByKey(db, { type: 'float', providerAccountId, countryCode: 'CM', currency: 'XAF', direction: 'collection' })).toBe(1010);
    expect(await ledger.balanceByKey(db, { type: 'project_available', projectId, currency: 'XAF' })).toBe(1000);
    expect(await ledger.balanceByKey(db, { type: 'processing_revenue', currency: 'XAF' })).toBe(25);
    expect(await ledger.balanceByKey(db, { type: 'platform_revenue', currency: 'XAF' })).toBe(5);
    expect(await ledger.balanceByKey(db, { type: 'fee_expense', currency: 'XAF' })).toBe(20);
  });

  it('omits the platform posting where the fee is zero', async () => {
    await db.transaction().execute(async (tx) => {
      const float = await ledger.getOrCreateAccount(tx, { type: 'float', providerAccountId, countryCode: 'CM', currency: 'XAF', direction: 'collection' });
      const entryId = await ledger.postCollection(tx, { transactionId: null as unknown as string, projectId, currency: 'XAF', floatAccountId: float, fees: { ...fees, platformFee: 0 } });
      const postings = await tx.selectFrom('ledger_posting').selectAll().where('entry_id', '=', entryId).execute();
      expect(postings).toHaveLength(4);
    });
  });

  it('refuses an adjustment without an author, and an unbalanced entry, in the store itself', async () => {
    const a = await ledger.getOrCreateAccount(db, { type: 'business_capital', currency: 'XAF' });
    const b = await ledger.getOrCreateAccount(db, { type: 'suspense', currency: 'XAF' });
    await expect(db.insertInto('ledger_entry').values({ entry_type: 'adjustment', author_id: null, justification: 'x' }).execute()).rejects.toThrow(/check constraint/);
    await expect(
      db.transaction().execute(async (tx) => {
        const e = await tx.insertInto('ledger_entry').values({ entry_type: 'collection' }).returning('id').executeTakeFirstOrThrow();
        await tx.insertInto('ledger_posting').values([
          { entry_id: e.id, account_id: a, side: 'debit', amount: 100 },
          { entry_id: e.id, account_id: b, side: 'credit', amount: 90 },
        ]).execute();
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it('never updates or deletes an entry or posting', async () => {
    const a = await ledger.getOrCreateAccount(db, { type: 'business_capital', currency: 'XAF' });
    const b = await ledger.getOrCreateAccount(db, { type: 'suspense', currency: 'XAF' });
    const entryId = await db.transaction().execute((tx) => ledger.post(tx, { entryType: 'collection', postings: [{ accountId: a, side: 'debit', amount: 5 }, { accountId: b, side: 'credit', amount: 5 }] }));
    await expect(db.updateTable('ledger_posting').set({ amount: 6 }).where('entry_id', '=', entryId).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('ledger_entry').where('id', '=', entryId).execute()).rejects.toThrow(/append-only/);
  });

  it('reserves under lock and refuses to overdraw', async () => {
    await db.transaction().execute((tx) => ledger.postProjectFunding(tx, { projectId, currency: 'XAF', amount: 1500, authorId: null as unknown as string, justification: 'seed' }).catch(() => undefined));
    // funding needs an author; create one
    const admin = await db.insertInto('administrator').values({ name: 'A', email: 'a@x.io', password_hash: 'x' }).returning('id').executeTakeFirstOrThrow();
    await db.transaction().execute((tx) => ledger.postProjectFunding(tx, { projectId, currency: 'XAF', amount: 1500, authorId: admin.id, justification: 'seed' }));
    await db.transaction().execute((tx) => ledger.reserve(tx, { transactionId: null as unknown as string, projectId, currency: 'XAF', amount: 1000 }));
    await expect(db.transaction().execute((tx) => ledger.reserve(tx, { transactionId: null as unknown as string, projectId, currency: 'XAF', amount: 600 }))).rejects.toBeInstanceOf(InsufficientBalanceError);
    const balances = await ledger.projectBalances(db, projectId);
    expect(balances).toEqual([{ currency: 'XAF', available: 500, reserved: 1000 }]);
  });

  it('settles a recipient-borne disbursement per spec 6.1: project debited 1000, float falls 990', async () => {
    const admin = await db.insertInto('administrator').values({ name: 'A', email: 'a@x.io', password_hash: 'x' }).returning('id').executeTakeFirstOrThrow();
    const float = await ledger.getOrCreateAccount(db, { type: 'float', providerAccountId, countryCode: 'CM', currency: 'XAF', direction: 'disbursement' });
    await db.transaction().execute(async (tx) => {
      await ledger.postFloatFunding(tx, { floatAccountId: float, currency: 'XAF', amount: 5000, authorId: admin.id, justification: 'capital' });
      await ledger.postProjectFunding(tx, { projectId, currency: 'XAF', amount: 5000, authorId: admin.id, justification: 'grant' });
      await ledger.reserve(tx, { transactionId: null as unknown as string, projectId, currency: 'XAF', amount: 1000 });
      await ledger.settleDisbursement(tx, { transactionId: null as unknown as string, projectId, currency: 'XAF', floatAccountId: float, fees, from: 'reserved' });
    });
    expect(await ledger.balance(db, float)).toBe(5000 - 990);
    expect(await ledger.projectBalances(db, projectId)).toEqual([{ currency: 'XAF', available: 4000, reserved: 0 }]);
    expect(await ledger.balanceByKey(db, { type: 'processing_revenue', currency: 'XAF' })).toBe(25);
    expect(await ledger.balanceByKey(db, { type: 'fee_expense', currency: 'XAF' })).toBe(20);
    const cov = await ledger.coverage(db, 'XAF');
    expect(cov.float).toBe(4010);
    expect(cov.encumbered).toBe(4000);
  });

  it('suspends, then settles from suspense or releases back', async () => {
    const admin = await db.insertInto('administrator').values({ name: 'A', email: 'a@x.io', password_hash: 'x' }).returning('id').executeTakeFirstOrThrow();
    await db.transaction().execute(async (tx) => {
      await ledger.postProjectFunding(tx, { projectId, currency: 'XAF', amount: 3000, authorId: admin.id, justification: 'grant' });
      await ledger.reserve(tx, { transactionId: null as unknown as string, projectId, currency: 'XAF', amount: 1000 });
      await ledger.suspendReservation(tx, { transactionId: null as unknown as string, projectId, currency: 'XAF', amount: 1000 });
    });
    expect(await ledger.balanceByKey(db, { type: 'suspense', currency: 'XAF' })).toBe(1000);
    expect(await ledger.projectBalances(db, projectId)).toEqual([{ currency: 'XAF', available: 2000, reserved: 0 }]);
    await db.transaction().execute((tx) => ledger.releaseReservation(tx, { transactionId: null as unknown as string, projectId, currency: 'XAF', amount: 1000, from: 'suspense' }));
    expect(await ledger.balanceByKey(db, { type: 'suspense', currency: 'XAF' })).toBe(0);
    expect(await ledger.projectBalances(db, projectId)).toEqual([{ currency: 'XAF', available: 3000, reserved: 0 }]);
  });

  it('checkpoints and keeps reading the same balance; reversal offsets an entry', async () => {
    const admin = await db.insertInto('administrator').values({ name: 'A', email: 'a@x.io', password_hash: 'x' }).returning('id').executeTakeFirstOrThrow();
    const entryId = await db.transaction().execute((tx) => ledger.postProjectFunding(tx, { projectId, currency: 'XAF', amount: 700, authorId: admin.id, justification: 'grant' }));
    const acct = (await ledger.findAccount(db, { type: 'project_available', projectId, currency: 'XAF' }))!;
    await db.transaction().execute((tx) => ledger.checkpoint(tx, acct));
    await db.transaction().execute((tx) => ledger.postProjectFunding(tx, { projectId, currency: 'XAF', amount: 300, authorId: admin.id, justification: 'grant' }));
    expect(await ledger.balance(db, acct)).toBe(1000);
    expect(await ledger.verifyCheckpoints(db)).toEqual([]);
    await db.transaction().execute((tx) => ledger.reverse(tx, entryId, admin.id, 'posted in error'));
    expect(await ledger.balance(db, acct)).toBe(300);
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from ledger_entry where entry_type = 'reversal' and reverses_entry_id = ${entryId}`.execute(db);
    expect(rows[0]!.n).toBe(1);
  });

  it('concurrent reservations never jointly exceed the balance', async () => {
    const admin = await db.insertInto('administrator').values({ name: 'A', email: 'a@x.io', password_hash: 'x' }).returning('id').executeTakeFirstOrThrow();
    await db.transaction().execute((tx) => ledger.postProjectFunding(tx, { projectId, currency: 'XAF', amount: 1000, authorId: admin.id, justification: 'grant' }));
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => db.transaction().execute((tx) => ledger.reserve(tx, { transactionId: null as unknown as string, projectId, currency: 'XAF', amount: 300 }))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(3);
    expect(await ledger.projectBalances(db, projectId)).toEqual([{ currency: 'XAF', available: 100, reserved: 900 }]);
  });
});
