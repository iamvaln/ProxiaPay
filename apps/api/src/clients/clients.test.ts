import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import type { ConfirmationService } from '../admin-auth/confirmation.service';
import { AlertService } from '../alerts/alert.service';
import { Mailer } from '../alerts/mailer';
import { AuditService } from '../audit/audit.service';
import { ClientsController } from '../console-api/clients.controller';
import { OversightController } from '../console-api/oversight.controller';
import { RoleService } from '../console-api/role.service';
import { ClientProjectsService } from '../console-api/client-projects.service';
import { EntitlementService } from '../console-api/entitlement.service';
import type { ConsoleRequest } from '../console-api/session.guard';
import { ClientsService } from './clients.service';
import { InvitationService } from './invitation.service';

let t: TestContext;
const get = <T>(token: new (...a: never[]) => T) => t.app.get(token as never) as T;
const confirmation = { id: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', code: '123456' };
const confirmations = { consume: async () => '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', recordFailedAttempt: async () => undefined } as unknown as ConfirmationService;
const invitations = () => new InvitationService(t.db, { PUBLIC_BASE_URL: 'https://console.proxiapay.test', PROXIAPAY_ENV: 'sandbox' }, get(Mailer), get(AlertService), get(AuditService));
const clients = () => new ClientsService(t.db, invitations(), get(AuditService));
const controller = () => new ClientsController(t.db, confirmations, clients());
const roles = () => new RoleService(t.db, get(AuditService), get(AlertService));
const mailsTo = (address: string) => get(Mailer).sent.filter((m) => m.to === address);

beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  get(Mailer).sent.length = 0;
});

const requestOf = (adminId: string) => ({ principal: { administratorId: adminId, language: 'en' } }) as unknown as ConsoleRequest;

/** A client with an active owner, and any other members as `[profile-role, status]`. */
async function member(clientId: string, roleName: string, status: 'active' | 'pending' | 'disabled' = 'active') {
  const a = await t.admin();
  await t.db.deleteFrom('role_assignment').where('administrator_id', '=', a.id).execute();
  await t.db.updateTable('administrator').set({ kind: 'client' }).where('id', '=', a.id).execute();
  const m = await t.db.insertInto('client_membership').values({ administrator_id: a.id, client_id: clientId, status, accepted_at: status === 'pending' ? null : new Date() }).returning('id').executeTakeFirstOrThrow();
  const role = await t.db.selectFrom('role').select('id').where('name', '=', roleName).executeTakeFirstOrThrow();
  await t.db.insertInto('role_assignment').values({ administrator_id: a.id, role_id: role.id, scope_type: 'client', membership_id: m.id }).execute();
  return { adminId: a.id, membershipId: m.id };
}
async function newClient(name: string) {
  return t.db.insertInto('client').values({ name }).returning('id').executeTakeFirstOrThrow();
}
async function session(administratorId: string, activeClientId: string | null) {
  return t.db.insertInto('admin_session').values({ administrator_id: administratorId, token_hash: Buffer.from(`${Math.random()}`), expires_at: new Date(Date.now() + 3_600_000), origin_address: '127.0.0.1', active_client_id: activeClientId }).returning('id').executeTakeFirstOrThrow();
}
const revoked = async (id: string) => (await t.db.selectFrom('admin_session').select('revoked_at').where('id', '=', id).executeTakeFirstOrThrow()).revoked_at !== null;
const statusOf = async (id: string) => (await t.db.selectFrom('client_membership').select(['status', 'disabled_by_client']).where('id', '=', id).executeTakeFirstOrThrow());

describe('clients for the platform', () => {
  it('creating a client invites its owner', async () => {
    const staff = await t.admin();
    const created = await controller().create({ name: 'Acme', owner_name: 'Ama Owner', owner_email: 'ama@acme.test', language: 'fr', confirmation }, requestOf(staff.id));
    expect(created.status).toBe('invitation_sent');
    const client = await t.db.selectFrom('client').selectAll().where('id', '=', created.client_id).executeTakeFirstOrThrow();
    expect(client).toMatchObject({ name: 'Acme', status: 'active', created_by: staff.id });
    const m = await t.db.selectFrom('client_membership as m').innerJoin('administrator as a', 'a.id', 'm.administrator_id').select(['m.id', 'm.status', 'a.kind']).where('a.email', '=', 'ama@acme.test').executeTakeFirstOrThrow();
    expect(m).toMatchObject({ status: 'pending', kind: 'client' });
    expect((await invitations().accessOf(t.db, m.id)).profile).toBe('owner');
    expect(mailsTo('ama@acme.test')).toHaveLength(1);
    const audit = await t.db.selectFrom('audit_record').select('action').where('action', 'in', ['client.create', 'client.invite_owner']).execute();
    expect(audit.map((a) => a.action).sort()).toEqual(['client.create', 'client.invite_owner']);
  });

  it('sends no mail when the transaction rolls back', async () => {
    const staff = await t.admin();
    await expect(t.db.transaction().execute(async (tx) => {
      await clients().createClient(tx, { name: 'Acme', ownerName: 'Ama', ownerEmail: 'ama@acme.test', language: 'en' }, staff.id);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(mailsTo('ama@acme.test')).toHaveLength(0);
    expect(await t.db.selectFrom('client').select('id').execute()).toHaveLength(0);
  });

  it('invites another owner, resends an invitation and lists the client', async () => {
    const staff = await t.admin();
    const acme = await newClient('Acme');
    await member(acme.id, 'Client owner');
    await t.db.insertInto('project').values({ code: 'acme-shop', name: 'Shop', client_id: acme.id }).execute();
    const req = requestOf(staff.id);
    await controller().inviteOwner(acme.id, { name: 'Successor', email: 'next@acme.test', confirmation }, req);
    expect(mailsTo('next@acme.test')).toHaveLength(1);
    const detail = await controller().detail(acme.id);
    const next = detail.members.find((m) => m.email === 'next@acme.test')!;
    expect(next).toMatchObject({ name: 'Successor', profile: 'owner', status: 'pending', invitation: 'pending' });
    expect(detail.projects.map((p) => p.code)).toEqual(['acme-shop']);
    await controller().resend(next.membership_id, { confirmation }, req);
    expect(mailsTo('next@acme.test')).toHaveLength(2);
    const listed = (await controller().list()).clients.find((c) => c.id === acme.id)!;
    expect(listed).toMatchObject({ name: 'Acme', status: 'active', members: 2, projects: 1 });
    await expect(controller().detail('not-a-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('requires a confirmation code for every write', async () => {
    const staff = await t.admin();
    const acme = await newClient('Acme');
    const req = requestOf(staff.id);
    await expect(controller().create({ name: 'X', owner_name: 'O', owner_email: 'o@x.test' }, req)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(controller().status(acme.id, { status: 'disabled' }, req)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(controller().disableAccount(staff.id, {}, req)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });

  it('refuses to edit a client role, or to assign one through the roles page', async () => {
    const staff = await t.admin();
    const other = await t.admin();
    const owner = await t.db.selectFrom('role').select(['id', 'kind']).where('name', '=', 'Client owner').executeTakeFirstOrThrow();
    const platformRole = await t.db.selectFrom('role').select('id').where('name', '=', 'Owner').executeTakeFirstOrThrow();
    const actor = { id: staff.id, permissions: ['admin.roles'] };
    await expect(roles().propose({ kind: 'role_permissions', role_id: owner.id, permissions: ['projects.read'] }, actor, 'why')).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: 'Client roles are fixed.' });
    await expect(roles().propose({ kind: 'assignment_add', administrator_id: other.id, role_id: owner.id, scope_type: 'all' }, actor, 'why')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const person = await member((await newClient('Acme')).id, 'Client finance');
    await expect(roles().propose({ kind: 'assignment_add', administrator_id: person.adminId, role_id: platformRole.id, scope_type: 'all' }, actor, 'why')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const listed = (await roles().list()).find((r) => r.id === owner.id)!;
    expect(listed.kind).toBe('client');
    expect((await roles().list()).find((r) => r.id === platformRole.id)!.kind).toBe('platform');
    expect((await t.db.selectFrom('role_permission').select('permission_key').where('role_id', '=', owner.id).execute()).length).toBeGreaterThan(1);
  });

  it('disabling a client disables its memberships and re-enabling restores only those', async () => {
    const staff = await t.admin();
    const acme = await newClient('Acme');
    const owner = await member(acme.id, 'Client owner');
    const dev = await member(acme.id, 'Client developer');
    const finance = await member(acme.id, 'Client finance');
    const pending = await member(acme.id, 'Client developer', 'pending');
    const other = await newClient('Other');
    const outsider = await member(other.id, 'Client owner');
    const s1 = await session(owner.adminId, acme.id);
    const s2 = await session(dev.adminId, acme.id);
    const s3 = await session(outsider.adminId, other.id);
    const req = requestOf(staff.id);
    // One member was disabled by the owner before.
    await invitations_setStatus(finance.membershipId, 'disabled', owner.adminId);

    await controller().status(acme.id, { status: 'disabled', confirmation }, req);
    expect((await t.db.selectFrom('client').select('status').where('id', '=', acme.id).executeTakeFirstOrThrow()).status).toBe('disabled');
    expect(await statusOf(owner.membershipId)).toEqual({ status: 'disabled', disabled_by_client: true });
    expect(await statusOf(dev.membershipId)).toEqual({ status: 'disabled', disabled_by_client: true });
    expect(await statusOf(finance.membershipId)).toEqual({ status: 'disabled', disabled_by_client: false });
    expect((await statusOf(pending.membershipId)).status).toBe('pending');
    expect(await revoked(s1.id)).toBe(true);
    expect(await revoked(s2.id)).toBe(true);
    expect(await revoked(s3.id)).toBe(false);

    await controller().status(acme.id, { status: 'active', confirmation }, req);
    expect(await statusOf(owner.membershipId)).toEqual({ status: 'active', disabled_by_client: false });
    expect(await statusOf(dev.membershipId)).toEqual({ status: 'active', disabled_by_client: false });
    expect(await statusOf(finance.membershipId)).toEqual({ status: 'disabled', disabled_by_client: false });
    expect((await t.db.selectFrom('audit_record').select('action').where('action', '=', 'client.status').execute())).toHaveLength(2);
  });

  it('refuses to disable the last active owner', async () => {
    const staff = await t.admin();
    const acme = await newClient('Acme');
    const first = await member(acme.id, 'Client owner');
    const second = await member(acme.id, 'Client owner');
    const req = requestOf(staff.id);
    await controller().membershipStatus(first.membershipId, { status: 'disabled', confirmation }, req);
    await expect(controller().membershipStatus(second.membershipId, { status: 'disabled', confirmation }, req))
      .rejects.toMatchObject({ code: 'FIELD_INVALID', message: 'A client keeps at least one active owner; invite a successor first.' });
    expect((await statusOf(second.membershipId)).status).toBe('active');
    // A developer is not an owner.
    const dev = await member(acme.id, 'Client developer');
    await controller().membershipStatus(dev.membershipId, { status: 'disabled', confirmation }, req);
    // Re-enabling is always possible while the client is active.
    await controller().membershipStatus(first.membershipId, { status: 'active', confirmation }, req);
    expect((await statusOf(first.membershipId)).status).toBe('active');
    await expect(controller().membershipStatus('00000000-0000-4000-8000-000000000000', { status: 'disabled', confirmation }, req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('disabling a membership revokes only the sessions active in that client', async () => {
    const staff = await t.admin();
    const acme = await newClient('Acme');
    const other = await newClient('Other');
    const owner = await member(acme.id, 'Client owner');
    await member(acme.id, 'Client owner');
    const dev = await member(acme.id, 'Client developer');
    // The same person also works for Other.
    const second = await t.db.insertInto('client_membership').values({ administrator_id: dev.adminId, client_id: other.id, status: 'active', accepted_at: new Date() }).returning('id').executeTakeFirstOrThrow();
    const inAcme = await session(dev.adminId, acme.id);
    const inOther = await session(dev.adminId, other.id);
    const ownerSession = await session(owner.adminId, acme.id);
    await controller().membershipStatus(dev.membershipId, { status: 'disabled', confirmation }, requestOf(staff.id));
    expect(await revoked(inAcme.id)).toBe(true);
    expect(await revoked(inOther.id)).toBe(false);
    expect(await revoked(ownerSession.id)).toBe(false);
    expect((await statusOf(second.id)).status).toBe('active');
    expect((await t.db.selectFrom('audit_record').select('action').where('action', '=', 'membership.status').execute())).toHaveLength(1);
  });

  it('disables an account and revokes all its sessions', async () => {
    const staff = await t.admin();
    const acme = await newClient('Acme');
    const other = await newClient('Other');
    const dev = await member(acme.id, 'Client developer');
    await t.db.insertInto('client_membership').values({ administrator_id: dev.adminId, client_id: other.id, status: 'active', accepted_at: new Date() }).execute();
    const a = await session(dev.adminId, acme.id);
    const b = await session(dev.adminId, other.id);
    await controller().disableAccount(dev.adminId, { confirmation }, requestOf(staff.id));
    expect((await t.db.selectFrom('administrator').select('status').where('id', '=', dev.adminId).executeTakeFirstOrThrow()).status).toBe('disabled');
    expect(await revoked(a.id)).toBe(true);
    expect(await revoked(b.id)).toBe(true);
    expect((await t.db.selectFrom('audit_record').select('action').where('action', '=', 'administrator.disable').execute())).toHaveLength(1);
    // A platform account is handled on the administrators page.
    await expect(controller().disableAccount(staff.id, { confirmation }, requestOf(staff.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a client account\'s status', () => {
  it('is refused on the administrators page, which is for platform accounts', async () => {
    const staff = await t.admin();
    const dev = await member((await newClient('Acme')).id, 'Client developer');
    const oversight = new OversightController(t.db, null as never, null as never, get(AuditService), null as never, null as never, null as never, confirmations);
    await expect(oversight.patchAdministrator(dev.adminId, { status: 'disabled', confirmation }, requestOf(staff.id))).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: 'Client accounts are managed from Oversight → Clients.' });
    expect((await t.db.selectFrom('administrator').select('status').where('id', '=', dev.adminId).executeTakeFirstOrThrow()).status).toBe('active');
  });

  it('is re-enabled from the client, with a confirmation code', async () => {
    const staff = await t.admin();
    const acme = await newClient('Acme');
    const dev = await member(acme.id, 'Client developer');
    const req = requestOf(staff.id);
    await controller().disableAccount(dev.adminId, { confirmation }, req);
    expect((await controller().detail(acme.id)).members.find((m) => m.administrator_id === dev.adminId)).toMatchObject({ account_status: 'disabled' });
    await expect(controller().enableAccount(dev.adminId, {}, req)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(await controller().enableAccount(dev.adminId, { confirmation }, req)).toEqual({ administrator_id: dev.adminId, status: 'active' });
    expect((await t.db.selectFrom('administrator').select('status').where('id', '=', dev.adminId).executeTakeFirstOrThrow()).status).toBe('active');
    expect((await controller().detail(acme.id)).members.find((m) => m.administrator_id === dev.adminId)).toMatchObject({ account_status: 'active' });
    expect(await t.db.selectFrom('audit_record').select(['action', 'prior_state', 'new_state']).where('action', '=', 'administrator.enable').execute()).toEqual([{ action: 'administrator.enable', prior_state: { status: 'disabled' }, new_state: { status: 'active' } }]);
    // A platform account is handled on the administrators page.
    await expect(controller().enableAccount(staff.id, { confirmation }, req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('guards on the platform side', () => {
  it('refuses to remove a client assignment through the roles page', async () => {
    const staff = await t.admin();
    const owner = await member((await newClient('Acme')).id, 'Client owner');
    const a = await t.db.selectFrom('role_assignment').select('id').where('membership_id', '=', owner.membershipId).executeTakeFirstOrThrow();
    await expect(roles().propose({ kind: 'assignment_remove', assignment_id: a.id }, { id: staff.id, permissions: ['admin.roles'] }, 'why')).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: 'Client access is changed through the client\'s team.' });
    await expect(t.db.transaction().execute((tx) => roles().applyChange(tx, { kind: 'assignment_remove', assignment_id: a.id }, staff.id, null))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await t.db.selectFrom('role_assignment').select('id').where('id', '=', a.id).execute()).toHaveLength(1);
  });

  it('refuses to disable the account of the last active owner of a client', async () => {
    const staff = await t.admin();
    const acme = await newClient('Acme');
    const only = await member(acme.id, 'Client owner');
    const req = requestOf(staff.id);
    await expect(controller().disableAccount(only.adminId, { confirmation }, req)).rejects.toMatchObject({ code: 'FIELD_INVALID', message: 'A client keeps at least one active owner; invite a successor first.' });
    expect((await t.db.selectFrom('administrator').select('status').where('id', '=', only.adminId).executeTakeFirstOrThrow()).status).toBe('active');
    await member(acme.id, 'Client owner');
    await controller().disableAccount(only.adminId, { confirmation }, req);
    // In a disabled client the rule does not apply.
    const gone = await newClient('Gone');
    const lone = await member(gone.id, 'Client owner');
    await t.db.updateTable('client').set({ status: 'disabled' }).where('id', '=', gone.id).execute();
    await controller().disableAccount(lone.adminId, { confirmation }, req);
  });

  it('refuses an owner invitation and a re-enabled membership in a disabled client', async () => {
    const staff = await t.admin();
    const acme = await newClient('Acme');
    const dev = await member(acme.id, 'Client developer', 'disabled');
    await t.db.updateTable('client').set({ status: 'disabled' }).where('id', '=', acme.id).execute();
    const req = requestOf(staff.id);
    await expect(controller().inviteOwner(acme.id, { name: 'N', email: 'n@acme.test', confirmation }, req)).rejects.toMatchObject({ code: 'RULE_VIOLATION', message: 'That client is disabled.' });
    await expect(controller().membershipStatus(dev.membershipId, { status: 'active', confirmation }, req)).rejects.toMatchObject({ code: 'RULE_VIOLATION', message: 'That client is disabled.' });
    expect((await statusOf(dev.membershipId)).status).toBe('disabled');
    expect(mailsTo('n@acme.test')).toHaveLength(0);
  });
});

describe('attaching a project to a client', () => {
  it('refuses a disabled client and a missing one', async () => {
    const staff = await t.admin();
    const project = await t.project('legacy');
    const acme = await newClient('Acme');
    await t.db.updateTable('client').set({ status: 'disabled' }).where('id', '=', acme.id).execute();
    const service = new ClientProjectsService(t.db, { SANDBOX_AUTO_ENTITLE: false }, new EntitlementService(t.db, get(AuditService)), get(AlertService), get(AuditService));
    const attach = (clientId: string) => t.db.transaction().execute((tx) => service.attach(tx, project.id, clientId, staff.id, confirmation.id));
    await expect(attach(acme.id)).rejects.toMatchObject({ code: 'FIELD_INVALID', message: 'That client is disabled.', options: { field: 'client_id' } });
    await expect(attach('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

function invitations_setStatus(membershipId: string, status: 'active' | 'disabled', actorId: string) {
  return t.db.transaction().execute((tx) => invitations().setStatus(tx, membershipId, status, actorId));
}
