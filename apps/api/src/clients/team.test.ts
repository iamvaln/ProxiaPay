import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { AuthorisationService } from '../admin-auth/authorisation.service';
import { AlertService } from '../alerts/alert.service';
import { Mailer } from '../alerts/mailer';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { TeamController } from '../console-api/team.controller';
import type { ConsoleRequest } from '../console-api/session.guard';
import { InvitationService } from './invitation.service';

let t: TestContext;
const get = <T>(token: new (...a: never[]) => T) => t.app.get(token as never) as T;
const invitations = () => new InvitationService(t.db, { PUBLIC_BASE_URL: 'https://console.proxiapay.test', PROXIAPAY_ENV: 'sandbox' }, get(Mailer), get(AlertService), get(AuditService));
const team = () => new TeamController(t.db, invitations());
const mailsTo = (address: string) => get(Mailer).sent.filter((m) => m.to === address);

beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  get(Mailer).sent.length = 0;
});

async function newClient(name: string) {
  return t.db.insertInto('client').values({ name }).returning('id').executeTakeFirstOrThrow();
}
async function project(clientId: string, code: string) {
  return t.db.insertInto('project').values({ code, name: code, client_id: clientId }).returning('id').executeTakeFirstOrThrow();
}
async function clientPerson(clientId: string, roleName = 'Client owner') {
  const a = await t.admin();
  await t.db.deleteFrom('role_assignment').where('administrator_id', '=', a.id).execute();
  await t.db.updateTable('administrator').set({ kind: 'client' }).where('id', '=', a.id).execute();
  const m = await t.db.insertInto('client_membership').values({ administrator_id: a.id, client_id: clientId, status: 'active', accepted_at: new Date() }).returning('id').executeTakeFirstOrThrow();
  const role = await t.db.selectFrom('role').select('id').where('name', '=', roleName).executeTakeFirstOrThrow();
  await t.db.insertInto('role_assignment').values({ administrator_id: a.id, role_id: role.id, scope_type: 'client', membership_id: m.id }).execute();
  return { ...a, membershipId: m.id };
}
/** A request as the session guard builds it for a client account working in `clientId`. */
async function requestOf(admin: { id: string; email: string }, clientId: string): Promise<ConsoleRequest> {
  return {
    principal: { sessionId: '00000000-0000-0000-0000-00000000005e', administratorId: admin.id, name: 'Owner', email: admin.email, language: 'en', timezone: 'UTC', secondFactorComplete: true, kind: 'client', activeClientId: clientId },
    auth: await new AuthorisationService(t.db).load(admin.id, clientId),
    clientAddress: '127.0.0.1', clientDescription: 'vitest',
  } as unknown as ConsoleRequest;
}
const membershipOf = (email: string) => t.db.selectFrom('client_membership as m').innerJoin('administrator as a', 'a.id', 'm.administrator_id').select(['m.id', 'm.status', 'a.id as admin_id']).where('a.email', '=', email).executeTakeFirstOrThrow();

/** An owner of Acme with one project, and a developer invited onto it. */
async function acmeTeam() {
  const acme = await newClient('Acme');
  const owner = await clientPerson(acme.id);
  const shop = await project(acme.id, 'acme-shop');
  const req = await requestOf(owner, acme.id);
  await team().invite({ name: 'Ama', email: 'ama@example.test', profile: 'developer', project_ids: [shop.id] }, req);
  const member = await membershipOf('ama@example.test');
  return { acme, owner, shop, req, member };
}

describe('the owner\'s team', () => {
  it('lists the team with profiles, projects and invitation state', async () => {
    const { owner, shop, req, member } = await acmeTeam();
    const { members } = await team().list(req);
    expect(members).toEqual(expect.arrayContaining([
      { membership_id: owner.membershipId, name: 'Test Admin', email: owner.email, profile: 'owner', project_ids: [], status: 'active', invitation: 'accepted' },
      { membership_id: member.id, name: 'Ama', email: 'ama@example.test', profile: 'developer', project_ids: [shop.id], status: 'pending', invitation: 'pending' },
    ]));
    expect(members).toHaveLength(2);
    await t.db.updateTable('invitation').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    expect((await team().list(req)).members.find((m) => m.membership_id === member.id)!.invitation).toBe('expired');
  });

  it('lists an existing account under the name the owner typed until it accepts', async () => {
    const { acme, req } = await acmeTeam();
    const other = await newClient('Other');
    const elsewhere = await clientPerson(other.id, 'Client developer');
    await t.db.updateTable('administrator').set({ name: 'Kwame Mensah' }).where('id', '=', elsewhere.id).execute();
    await team().invite({ name: 'Test', email: elsewhere.email, profile: 'finance', project_ids: [] }, req);
    const m = await t.db.selectFrom('client_membership').select('id').where('client_id', '=', acme.id).where('administrator_id', '=', elsewhere.id).executeTakeFirstOrThrow();
    const listed = async () => (await team().list(req)).members.find((x) => x.membership_id === m.id)!;
    expect(await listed()).toMatchObject({ name: 'Test', email: elsewhere.email, status: 'pending' });
    expect(JSON.stringify(await team().list(req))).not.toContain('Kwame');
    await invitations().acceptMembership(elsewhere.id, m.id);
    expect(await listed()).toMatchObject({ name: 'Kwame Mensah', status: 'active', invitation: 'accepted' });
  });

  it('an owner cannot add a project of another client', async () => {
    const { req, member } = await acmeTeam();
    const other = await newClient('Other');
    const theirs = await project(other.id, 'other-shop');
    const unknown = { code: 'FIELD_INVALID', message: 'Unknown project.', options: { field: 'project_ids' } };
    await expect(team().invite({ name: 'Bo', email: 'bo@example.test', profile: 'developer', project_ids: [theirs.id] }, req)).rejects.toMatchObject(unknown);
    await expect(team().access(member.id, { profile: 'developer', project_ids: [theirs.id] }, req)).rejects.toMatchObject(unknown);
    // A platform project belongs to no client, so it is no one's either.
    const platform = await t.db.insertInto('project').values({ code: 'plain', name: 'plain' }).returning('id').executeTakeFirstOrThrow();
    await expect(team().access(member.id, { profile: 'finance', project_ids: [platform.id] }, req)).rejects.toMatchObject(unknown);
    expect(await t.db.selectFrom('administrator').select('id').where('email', '=', 'bo@example.test').execute()).toEqual([]);
  });

  it('an owner cannot make an owner', async () => {
    const { req, member } = await acmeTeam();
    await expect(team().invite({ name: 'Bo', email: 'bo@example.test', profile: 'owner', project_ids: [] }, req)).rejects.toMatchObject({ code: 'FIELD_INVALID', options: { field: 'profile' } });
    await expect(team().access(member.id, { profile: 'owner', project_ids: [] }, req)).rejects.toMatchObject({ code: 'FIELD_INVALID', options: { field: 'profile' } });
  });

  it('an owner cannot edit their own membership', async () => {
    const { owner, req } = await acmeTeam();
    const own = { code: 'PERMISSION_DENIED', message: 'You cannot change your own access.' };
    await expect(team().access(owner.membershipId, { profile: 'developer', project_ids: [] }, req)).rejects.toMatchObject(own);
    await expect(team().status(owner.membershipId, { status: 'disabled' }, req)).rejects.toMatchObject(own);
    await expect(team().resend(owner.membershipId, req)).rejects.toMatchObject(own);
  });

  it('an owner cannot reach a membership of another client by id', async () => {
    const { req } = await acmeTeam();
    const other = await newClient('Other');
    const stranger = await clientPerson(other.id, 'Client developer');
    const notFound = { code: 'NOT_FOUND' };
    await expect(team().access(stranger.membershipId, { profile: 'finance', project_ids: [] }, req)).rejects.toMatchObject(notFound);
    await expect(team().status(stranger.membershipId, { status: 'disabled' }, req)).rejects.toMatchObject(notFound);
    await expect(team().resend(stranger.membershipId, req)).rejects.toMatchObject(notFound);
    await expect(team().access('not-a-uuid', { profile: 'finance', project_ids: [] }, req)).rejects.toMatchObject(notFound);
    expect((await membershipOf(stranger.email)).status).toBe('active');
  });

  it('an owner cannot change another owner', async () => {
    const { acme, req } = await acmeTeam();
    const second = await clientPerson(acme.id, 'Client owner');
    const owners = { code: 'PERMISSION_DENIED', message: 'An owner\'s access is changed by ProxiaPay.' };
    await expect(team().status(second.membershipId, { status: 'disabled' }, req)).rejects.toMatchObject(owners);
    await expect(team().access(second.membershipId, { profile: 'finance', project_ids: [] }, req)).rejects.toMatchObject(owners);
    expect((await membershipOf(second.email)).status).toBe('active');
    expect(await t.db.selectFrom('audit_record').select('id').where('action', 'in', ['team.status', 'team.access']).execute()).toEqual([]);
  });

  it('inviting the same address twice sends once', async () => {
    const { req, shop } = await acmeTeam();
    expect(await team().invite({ name: 'Ama again', email: 'AMA@example.test', profile: 'finance', project_ids: [shop.id] }, req)).toEqual({ status: 'invitation_sent' });
    expect(mailsTo('ama@example.test')).toHaveLength(1);
    expect(await t.db.selectFrom('client_membership').select('id').execute()).toHaveLength(2);
    expect(await t.db.selectFrom('invitation').select('id').execute()).toHaveLength(1);
    const assignment = await t.db.selectFrom('role_assignment as ra').innerJoin('role as r', 'r.id', 'ra.role_id').innerJoin('administrator as a', 'a.id', 'ra.administrator_id').select('r.name').where('a.email', '=', 'ama@example.test').execute();
    expect(assignment).toEqual([{ name: 'Client developer' }]);
  });

  it('changing access replaces the assignment and ends the member\'s sessions in this client', async () => {
    const { acme, req, member, shop } = await acmeTeam();
    const other = await newClient('Other');
    const second = await project(acme.id, 'acme-two');
    await t.db.updateTable('client_membership').set({ status: 'active' }).where('id', '=', member.id).execute();
    const session = (clientId: string) => t.db.insertInto('admin_session').values({ administrator_id: member.admin_id, active_client_id: clientId, token_hash: CryptoService.tokenHash(CryptoService.randomToken()), expires_at: new Date(Date.now() + 3600_000), origin_address: '10.0.0.1' }).returning('id').executeTakeFirstOrThrow();
    const here = await session(acme.id);
    const there = await session(other.id);

    await team().access(member.id, { profile: 'finance', project_ids: [shop.id, second.id] }, req);
    const auth = await new AuthorisationService(t.db).load(member.admin_id, acme.id);
    expect(auth.has('projects.credentials')).toBe(false);
    expect(auth.has('oversight.export')).toBe(true);
    expect(auth.projectScope('transactions.read')!.sort()).toEqual([shop.id, second.id].sort());
    expect(await t.db.selectFrom('role_assignment').select('id').where('membership_id', '=', member.id).execute()).toHaveLength(1);
    const sessions = await t.db.selectFrom('admin_session').select(['id', 'revoked_at']).where('administrator_id', '=', member.admin_id).execute();
    expect(sessions.find((s) => s.id === here.id)!.revoked_at).not.toBeNull();
    expect(sessions.find((s) => s.id === there.id)!.revoked_at).toBeNull();
    const audit = await t.db.selectFrom('audit_record').select(['action', 'actor_id', 'subject_id']).where('action', '=', 'team.access').execute();
    expect(audit).toEqual([{ action: 'team.access', actor_id: req.principal.administratorId, subject_id: member.id }]);
  });

  it('disabling ends the member\'s access here; re-enabling a never-accepted member leaves it pending', async () => {
    const { acme, req, member } = await acmeTeam();
    expect(await team().status(member.id, { status: 'disabled' }, req)).toEqual({ membership_id: member.id, status: 'disabled' });
    // A disabled membership's link no longer opens it.
    const token = /\/console\/invitation\/([A-Za-z0-9_-]+)/.exec(mailsTo('ama@example.test')[0]!.text)![1]!;
    await expect(invitations().preview(token)).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    expect(await team().status(member.id, { status: 'active' }, req)).toEqual({ membership_id: member.id, status: 'pending' });

    await t.db.updateTable('client_membership').set({ status: 'active', accepted_at: new Date() }).where('id', '=', member.id).execute();
    const s = await t.db.insertInto('admin_session').values({ administrator_id: member.admin_id, active_client_id: acme.id, token_hash: CryptoService.tokenHash(CryptoService.randomToken()), expires_at: new Date(Date.now() + 3600_000), origin_address: '10.0.0.1' }).returning('id').executeTakeFirstOrThrow();
    await team().status(member.id, { status: 'disabled' }, req);
    expect((await t.db.selectFrom('admin_session').select('revoked_at').where('id', '=', s.id).executeTakeFirstOrThrow()).revoked_at).not.toBeNull();
    expect((await new AuthorisationService(t.db).load(member.admin_id, acme.id)).permissions()).toEqual([]);
    expect(await team().status(member.id, { status: 'active' }, req)).toEqual({ membership_id: member.id, status: 'active' });
    expect((await t.db.selectFrom('audit_record').select('action').where('action', '=', 'team.status').execute())).toHaveLength(4);
  });

  it('resending replaces the link: the old one stops working, the new one is valid for 72 hours', async () => {
    const { req, member } = await acmeTeam();
    const tokenOf = (i: number) => /\/console\/invitation\/([A-Za-z0-9_-]+)/.exec(mailsTo('ama@example.test')[i]!.text)![1]!;
    await t.db.updateTable('invitation').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    expect(await team().resend(member.id, req)).toEqual({ status: 'invitation_sent' });
    expect(mailsTo('ama@example.test')).toHaveLength(2);
    await expect(invitations().preview(tokenOf(0))).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    expect(await invitations().preview(tokenOf(1))).toEqual({ client_name: 'Acme', sets_password: true });
    expect((await team().list(req)).members.find((m) => m.membership_id === member.id)!.invitation).toBe('pending');
    // A resend also replaces a link that was still valid.
    await team().resend(member.id, req);
    await expect(invitations().preview(tokenOf(1))).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    await invitations().accept(tokenOf(2), { password: 'a-long-enough-password' });
    await expect(team().resend(member.id, req)).rejects.toMatchObject({ code: 'RULE_VIOLATION' });
    expect((await t.db.selectFrom('audit_record').select('action').where('action', '=', 'team.resend').execute())).toHaveLength(2);
  });

  it('refuses a client member without client.members', async () => {
    const { acme } = await acmeTeam();
    const dev = await clientPerson(acme.id, 'Client developer');
    await expect(team().list(await requestOf(dev, acme.id))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
