import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createTestContext, type TestContext } from '../test/context';
import { consoleRoutes } from '../test/console-routes';
import { PlatformError } from '../common/errors';
import { AdminAuthService } from './admin-auth.service';
import { AuthorisationService } from './authorisation.service';
import { ConfirmationService } from './confirmation.service';
import { AlertService } from '../alerts/alert.service';
import { Mailer } from '../alerts/mailer';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { ClientsService } from '../clients/clients.service';
import { RoleService } from '../console-api/role.service';
import { InvitationService } from '../clients/invitation.service';
import { BrandService } from '../payment-links/brand.service';
import { LinksService } from '../payment-links/links.service';
import { BrandController } from '../console-api/brand.controller';
import { ClientsController } from '../console-api/clients.controller';
import { ConsoleAuthController } from '../console-api/auth.controller';
import { PaymentLinksController } from '../console-api/payment-links.controller';
import { SessionGuard, type ConsoleRequest } from '../console-api/session.guard';

let t: TestContext;
const get = <T>(token: new (...a: never[]) => T) => t.app.get(token as never) as T;
const where = { address: '10.0.0.1', description: 'test' };
const auth = () => new AdminAuthService(t.db, get(CryptoService), get(SettingsService), get(AuditService), { SANDBOX_ANY_SECOND_FACTOR: false });
const authController = () => new ConsoleAuthController(t.db, { TRUSTED_PROXY_HOPS: 0, NODE_ENV: 'test', PROXIAPAY_ENV: 'sandbox' }, auth(), get(SettingsService), {} as ConfirmationService);
const clientsController = () => new ClientsController(t.db, get(ConfirmationService), new ClientsService(t.db, invitations(), get(AuditService)));
const invitations = () => new InvitationService(t.db, { PUBLIC_BASE_URL: 'https://console.proxiapay.test', PROXIAPAY_ENV: 'sandbox' }, get(Mailer), get(AlertService), get(AuditService));
const links = () => new PaymentLinksController(t.db, new LinksService(t.db, { PAYLINK_BASE_URL: 'https://pay.example.com' }, get(AuditService), new BrandService(t.db, get(AuditService))));
const brand = () => new BrandController(t.db, new BrandService(t.db, get(AuditService)));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(() => t.reset());

/** A partner with one project granted every route. */
async function partner(name: string, code: string) {
  const client = await t.db.insertInto('client').values({ name }).returning('id').executeTakeFirstOrThrow();
  const project = await t.project(code);
  await t.db.updateTable('project').set({ client_id: client.id }).where('id', '=', project.id).execute();
  return { client, project };
}
/** A client account owning `clientId`. */
async function clientOwner(clientId: string) {
  const a = await t.admin();
  await t.db.deleteFrom('role_assignment').where('administrator_id', '=', a.id).execute();
  await t.db.updateTable('administrator').set({ kind: 'client' }).where('id', '=', a.id).execute();
  const m = await t.db.insertInto('client_membership').values({ administrator_id: a.id, client_id: clientId, status: 'active', accepted_at: new Date() }).returning('id').executeTakeFirstOrThrow();
  const role = await t.db.selectFrom('role').select('id').where('name', '=', 'Client owner').executeTakeFirstOrThrow();
  await t.db.insertInto('role_assignment').values({ administrator_id: a.id, role_id: role.id, scope_type: 'client', membership_id: m.id }).execute();
  return a;
}
/** A platform account holding only `roleName`, unscoped. */
async function staffWith(roleName: string) {
  const a = await t.admin();
  await t.db.deleteFrom('role_assignment').where('administrator_id', '=', a.id).execute();
  const role = await t.db.selectFrom('role').select('id').where('name', '=', roleName).executeTakeFirstOrThrow();
  await t.db.insertInto('role_assignment').values({ administrator_id: a.id, role_id: role.id, scope_type: 'all' }).execute();
  return a;
}
/** Signs in and completes the second factor; returns the session's token. */
async function signIn(person: { email: string; password: string }) {
  const r = await auth().signIn(person.email, person.password, where);
  if (!('sessionToken' in r)) throw new Error('locked');
  await t.db.updateTable('admin_session').set({ second_factor_at: new Date() }).where('token_hash', '=', CryptoService.tokenHash(r.sessionToken)).execute();
  return r.sessionToken;
}
/** The request the real session guard builds for this session on the route `key`, or the error it answers. */
async function through(token: string, key: string): Promise<ConsoleRequest> {
  const route = consoleRoutes().find((r) => r.key === key);
  if (!route) throw new Error(`no route ${key}`);
  const guard = new SessionGuard(new Reflector(), auth(), new AuthorisationService(t.db), { TRUSTED_PROXY_HOPS: 0 });
  const req = { method: key.split(' ')[0], headers: { cookie: `pp_session=${token}`, 'x-requested-with': 'ProxiaPay' }, socket: { remoteAddress: '10.0.0.1' } } as unknown as ConsoleRequest;
  const ctx = { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => route.handler, getClass: () => route.controller } as unknown as ExecutionContext;
  await guard.canActivate(ctx);
  return req;
}
const answer = (p: Promise<unknown>) => p.then(() => 'passes', (e: unknown) => (e instanceof PlatformError ? `${e.code}` : Promise.reject(e)));
/** A confirmation code bound to exactly these values, as the console requests one. */
async function code(administratorId: string, operationType: string, values: unknown) {
  const fingerprint = ConfirmationService.fingerprint(operationType, values);
  const row = await t.db.insertInto('operation_confirmation').values({
    administrator_id: administratorId, operation_type: operationType, subject_reference: '', fingerprint,
    code_hash: CryptoService.tokenHash(`${fingerprint}:123456`), expires_at: new Date(Date.now() + 600_000),
  }).returning('id').executeTakeFirstOrThrow();
  return { id: row.id, code: '123456' };
}
async function attachSelf(clientId: string, req: ConsoleRequest) {
  return clientsController().attachSelf(clientId, { confirmation: await code(req.principal.administratorId, 'client.attach_self', { client_id: clientId }) }, req);
}
const switchTo = async (token: string, client_id: string | null) => authController().switchClient({ client_id }, await through(token, 'POST console/auth/active-client'));
const route = async (country: string) => (await t.db.selectFrom('route').select('id').where('country_code', '=', country).where('payment_method_code', '=', 'MOMO').where('currency_code', '=', 'XAF').where('direction', '=', 'collection').executeTakeFirstOrThrow()).id;
const link = async () => ({ title: 'Invoice 42', currency: 'XAF', amount_type: 'fixed', amount: 5000, route_ids: [await route('CM')] });

describe('a platform account in a partner\'s view', () => {
  it('a platform account attached as owner switches to the partner and is walled like a client', async () => {
    const { client: acme, project } = await partner('Acme', 'acme-shop');
    const other = await partner('Other', 'other-shop');
    const house = await t.project('platform-shop');
    const valentine = await t.admin();
    const token = await signIn(valentine);
    await attachSelf(acme.id, await through(token, 'POST console/oversight/clients/:id/owners/me'));

    // Attaching changes nothing in the open session: still the super-admin view.
    expect((await auth().resolveSession(token))).toMatchObject({ kind: 'platform', accountKind: 'platform', activeClientId: null });
    await expect(switchTo(token, acme.id)).resolves.toEqual({ ok: true });
    expect((await auth().resolveSession(token))).toMatchObject({ kind: 'client', accountKind: 'platform', activeClientId: acme.id });

    // Every platform handler answers as a route that does not exist, whatever the Owner role grants elsewhere.
    for (const key of consoleRoutes().filter((r) => r.guarded && !r.clientAccessible).map((r) => r.key)) {
      expect(await answer(through(token, key)), key).toBe('NOT_FOUND');
    }
    // The partner's grants, from the membership alone, over the partner's projects alone.
    const req = await through(token, 'POST console/projects/:id/payment-links');
    expect(req.auth.isClient).toBe(true);
    expect(req.auth.clientId).toBe(acme.id);
    expect(req.auth.has('links.manage')).toBe(true);
    expect(req.auth.has('admin.clients')).toBe(false);
    expect(req.auth.projectScope('projects.read')).toEqual([project.id]);
    const made = await links().create(project.id, await link(), req);
    expect(made.code).toMatch(/^[0-9A-Za-z]{10}$/);
    await expect(links().create(other.project.id, await link(), req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(links().create(house.id, await link(), req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(brand().setColors(project.id, { primary_color: '#1A56DB' }, await through(token, 'PUT console/projects/:id/brand'))).resolves.toBeTruthy();

    const me = await authController().me(await through(token, 'GET console/auth/me'));
    expect(me).toMatchObject({ kind: 'client', account_kind: 'platform', active_client: { id: acme.id, name: 'Acme' }, clients: [{ id: acme.id, name: 'Acme' }] });
    expect(me.permissions).not.toContain('admin.clients');
  });

  it('switches back to super admin and sees the platform again', async () => {
    const { client: acme } = await partner('Acme', 'acme-shop');
    const valentine = await t.admin();
    const token = await signIn(valentine);
    await attachSelf(acme.id, await through(token, 'POST console/oversight/clients/:id/owners/me'));
    await switchTo(token, acme.id);
    expect((await t.db.selectFrom('administrator').select('last_client_id').where('id', '=', valentine.id).executeTakeFirstOrThrow()).last_client_id).toBe(acme.id);
    // The next sign-in opens where the account worked last.
    const again = await signIn(valentine);
    expect(await auth().resolveSession(again)).toMatchObject({ kind: 'client', activeClientId: acme.id });

    await expect(switchTo(token, null)).resolves.toEqual({ ok: true });
    expect(await auth().resolveSession(token)).toMatchObject({ kind: 'platform', accountKind: 'platform', activeClientId: null });
    const req = await through(token, 'GET console/configuration/countries');
    expect(req.auth.isClient).toBe(false);
    expect(req.auth.has('admin.clients')).toBe(true);
    expect((await authController().me(await through(token, 'GET console/auth/me')))).toMatchObject({ kind: 'platform', account_kind: 'platform', active_client: null, clients: [{ id: acme.id, name: 'Acme' }] });
    // Null resets the last choice: the next sign-in lands on super admin.
    expect((await t.db.selectFrom('administrator').select('last_client_id').where('id', '=', valentine.id).executeTakeFirstOrThrow()).last_client_id).toBeNull();
    expect(await auth().resolveSession(await signIn(valentine))).toMatchObject({ kind: 'platform', activeClientId: null });
  });

  it('a platform account never switches to a partner it does not belong to', async () => {
    const { client: acme } = await partner('Acme', 'acme-shop');
    const valentine = await t.admin();
    const token = await signIn(valentine);
    await expect(switchTo(token, acme.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await auth().resolveSession(token)).toMatchObject({ kind: 'platform', activeClientId: null });
  });

  it('a membership disabled behind the partner view leaves it walled with nothing, until the switch back', async () => {
    const { client: acme } = await partner('Acme', 'acme-shop');
    const valentine = await t.admin();
    const token = await signIn(valentine);
    await attachSelf(acme.id, await through(token, 'POST console/oversight/clients/:id/owners/me'));
    await switchTo(token, acme.id);
    await t.db.updateTable('client_membership').set({ status: 'disabled' }).where('administrator_id', '=', valentine.id).execute();
    expect(await answer(through(token, 'GET console/configuration/countries'))).toBe('NOT_FOUND');
    expect(await answer(through(token, 'GET console/transactions'))).toBe('PERMISSION_DENIED');
    await switchTo(token, null);
    expect(await answer(through(token, 'GET console/configuration/countries'))).toBe('passes');
  });

  it('a client account cannot switch to null', async () => {
    const { client: acme } = await partner('Acme', 'acme-shop');
    const owner = await clientOwner(acme.id);
    const token = await signIn(owner);
    await expect(switchTo(token, null)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await auth().resolveSession(token)).toMatchObject({ kind: 'client', accountKind: 'client', activeClientId: acme.id });
    // A session of a client account left without an active client is still a client's.
    await t.db.updateTable('admin_session').set({ active_client_id: null }).where('administrator_id', '=', owner.id).execute();
    expect(await auth().resolveSession(token)).toMatchObject({ kind: 'client', activeClientId: null });
    expect(await answer(through(token, 'GET console/configuration/countries'))).toBe('NOT_FOUND');
    const me = await authController().me(await through(token, 'GET console/auth/me'));
    expect(me).toMatchObject({ kind: 'client', account_kind: 'client' });
  });

  it('Owner in the super-admin view cannot create a link or set a brand on any project', async () => {
    const { project } = await partner('Acme', 'acme-shop');
    const house = await t.project('platform-shop');
    const valentine = await t.admin();
    const token = await signIn(valentine);
    for (const key of ['POST console/projects/:id/payment-links', 'POST console/projects/:id/payment-links/:lid/disable', 'PUT console/projects/:id/brand', 'POST console/projects/:id/brand/logo']) {
      expect(await answer(through(token, key)), key).toBe('PERMISSION_DENIED');
    }
    // Called past the guard, the handlers refuse too.
    const req = await through(token, 'GET console/projects/:id/payment-links');
    expect(req.auth.has('links.manage')).toBe(false);
    for (const id of [project.id, house.id]) {
      await expect(links().create(id, await link(), req)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(brand().setColors(id, { primary_color: '#1A56DB' }, req)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(brand().setLogo(id, { data_base64: PNG.toString('base64') }, req)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    // Reading stays open to the platform.
    await expect(links().list(project.id, req)).resolves.toEqual({ links: [] });
    expect(await t.db.selectFrom('payment_link').select('id').execute()).toEqual([]);
  });

  it('attach self requires admin.clients and a code, refuses duplicates and disabled clients', async () => {
    const { client: acme } = await partner('Acme', 'acme-shop');
    const key = 'POST console/oversight/clients/:id/owners/me';
    // Without admin.clients: refused by name. A client account, and a platform account in a partner view, never see it.
    expect(await answer(through(await signIn(await staffWith('Support')), key))).toBe('PERMISSION_DENIED');
    expect(await answer(through(await signIn(await clientOwner(acme.id)), key))).toBe('NOT_FOUND');

    const valentine = await t.admin();
    const token = await signIn(valentine);
    const req = await through(token, key);
    await expect(clientsController().attachSelf(acme.id, {}, req)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    // A code asked for another client does not attach to this one.
    const elsewhere = await partner('Elsewhere', 'elsewhere-shop');
    const wrong = await code(valentine.id, 'client.attach_self', { client_id: elsewhere.client.id });
    await expect(clientsController().attachSelf(acme.id, { confirmation: wrong }, req)).rejects.toMatchObject({ code: 'CONFIRMATION_INVALID' });
    expect(await t.db.selectFrom('client_membership').select('id').where('administrator_id', '=', valentine.id).execute()).toEqual([]);

    const done = await attachSelf(acme.id, req);
    const m = await t.db.selectFrom('client_membership').selectAll().where('administrator_id', '=', valentine.id).executeTakeFirstOrThrow();
    expect(done).toEqual({ membership_id: m.id, client_id: acme.id });
    expect(m).toMatchObject({ client_id: acme.id, status: 'active', invited_by: valentine.id, accepted_at: expect.any(Date) });
    const assignment = await t.db.selectFrom('role_assignment as ra').innerJoin('role as r', 'r.id', 'ra.role_id').select(['r.name', 'ra.scope_type']).where('ra.membership_id', '=', m.id).execute();
    expect(assignment).toEqual([{ name: 'Client owner', scope_type: 'client' }]);
    const audit = await t.db.selectFrom('audit_record').select(['actor_id', 'subject_id', 'confirmation_id']).where('action', '=', 'client.attach_self').execute();
    expect(audit).toEqual([{ actor_id: valentine.id, subject_id: m.id, confirmation_id: expect.any(String) }]);
    // The account stays a platform account: attaching is a membership, never a change of kind.
    expect((await t.db.selectFrom('administrator').select('kind').where('id', '=', valentine.id).executeTakeFirstOrThrow()).kind).toBe('platform');

    await expect(attachSelf(acme.id, req)).rejects.toMatchObject({ code: 'CONFLICT' });
    const disabled = await partner('Gone', 'gone-shop');
    await t.db.updateTable('client').set({ status: 'disabled' }).where('id', '=', disabled.client.id).execute();
    await expect(attachSelf(disabled.client.id, req)).rejects.toMatchObject({ code: 'RULE_VIOLATION' });
    await expect(attachSelf('00000000-0000-0000-0000-000000000000', req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await t.db.selectFrom('client_membership').select('client_id').where('administrator_id', '=', valentine.id).execute()).toEqual([{ client_id: acme.id }]);
  });

  it('a platform role is never given links.manage, and one that holds it grants nothing in the super-admin view', async () => {
    const staff = await t.admin();
    const owner = await t.db.selectFrom('role').select('id').where('name', '=', 'Owner').executeTakeFirstOrThrow();
    const current = (await t.db.selectFrom('role_permission').select('permission_key').where('role_id', '=', owner.id).execute()).map((p) => p.permission_key);
    const roles = new RoleService(t.db, get(AuditService), get(AlertService));
    await expect(roles.propose({ kind: 'role_permissions', role_id: owner.id, permissions: [...current, 'links.manage'] as never }, { id: staff.id, permissions: ['admin.roles'] }, 'why'))
      .rejects.toMatchObject({ code: 'FIELD_INVALID', message: 'links.manage belongs to client roles only.' });
    // Written behind the API's back, it still counts for nothing outside a partner's view.
    await t.db.insertInto('role_permission').values({ role_id: owner.id, permission_key: 'links.manage' }).execute();
    expect((await new AuthorisationService(t.db).load(staff.id, null, 'platform')).has('links.manage')).toBe(false);
  });

  it('invitations still refuse a platform address, silently', async () => {
    const { client: acme } = await partner('Acme', 'acme-shop');
    const valentine = await t.admin();
    const invited = await t.db.transaction().execute((tx) => invitations().invite(tx, { clientId: acme.id, name: 'Val', email: valentine.email, language: 'en', profile: 'owner', projectIds: [] }, valentine.id));
    expect(invited.status).toBe('invitation_sent');
    expect(await t.db.selectFrom('client_membership').select('id').where('administrator_id', '=', valentine.id).execute()).toEqual([]);
  });
});
