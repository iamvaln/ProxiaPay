import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { AuthorisationService } from '../admin-auth/authorisation.service';
import type { ConfirmationService } from '../admin-auth/confirmation.service';
import { AlertService } from '../alerts/alert.service';
import { AuditService } from '../audit/audit.service';
import { loadConfig, resetConfigForTests } from '../config/config';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notifications/notification.service';
import { CredentialService } from '../project-auth/credential.service';
import { ClientProjectsService } from './client-projects.service';
import { EntitlementService } from './entitlement.service';
import { ConsoleProjectsController } from './projects.controller';
import type { ConsoleRequest } from './session.guard';

let t: TestContext;
const confirmation = { id: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', code: '123456' };
const confirmations = { consume: async () => undefined, recordFailedAttempt: async () => undefined } as unknown as ConfirmationService;

function controller(autoEntitle: boolean) {
  const get = <T>(token: new (...a: never[]) => T) => t.app.get(token as never) as T;
  const entitlements = new EntitlementService(t.db, get(AuditService));
  const clientProjects = new ClientProjectsService(t.db, { SANDBOX_AUTO_ENTITLE: autoEntitle }, entitlements, get(AlertService), get(AuditService));
  return new ConsoleProjectsController(t.db, get(LedgerService), get(CredentialService), get(NotificationService), confirmations, entitlements, get(AuditService), clientProjects);
}

/** A request as the session guard builds it: authorisation loaded from the database for the active client. */
async function requestOf(adminId: string, activeClientId: string | null): Promise<ConsoleRequest> {
  const auth = await new AuthorisationService(t.db).load(adminId, activeClientId, activeClientId ? 'client' : 'platform');
  return { principal: { administratorId: adminId }, auth } as unknown as ConsoleRequest;
}
async function newClient(name: string) {
  return t.db.insertInto('client').values({ name }).returning('id').executeTakeFirstOrThrow();
}
async function clientPerson(clientId: string, roleName: string) {
  const a = await t.admin();
  await t.db.deleteFrom('role_assignment').where('administrator_id', '=', a.id).execute();
  await t.db.updateTable('administrator').set({ kind: 'client' }).where('id', '=', a.id).execute();
  const m = await t.db.insertInto('client_membership').values({ administrator_id: a.id, client_id: clientId, status: 'active' }).returning('id').executeTakeFirstOrThrow();
  const role = await t.db.selectFrom('role').select('id').where('name', '=', roleName).executeTakeFirstOrThrow();
  await t.db.insertInto('role_assignment').values({ administrator_id: a.id, role_id: role.id, scope_type: 'client', membership_id: m.id }).execute();
  return a;
}

beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(() => t.reset());

describe('projects created by clients', () => {
  it('a client owner\'s new project belongs to the active client and is in the owner\'s scope at once', async () => {
    const acme = await newClient('Acme');
    const owner = await clientPerson(acme.id, 'Client owner');
    const created = await controller(false).create({ code: 'acme-shop', name: 'Acme shop' }, await requestOf(owner.id, acme.id));
    expect(created.client_id).toBe(acme.id);
    const after = await new AuthorisationService(t.db).load(owner.id, acme.id, 'client');
    expect(after.projectScope('projects.credentials')).toContain(created.id);
  });

  it('a client cannot create a project for another client through the body', async () => {
    const acme = await newClient('Acme');
    const other = await newClient('Other');
    const owner = await clientPerson(acme.id, 'Client owner');
    const created = await controller(false).create({ code: 'acme-shop', name: 'Acme shop', client_id: other.id }, await requestOf(owner.id, acme.id));
    expect(created.client_id).toBe(acme.id);
  });

  it('refuses a client without projects.create_own, and says a taken code is taken', async () => {
    const acme = await newClient('Acme');
    const dev = await clientPerson(acme.id, 'Client developer');
    await expect(controller(false).create({ code: 'acme-dev', name: 'x' }, await requestOf(dev.id, acme.id))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const owner = await clientPerson(acme.id, 'Client owner');
    const req = await requestOf(owner.id, acme.id);
    await controller(false).create({ code: 'acme-shop', name: 'a' }, req);
    await expect(controller(false).create({ code: 'acme-shop', name: 'b' }, req)).rejects.toMatchObject({ code: 'FIELD_INVALID', message: 'That code is taken.', options: { field: 'code' } });
  });

  it('lets the platform create a project, with or without a client', async () => {
    const acme = await newClient('Acme');
    const staff = await t.admin();
    const req = await requestOf(staff.id, null);
    expect((await controller(true).create({ code: 'plain', name: 'Plain' }, req)).client_id).toBeNull();
    expect((await controller(true).create({ code: 'owned', name: 'Owned', client_id: acme.id }, req)).client_id).toBe(acme.id);
    // Platform projects are opened by hand: nothing is granted automatically.
    expect(await t.db.selectFrom('entitlement').select('id').execute()).toHaveLength(0);
  });

  it('on the sandbox a client project gets every active route with the sandbox limits and inherited fees', async () => {
    const acme = await newClient('Acme');
    const owner = await clientPerson(acme.id, 'Client owner');
    const country = await t.db.selectFrom('route').select('country_code').limit(1).executeTakeFirstOrThrow();
    await t.db.updateTable('country').set({ active: false }).where('code', '=', country.country_code).execute();
    const expected = await t.db.selectFrom('route as r').innerJoin('route_version as rv', (j) => j.onRef('rv.route_id', '=', 'r.id').on('rv.valid_to', 'is', null)).innerJoin('country as c', 'c.code', 'r.country_code')
      .select('r.id').where('rv.active', '=', true).where('c.active', '=', true).execute();
    expect(expected.length).toBeGreaterThan(0);
    const created = await controller(true).create({ code: 'acme-shop', name: 'Acme shop' }, await requestOf(owner.id, acme.id));
    const versions = await t.db.selectFrom('entitlement as e').innerJoin('entitlement_version as v', 'v.entitlement_id', 'e.id').selectAll('v').select('e.route_id').where('e.project_id', '=', created.id).execute();
    expect(versions.map((v) => v.route_id).sort()).toEqual(expected.map((r) => r.id).sort());
    for (const v of versions) {
      expect(v).toMatchObject({ count_24h: 1000, value_24h: 100_000_000, count_30d: 1000, value_30d: 100_000_000, processing_fee_bps: null, platform_fee_bps: null, created_by: null, note: 'Opened automatically on the sandbox', active: true });
    }
    const audits = await t.db.selectFrom('audit_record').select(['actor_id', 'action']).where('action', 'like', 'entitlement.%').execute();
    expect(audits).toHaveLength(expected.length);
    expect(audits.every((a) => a.action === 'entitlement.auto_grant' && a.actor_id === null)).toBe(true);
    expect(await t.db.selectFrom('alert').select('id').execute()).toHaveLength(0);
  });

  it('in production a client project gets no route and raises the waiting alert', async () => {
    const acme = await newClient('Acme');
    const owner = await clientPerson(acme.id, 'Client owner');
    const created = await controller(false).create({ code: 'acme-shop', name: 'Acme shop' }, await requestOf(owner.id, acme.id));
    expect(await t.db.selectFrom('entitlement').select('id').where('project_id', '=', created.id).execute()).toHaveLength(0);
    const alerts = await t.db.selectFrom('alert').selectAll().execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ category: 'service_health', severity: 'informational', title: 'Project waiting for routes', subject_reference: 'acme-shop', fingerprint: `project_waiting_routes:${created.id}`, action_reference: `/projects/${created.id}` });
  });
});

describe('attaching a project to a client', () => {
  it('attaching names the platform accounts that still reach the project', async () => {
    const acme = await newClient('Acme');
    const project = await t.project('legacy');
    const staff = await t.admin();
    const scoped = await t.admin();
    await t.db.deleteFrom('role_assignment').where('administrator_id', '=', scoped.id).execute();
    const role = await t.db.selectFrom('role').select('id').where('name', '=', 'Owner').executeTakeFirstOrThrow();
    const a = await t.db.insertInto('role_assignment').values({ administrator_id: scoped.id, role_id: role.id, scope_type: 'projects' }).returning('id').executeTakeFirstOrThrow();
    await t.db.insertInto('role_assignment_scope').values({ assignment_id: a.id, project_id: project.id }).execute();
    const req = await requestOf(staff.id, null);
    const done = await controller(false).attachClient(project.id, { client_id: acme.id, confirmation }, req);
    expect(done.platform_accounts).toEqual([{ id: scoped.id, name: 'Test Admin' }]);
    expect((await t.db.selectFrom('project').select('client_id').where('id', '=', project.id).executeTakeFirstOrThrow()).client_id).toBe(acme.id);
    const other = await newClient('Other');
    await expect(controller(false).attachClient(project.id, { client_id: other.id, confirmation }, req)).rejects.toMatchObject({ code: 'RULE_VIOLATION' });
    await expect(controller(false).attachClient(project.id, { client_id: other.id }, req)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });
});

describe('reading who reaches a project', () => {
  it('names the platform accounts holding a projects scope, before any attachment', async () => {
    const project = await t.project('legacy');
    const staff = await t.admin();
    const scoped = await t.admin();
    await t.db.deleteFrom('role_assignment').where('administrator_id', '=', scoped.id).execute();
    const role = await t.db.selectFrom('role').select('id').where('name', '=', 'Owner').executeTakeFirstOrThrow();
    const a = await t.db.insertInto('role_assignment').values({ administrator_id: scoped.id, role_id: role.id, scope_type: 'projects' }).returning('id').executeTakeFirstOrThrow();
    await t.db.insertInto('role_assignment_scope').values({ assignment_id: a.id, project_id: project.id }).execute();
    expect(await controller(false).reachBy(project.id)).toEqual({ platform_accounts: [{ id: scoped.id, name: 'Test Admin' }] });
    await expect(controller(false).reachBy('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    void staff;
  });
});

describe('configuration', () => {
  it('refuses to boot in production with SANDBOX_AUTO_ENTITLE', () => {
    resetConfigForTests();
    expect(() => loadConfig({ ...process.env, PROXIAPAY_ENV: 'production', SANDBOX_AUTO_ENTITLE: 'true' })).toThrow('Invalid configuration: SANDBOX_AUTO_ENTITLE is refused in production');
    resetConfigForTests();
  });
});
