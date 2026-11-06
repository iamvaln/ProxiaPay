import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { AuthorisationService } from '../admin-auth/authorisation.service';
import { AlertService } from '../alerts/alert.service';
import { Mailer } from '../alerts/mailer';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { InvitationController } from '../console-api/invitation.controller';
import { InvitationService } from './invitation.service';

let t: TestContext;
const get = <T>(token: new (...a: never[]) => T) => t.app.get(token as never) as T;
const BASE = 'https://console.sandbox.proxiapay.test';
const service = (config: { PUBLIC_BASE_URL?: string; PROXIAPAY_ENV?: 'sandbox' | 'production' } = {}) =>
  new InvitationService(t.db, { PUBLIC_BASE_URL: BASE, PROXIAPAY_ENV: 'sandbox', ...config }, get(Mailer), get(AlertService), get(AuditService));
const mailsTo = (address: string) => get(Mailer).sent.filter((m) => m.to === address);
const tokenIn = (text: string) => /\/console\/invitation\/([A-Za-z0-9_-]+)/.exec(text)?.[1];
const NEUTRAL = { code: 'FIELD_INVALID', message: 'This invitation link is no longer valid. Ask for a new one.' };

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
/** A client account with a password and an active membership of `clientId` under `roleName`. */
async function clientPerson(clientId: string, roleName = 'Client owner') {
  const a = await t.admin();
  await t.db.deleteFrom('role_assignment').where('administrator_id', '=', a.id).execute();
  await t.db.updateTable('administrator').set({ kind: 'client' }).where('id', '=', a.id).execute();
  const m = await t.db.insertInto('client_membership').values({ administrator_id: a.id, client_id: clientId, status: 'active' }).returning('id').executeTakeFirstOrThrow();
  const role = await t.db.selectFrom('role').select('id').where('name', '=', roleName).executeTakeFirstOrThrow();
  await t.db.insertInto('role_assignment').values({ administrator_id: a.id, role_id: role.id, scope_type: 'client', membership_id: m.id }).execute();
  return { ...a, membershipId: m.id };
}
const invite = (input: { clientId: string; email: string; profile?: 'owner' | 'developer' | 'finance'; projectIds?: string[]; language?: 'en' | 'fr' }, actorId: string, svc = service()) =>
  t.db.transaction().execute((tx) => svc.invite(tx, { name: 'Ama Mensah', language: 'en', profile: 'developer', projectIds: [], ...input }, actorId));

describe('invitations', () => {
  it('new email: account without password, pending membership, one mail with a 72-hour link', async () => {
    const acme = await newClient('Acme');
    const owner = await clientPerson(acme.id);
    const shop = await project(acme.id, 'acme-shop');
    expect(await invite({ clientId: acme.id, email: ' Ama@Example.test ', projectIds: [shop.id] }, owner.id)).toEqual({ status: 'invitation_sent' });

    const admin = await t.db.selectFrom('administrator').selectAll().where('email', '=', 'ama@example.test').executeTakeFirstOrThrow();
    expect(admin).toMatchObject({ kind: 'client', password_hash: null, name: 'Ama Mensah', language: 'en' });
    const m = await t.db.selectFrom('client_membership').selectAll().where('administrator_id', '=', admin.id).executeTakeFirstOrThrow();
    expect(m).toMatchObject({ client_id: acme.id, status: 'pending', invited_by: owner.id, accepted_at: null });
    const assignment = await t.db.selectFrom('role_assignment as ra').innerJoin('role as r', 'r.id', 'ra.role_id').select(['ra.id', 'r.name', 'ra.scope_type', 'ra.membership_id']).where('ra.administrator_id', '=', admin.id).executeTakeFirstOrThrow();
    expect(assignment).toMatchObject({ name: 'Client developer', scope_type: 'projects', membership_id: m.id });
    expect((await t.db.selectFrom('role_assignment_scope').select('project_id').where('assignment_id', '=', assignment.id).execute()).map((s) => s.project_id)).toEqual([shop.id]);
    // Pending grants nothing.
    expect((await new AuthorisationService(t.db).load(admin.id, acme.id)).permissions()).toEqual([]);

    const mails = mailsTo('ama@example.test');
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ subject: 'Your access to the ProxiaPay console', sensitive: true });
    expect(mails[0]!.text).toContain(`${BASE}/console/invitation/`);
    expect(mails[0]!.text).toMatch(/sandbox/i);
    expect(mails[0]!.text).toMatch(/any six digits/);
    const token = tokenIn(mails[0]!.text)!;
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);

    const inv = await t.db.selectFrom('invitation').selectAll().where('membership_id', '=', m.id).executeTakeFirstOrThrow();
    expect(inv.token_hash.equals(CryptoService.tokenHash(token))).toBe(true);
    expect(inv.sets_password).toBe(true);
    const hours = (inv.expires_at.getTime() - inv.created_at.getTime()) / 3600_000;
    expect(hours).toBeCloseTo(72, 3);
    const audit = await t.db.selectFrom('audit_record').select(['actor_id', 'action', 'subject_id']).where('action', '=', 'team.invite').execute();
    expect(audit).toEqual([{ actor_id: owner.id, action: 'team.invite', subject_id: m.id }]);
  });

  it('writes the invitation in the invitee\'s language and names the environment', async () => {
    const acme = await newClient('Acme');
    const owner = await clientPerson(acme.id);
    await invite({ clientId: acme.id, email: 'fr@example.test', language: 'fr', profile: 'finance' }, owner.id, service({ PROXIAPAY_ENV: 'production' }));
    const [mail] = mailsTo('fr@example.test');
    expect(mail!.subject).toBe('Votre accès à la console ProxiaPay');
    expect(mail!.text).toMatch(/production/);
    expect(mail!.text).not.toMatch(/six chiffres/);
  });

  it('refuses to invite without PUBLIC_BASE_URL, whatever the address', async () => {
    const acme = await newClient('Acme');
    const owner = await clientPerson(acme.id);
    const staff = await t.admin();
    for (const email of ['new@example.test', staff.email]) {
      await expect(invite({ clientId: acme.id, email }, owner.id, service({ PUBLIC_BASE_URL: undefined }))).rejects.toMatchObject({ code: 'RULE_VIOLATION' });
    }
    expect(get(Mailer).sent).toEqual([]);
    expect(await t.db.selectFrom('administrator').select('id').where('email', '=', 'new@example.test').execute()).toEqual([]);
  });

  it('existing client account: no second account, membership pending until accepted', async () => {
    const acme = await newClient('Acme');
    const beta = await newClient('Beta');
    const owner = await clientPerson(beta.id);
    const person = await clientPerson(acme.id, 'Client developer');
    expect(await invite({ clientId: beta.id, email: person.email.toUpperCase(), profile: 'finance' }, owner.id)).toEqual({ status: 'invitation_sent' });

    expect(await t.db.selectFrom('administrator').select('id').where('email', '=', person.email).execute()).toHaveLength(1);
    const m = await t.db.selectFrom('client_membership').selectAll().where('administrator_id', '=', person.id).where('client_id', '=', beta.id).executeTakeFirstOrThrow();
    expect(m.status).toBe('pending');
    const inv = await t.db.selectFrom('invitation').selectAll().where('membership_id', '=', m.id).executeTakeFirstOrThrow();
    expect(inv.sets_password).toBe(false);
    const mails = mailsTo(person.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ subject: 'You were added to Beta\'s team on ProxiaPay', sensitive: true });

    // Pending: the session cannot work in Beta, and me offers the acceptance.
    const auth = get(AdminAuthService);
    await expect(auth.switchClient({ kind: 'client', administratorId: person.id, sessionId: '00000000-0000-0000-0000-000000000000' } as never, beta.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await new AuthorisationService(t.db).load(person.id, beta.id)).permissions()).toEqual([]);
    expect(await auth.pendingMemberships(person.id)).toEqual([{ membership_id: m.id, client_name: 'Beta' }]);

    const controller = new InvitationController(service());
    const req = { principal: { administratorId: person.id, kind: 'client' }, auth: { isClient: true } } as never;
    // Another person's pending membership, or an unknown id, is not found.
    const stranger = await clientPerson(acme.id);
    await expect(controller.acceptMembership(m.id, { principal: { administratorId: stranger.id, kind: 'client' }, auth: { isClient: true } } as never)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await controller.acceptMembership(m.id, req)).toEqual({ ok: true });
    expect(await auth.pendingMemberships(person.id)).toEqual([]);
    expect((await auth.activeMemberships(person.id)).map((c) => c.name).sort()).toEqual(['Acme', 'Beta']);
    expect((await new AuthorisationService(t.db).load(person.id, beta.id)).has('oversight.export')).toBe(true);
    await expect(controller.acceptMembership(m.id, req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The link no longer works once the membership is accepted.
    await expect(service().preview(tokenIn(mails[0]!.text)!)).rejects.toMatchObject(NEUTRAL);
    const audit = await t.db.selectFrom('audit_record').select(['actor_id', 'action']).where('action', '=', 'invitation.accept').execute();
    expect(audit).toEqual([{ actor_id: person.id, action: 'invitation.accept' }]);
  });

  it('platform email: same answer, nothing created or sent, alert raised', async () => {
    const acme = await newClient('Acme');
    const owner = await clientPerson(acme.id);
    const staff = await t.admin('staff@proxia.test');
    const before = { memberships: await t.db.selectFrom('client_membership').select('id').execute(), admins: await t.db.selectFrom('administrator').select('id').execute() };
    expect(await invite({ clientId: acme.id, email: 'Staff@Proxia.test', profile: 'developer' }, owner.id)).toEqual({ status: 'invitation_sent' });
    expect(await t.db.selectFrom('client_membership').select('id').execute()).toEqual(before.memberships);
    expect(await t.db.selectFrom('administrator').select('id').execute()).toEqual(before.admins);
    expect(await t.db.selectFrom('invitation').select('id').execute()).toEqual([]);
    expect(mailsTo(staff.email)).toEqual([]);
    const alerts = await t.db.selectFrom('alert').selectAll().execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ category: 'security', severity: 'informational', title: 'Invitation to a platform account', fingerprint: 'invite_platform:staff@proxia.test' });
  });

  it('refuses an expired, used or unknown token with one neutral message', async () => {
    const acme = await newClient('Acme');
    const owner = await clientPerson(acme.id);
    await invite({ clientId: acme.id, email: 'a@example.test' }, owner.id);
    await invite({ clientId: acme.id, email: 'b@example.test' }, owner.id);
    const expired = tokenIn(mailsTo('a@example.test')[0]!.text)!;
    const used = tokenIn(mailsTo('b@example.test')[0]!.text)!;
    await t.db.updateTable('invitation').set({ expires_at: new Date(Date.now() - 1000) }).where('token_hash', '=', CryptoService.tokenHash(expired)).execute();
    await service().accept(used, { password: 'a-long-enough-password' });
    const controller = new InvitationController(service());
    for (const token of [expired, used, CryptoService.randomToken(32), 'short']) {
      await expect(controller.preview(token)).rejects.toMatchObject(NEUTRAL);
      await expect(controller.accept(token, { password: 'a-long-enough-password' })).rejects.toMatchObject(NEUTRAL);
    }
    // The expired invitation's account is untouched.
    const a = await t.db.selectFrom('administrator as a').innerJoin('client_membership as m', 'm.administrator_id', 'a.id').select(['a.password_hash', 'm.status']).where('a.email', '=', 'a@example.test').executeTakeFirstOrThrow();
    expect(a).toEqual({ password_hash: null, status: 'pending' });
  });

  it('accepting sets the password and activates the membership', async () => {
    const acme = await newClient('Acme');
    const owner = await clientPerson(acme.id);
    await invite({ clientId: acme.id, email: 'ama@example.test' }, owner.id);
    const token = tokenIn(mailsTo('ama@example.test')[0]!.text)!;
    const controller = new InvitationController(service());
    expect(await controller.preview(token)).toEqual({ client_name: 'Acme', sets_password: true });
    await expect(controller.accept(token, {})).rejects.toMatchObject({ code: 'FIELD_INVALID', options: { field: 'password' } });
    await expect(controller.accept(token, { password: 'short' })).rejects.toMatchObject({ code: 'FIELD_INVALID', options: { field: 'password' } });
    expect(await controller.accept(token, { password: 'a-long-enough-password' })).toEqual({ ok: true });

    const admin = await t.db.selectFrom('administrator').selectAll().where('email', '=', 'ama@example.test').executeTakeFirstOrThrow();
    expect(await CryptoService.verifySecret(admin.password_hash!, 'a-long-enough-password')).toBe(true);
    const m = await t.db.selectFrom('client_membership').selectAll().where('administrator_id', '=', admin.id).executeTakeFirstOrThrow();
    expect(m.status).toBe('active');
    expect(m.accepted_at).not.toBeNull();
    expect((await t.db.selectFrom('invitation').select('used_at').where('membership_id', '=', m.id).executeTakeFirstOrThrow()).used_at).not.toBeNull();
    // The invitee can now sign in, inside Acme.
    const signed = await get(AdminAuthService).signIn('ama@example.test', 'a-long-enough-password', { address: '10.0.0.1', description: 'test' });
    expect('sessionToken' in signed).toBe(true);
    const audit = await t.db.selectFrom('audit_record').select(['actor_id', 'action', 'subject_id']).where('action', '=', 'invitation.accept').execute();
    expect(audit).toEqual([{ actor_id: admin.id, action: 'invitation.accept', subject_id: m.id }]);
  });

  it('answers the invitation endpoints without a session', () => {
    for (const handler of [InvitationController.prototype.preview, InvitationController.prototype.accept]) {
      expect(Reflect.getMetadata('__guards__', handler)).toBeUndefined();
    }
  });
});
