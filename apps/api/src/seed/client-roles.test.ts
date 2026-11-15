import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, testDb, truncateAll } from '../test/db';
import type { Db } from '../db/database';
import { seedReferenceData } from './seed';
import { CLIENT_ONLY_PERMISSIONS, CLIENT_ROLES, PLATFORM_PERMISSIONS } from '../permissions/permissions';

let db: Db;
beforeAll(async () => { db = await testDb(); });
afterAll(() => closeTestDb());
beforeEach(async () => { await truncateAll(db); await seedReferenceData(db, { withRoutes: false }); });

const permissionsOf = async (name: string) =>
  (await db.selectFrom('role_permission as rp').innerJoin('role as r', 'r.id', 'rp.role_id').select('rp.permission_key').where('r.name', '=', name).execute())
    .map((p) => p.permission_key).sort();

describe('client roles', () => {
  it('seeds the three client roles with exactly their permissions', async () => {
    const roles = await db.selectFrom('role').select(['name', 'kind', 'seeded']).where('kind', '=', 'client').orderBy('name').execute();
    expect(roles).toEqual([
      { name: 'Client developer', kind: 'client', seeded: true },
      { name: 'Client finance', kind: 'client', seeded: true },
      { name: 'Client owner', kind: 'client', seeded: true },
    ]);
    expect(await permissionsOf('Client owner')).toEqual(['client.members', 'links.manage', 'oversight.export', 'projects.create_own', 'projects.credentials', 'projects.notifications',
      'projects.origins', 'projects.read', 'transactions.read', 'treasury.read_balances']);
    expect(await permissionsOf('Client developer')).toEqual(['projects.credentials', 'projects.notifications', 'projects.origins', 'projects.read', 'transactions.read', 'treasury.read_balances']);
    expect(await permissionsOf('Client finance')).toEqual(['oversight.export', 'projects.read', 'transactions.read', 'treasury.read_balances']);
    expect(CLIENT_ROLES.map((r) => r.profile)).toEqual(['owner', 'developer', 'finance']);
  });

  it('keeps platform roles platform, and Owner without the client-only permissions', async () => {
    expect((await db.selectFrom('role').select('kind').where('name', '=', 'Owner').executeTakeFirstOrThrow()).kind).toBe('platform');
    const owner = await permissionsOf('Owner');
    expect(owner).toContain('admin.clients');
    for (const p of CLIENT_ONLY_PERMISSIONS) expect(owner).not.toContain(p);
    expect(owner).toEqual([...PLATFORM_PERMISSIONS].sort());
  });

  it('refuses a client-scoped assignment without a membership', async () => {
    const admin = await db.insertInto('administrator').values({ name: 'A', email: 'a@example.com', password_hash: null }).returning('id').executeTakeFirstOrThrow();
    const role = await db.selectFrom('role').select('id').where('name', '=', 'Client owner').executeTakeFirstOrThrow();
    await expect(db.insertInto('role_assignment').values({ administrator_id: admin.id, role_id: role.id, scope_type: 'client', membership_id: null }).execute()).rejects.toThrow();
  });
});
