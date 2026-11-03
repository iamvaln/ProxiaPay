import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestContext, type TestContext } from '../test/context';
import { createPool } from './database';
import { ensureAppRole, grantAppRole } from './app-role';
import { assertLeastPrivilegeRole } from './production-guard';

const ROLE = 'proxiapay_guard_test';
const PASSWORD = 'guard-test-password';
let t: TestContext;
let owner: Pool;
let app: Pool;

async function dropRole(): Promise<void> {
  await owner.query(`drop owned by ${ROLE}`).catch(() => {});
  await owner.query(`drop role if exists ${ROLE}`);
}

beforeAll(async () => {
  t = await createTestContext();
  owner = createPool(process.env.DATABASE_URL!, 2);
  await dropRole();
  await ensureAppRole(owner, ROLE, PASSWORD);
  await grantAppRole(owner, ROLE);
  const u = new URL(process.env.DATABASE_URL!);
  u.username = ROLE; u.password = PASSWORD;
  app = createPool(u.toString(), 2);
});

afterAll(async () => {
  await app?.end();
  await dropRole();
  await owner.end();
  await t.close();
});

describe('the production start-up guard', () => {
  it('refuses the owner (a superuser) in production', async () => {
    await expect(assertLeastPrivilegeRole(owner, 'production')).rejects.toThrow(/refusing to start in production.*superuser/);
  });

  it('refuses a non-superuser that can update the ledger', async () => {
    await owner.query(`create role ${ROLE}_rw login password '${PASSWORD}'`);
    try {
      await owner.query(`grant connect on database ${(await owner.query('select current_database() d')).rows[0].d} to ${ROLE}_rw`);
      await owner.query(`grant usage on schema public to ${ROLE}_rw`);
      await owner.query(`grant update on ledger_entry to ${ROLE}_rw`);
      const u = new URL(process.env.DATABASE_URL!);
      u.username = `${ROLE}_rw`; u.password = PASSWORD;
      const rw = createPool(u.toString(), 1);
      try {
        await expect(assertLeastPrivilegeRole(rw, 'production')).rejects.toThrow(/can UPDATE ledger_entry/);
      } finally { await rw.end(); }
    } finally {
      await owner.query(`drop owned by ${ROLE}_rw`);
      await owner.query(`drop role ${ROLE}_rw`);
    }
  });

  it('allows the owner in the sandbox', async () => {
    await expect(assertLeastPrivilegeRole(owner, 'sandbox')).resolves.toBeUndefined();
  });

  it('allows the app role in production', async () => {
    await expect(assertLeastPrivilegeRole(app, 'production')).resolves.toBeUndefined();
  });
});
