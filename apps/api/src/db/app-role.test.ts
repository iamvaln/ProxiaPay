import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createTestContext, type TestContext } from '../test/context';
import { createPool } from './database';
import { appRoleFromEnv, ensureAppRole, grantAppRole } from './app-role';

const ROLE = 'proxiapay_app_test';
const PASSWORD = 'p@ss"word\'with;quotes';
let t: TestContext;
let owner: Pool;
let app: Pool;
let revoked: string[];

function asRole(): Pool {
  const u = new URL(process.env.DATABASE_URL!);
  u.username = ROLE; u.password = PASSWORD;
  return createPool(u.toString(), 2);
}

async function dropRole(): Promise<void> {
  await owner.query(`drop owned by ${ROLE}`).catch(() => {});
  await owner.query(`drop role if exists ${ROLE}`);
}

beforeAll(async () => {
  t = await createTestContext();
  owner = createPool(process.env.DATABASE_URL!, 2);
  await dropRole(); // a previous aborted run
  await ensureAppRole(owner, ROLE, PASSWORD);
  ({ revoked } = await grantAppRole(owner, ROLE));
  app = asRole();
  await t.reset();
});

afterAll(async () => {
  await app?.end();
  await owner.query('drop table if exists app_role_probe');
  await dropRole();
  await owner.end();
  await t.close();
});

describe('least-privilege app role', () => {
  it('the app role reads and writes ordinary tables', async () => {
    const admin = await t.admin();
    const { rows } = await app.query('insert into project (code, name, created_by) values ($1, $1, $2) returning id', ['roletest', admin.id]);
    await app.query('update project set name = $2 where id = $1', [rows[0].id, 'renamed']);
    expect((await app.query('select name from project where id = $1', [rows[0].id])).rows[0].name).toBe('renamed');
  });

  it('the app role cannot update or delete append-only rows', async () => {
    await t.admin();
    await expect(app.query('update ledger_entry set reference = reference')).rejects.toThrow(/permission denied/);
    await expect(app.query('delete from audit_record')).rejects.toThrow(/permission denied/);
    await expect(app.query('delete from route_version')).rejects.toThrow(/permission denied/);
    // close-only updates stay allowed: the privilege is there, the trigger polices which columns
    await expect(app.query('update route_version set id = id where false')).resolves.toBeDefined();
  });

  it('derives the revoke list from refuse_mutation triggers', () => {
    const both = ['ledger_entry', 'ledger_posting', 'ledger_checkpoint', 'transaction_event', 'audit_record', 'authentication_event',
      'discrepancy_comment', 'route_binding', 'ledger_account', 'route'];
    const expected = [...both.flatMap((x) => [`${x}:UPDATE`, `${x}:DELETE`]), 'route_version:DELETE', 'entitlement_version:DELETE'];
    expect([...revoked].sort()).toEqual(expected.sort());
    expect(revoked).not.toContain('route_version:UPDATE');
  });

  it('a table created by a later migration is granted to the app role', async () => {
    await owner.query('create table app_role_probe (id int primary key)');
    await expect(app.query('insert into app_role_probe values (1)')).rejects.toThrow(/permission denied/);
    await grantAppRole(owner, ROLE);
    await app.query('insert into app_role_probe values (1)');
  });

  it('migrate refuses half an app-role configuration', () => {
    expect(() => appRoleFromEnv({ APP_DB_ROLE: 'x' })).toThrow(/together/);
    expect(() => appRoleFromEnv({ APP_DB_PASSWORD: 'x' })).toThrow(/together/);
    expect(appRoleFromEnv({})).toBeNull();
    expect(appRoleFromEnv({ APP_DB_ROLE: 'r', APP_DB_PASSWORD: 'p' })).toEqual({ role: 'r', password: 'p' });
  });
});
