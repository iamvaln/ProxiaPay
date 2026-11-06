import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './../test/context';
import { AuthorisationService } from './authorisation.service';

let t: TestContext;
beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(() => t.reset());

const service = () => new AuthorisationService(t.db);

async function newClient(name: string) {
  return t.db.insertInto('client').values({ name }).returning('id').executeTakeFirstOrThrow();
}
async function newProject(clientId: string, code: string) {
  const admin = await t.admin();
  return t.db.insertInto('project').values({ code, name: code, created_by: admin.id, client_id: clientId }).returning('id').executeTakeFirstOrThrow();
}
async function clientPerson() {
  const a = await t.admin();
  await t.db.deleteFrom('role_assignment').where('administrator_id', '=', a.id).execute();
  await t.db.updateTable('administrator').set({ kind: 'client' }).where('id', '=', a.id).execute();
  return a;
}
async function membership(adminId: string, clientId: string, roleName: string, status = 'active') {
  const m = await t.db.insertInto('client_membership').values({ administrator_id: adminId, client_id: clientId, status }).returning('id').executeTakeFirstOrThrow();
  const role = await t.db.selectFrom('role').select('id').where('name', '=', roleName).executeTakeFirstOrThrow();
  await t.db.insertInto('role_assignment').values({ administrator_id: adminId, role_id: role.id, scope_type: 'client', membership_id: m.id }).execute();
  return m;
}

describe('authorisation from the active membership', () => {
  it('gives a client owner every project of the active client, including one created after the assignment', async () => {
    const c = await newClient('Acme');
    const p1 = await newProject(c.id, 'acme-1');
    const person = await clientPerson();
    await membership(person.id, c.id, 'Client owner');
    const p2 = await newProject(c.id, 'acme-2');
    const other = await newClient('Other');
    await newProject(other.id, 'other-1');
    const auth = await service().load(person.id, c.id);
    expect(auth.isClient).toBe(true);
    expect(auth.clientId).toBe(c.id);
    expect(auth.has('client.members')).toBe(true);
    expect([...auth.projectScope('projects.credentials')!].sort()).toEqual([p1.id, p2.id].sort());
  });

  it('ignores assignments of another membership of the same person', async () => {
    const a = await newClient('A');
    const b = await newClient('B');
    const pa = await newProject(a.id, 'a-1');
    await newProject(b.id, 'b-1');
    const person = await clientPerson();
    await membership(person.id, a.id, 'Client developer');
    await membership(person.id, b.id, 'Client finance');
    const auth = await service().load(person.id, a.id);
    expect(auth.permissions()).toContain('projects.credentials');
    expect(auth.permissions()).not.toContain('oversight.export');
    expect(auth.projectScope('projects.credentials')).toEqual([pa.id]);
  });

  it('gives nothing to a client account whose membership is disabled or whose client is disabled', async () => {
    const c = await newClient('Acme');
    await newProject(c.id, 'acme-1');
    const person = await clientPerson();
    const m = await membership(person.id, c.id, 'Client owner');
    expect((await service().load(person.id, c.id)).permissions().length).toBeGreaterThan(0);
    await t.db.updateTable('client_membership').set({ status: 'disabled' }).where('id', '=', m.id).execute();
    expect((await service().load(person.id, c.id)).permissions()).toEqual([]);
    await t.db.updateTable('client_membership').set({ status: 'active' }).where('id', '=', m.id).execute();
    await t.db.updateTable('client').set({ status: 'disabled' }).where('id', '=', c.id).execute();
    expect((await service().load(person.id, c.id)).permissions()).toEqual([]);
  });

  it('gives a client account nothing without an active client', async () => {
    const c = await newClient('Acme');
    const person = await clientPerson();
    await membership(person.id, c.id, 'Client owner');
    const auth = await service().load(person.id, null);
    expect(auth.permissions()).toEqual([]);
    expect(auth.isClient).toBe(true);
  });

  it('keeps platform staff on assignments without membership', async () => {
    const staff = await t.admin();
    const c = await newClient('Acme');
    // A stray membership-bound assignment must not leak into a platform account.
    await membership(staff.id, c.id, 'Client owner');
    const auth = await service().load(staff.id, null);
    expect(auth.isClient).toBe(false);
    expect(auth.clientId).toBeNull();
    expect(auth.has('admin.clients')).toBe(true);
    expect(auth.has('client.members')).toBe(false);
    expect(auth.projectScope('projects.credentials')).toBeNull();
  });
});
