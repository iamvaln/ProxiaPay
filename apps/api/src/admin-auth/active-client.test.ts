import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { AdminAuthService } from './admin-auth.service';
import { AuthorisationService } from './authorisation.service';
import { ConsoleAuthController } from '../console-api/auth.controller';
import { CryptoService } from '../crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { ConfirmationService } from './confirmation.service';
import { AuditService } from '../audit/audit.service';

let t: TestContext;
beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(() => t.reset());

const client = { address: '10.0.0.1', description: 'test' };
const auth = () => new AdminAuthService(t.db, t.app.get(CryptoService), t.app.get(SettingsService), t.app.get(AuditService), { SANDBOX_ANY_SECOND_FACTOR: false });
const authorisation = () => new AuthorisationService(t.db);
const controller = () => new ConsoleAuthController(t.db, { TRUSTED_PROXY_HOPS: 0, NODE_ENV: 'test', PROXIAPAY_ENV: 'sandbox' }, auth(), t.app.get(SettingsService), {} as ConfirmationService);

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
async function membership(adminId: string, clientId: string, roleName: string, opts: { status?: string; createdAt?: Date } = {}) {
  const m = await t.db.insertInto('client_membership').values({ administrator_id: adminId, client_id: clientId, status: opts.status ?? 'active', ...(opts.createdAt ? { created_at: opts.createdAt } : {}) }).returning('id').executeTakeFirstOrThrow();
  const role = await t.db.selectFrom('role').select('id').where('name', '=', roleName).executeTakeFirstOrThrow();
  await t.db.insertInto('role_assignment').values({ administrator_id: adminId, role_id: role.id, scope_type: 'client', membership_id: m.id }).execute();
  return m;
}
async function signIn(email: string, password: string) {
  const r = await auth().signIn(email, password, client);
  if (!('sessionToken' in r)) throw new Error('locked');
  return (await auth().resolveSession(r.sessionToken))!;
}
const twoClients = async () => {
  const a = await newClient('A');
  const b = await newClient('B');
  const person = await clientPerson();
  await membership(person.id, a.id, 'Client owner', { createdAt: new Date('2026-01-01') });
  await membership(person.id, b.id, 'Client owner', { createdAt: new Date('2026-02-01') });
  return { a, b, person };
};

describe('the active client of a session', () => {
  it('signs a two-client person in on the client used last', async () => {
    const { a, b, person } = await twoClients();
    expect((await signIn(person.email, person.password)).activeClientId).toBe(a.id); // oldest membership
    await t.db.updateTable('administrator').set({ last_client_id: b.id }).where('id', '=', person.id).execute();
    const p = await signIn(person.email, person.password);
    expect(p.activeClientId).toBe(b.id);
    expect(p.kind).toBe('client');
    // A last client whose membership is no longer active falls back to the oldest active one.
    await t.db.updateTable('client_membership').set({ status: 'disabled' }).where('client_id', '=', b.id).execute();
    expect((await signIn(person.email, person.password)).activeClientId).toBe(a.id);
  });

  it('leaves platform staff without an active client', async () => {
    const staff = await t.admin();
    const p = await signIn(staff.email, staff.password);
    expect(p.kind).toBe('platform');
    expect(p.activeClientId).toBeNull();
  });

  it('refuses sign-in without an active membership, like a wrong password, and records why', async () => {
    const c = await newClient('A');
    const person = await clientPerson();
    await membership(person.id, c.id, 'Client owner', { status: 'disabled' });
    await expect(auth().signIn(person.email, person.password, client)).rejects.toMatchObject({ code: 'CREDENTIALS_INVALID', message: 'The address and password did not match.' });
    const ev = await t.db.selectFrom('authentication_event').select(['outcome', 'reason']).where('administrator_id', '=', person.id).execute();
    expect(ev).toEqual([{ outcome: 'failure', reason: 'no active client' }]);
  });

  it('switches client and the next authorisation load sees only the new client\'s projects', async () => {
    const { a, b, person } = await twoClients();
    const pa = await newProject(a.id, 'a-1');
    const pb = await newProject(b.id, 'b-1');
    const p = await signIn(person.email, person.password);
    expect((await authorisation().load(p.administratorId, p.activeClientId)).projectScope('projects.credentials')).toEqual([pa.id]);
    await expect(controller().switchClient({ client_id: b.id }, { principal: p } as never)).resolves.toEqual({ ok: true });
    const next = (await auth().resolveSession(await tokenOf(p.sessionId)))!;
    expect(next.activeClientId).toBe(b.id);
    expect((await authorisation().load(next.administratorId, next.activeClientId)).projectScope('projects.credentials')).toEqual([pb.id]);
    const admin = await t.db.selectFrom('administrator').select('last_client_id').where('id', '=', person.id).executeTakeFirstOrThrow();
    expect(admin.last_client_id).toBe(b.id);
  });

  it('refuses to switch to a client the person does not belong to, as not found', async () => {
    const { a, person } = await twoClients();
    const stranger = await newClient('Stranger');
    const p = await signIn(person.email, person.password);
    await expect(controller().switchClient({ client_id: stranger.id }, { principal: p } as never)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await t.db.updateTable('client_membership').set({ status: 'disabled' }).where('client_id', '=', a.id).execute();
    await expect(controller().switchClient({ client_id: a.id }, { principal: p } as never)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses sign-in for an invited account without a password, with the wrong-password message, and counts it', async () => {
    const c = await newClient('A');
    const person = await clientPerson();
    await membership(person.id, c.id, 'Client owner');
    await t.db.updateTable('administrator').set({ password_hash: null }).where('id', '=', person.id).execute();
    await expect(auth().signIn(person.email, 'whatever-password-12', client)).rejects.toMatchObject({ code: 'CREDENTIALS_INVALID', message: 'The address and password did not match.' });
    const ev = await t.db.selectFrom('authentication_event').select(['outcome', 'reason']).where('administrator_id', '=', person.id).execute();
    expect(ev).toEqual([{ outcome: 'failure', reason: 'password mismatch' }]);
    // Repeated attempts count toward lockout like any wrong password.
    for (let i = 0; i < 10; i++) await auth().signIn(person.email, 'whatever-password-12', client).catch(() => undefined);
    const locked = await t.db.selectFrom('administrator').select('locked_until').where('id', '=', person.id).executeTakeFirstOrThrow();
    expect(locked.locked_until).not.toBeNull();
  });

  it('reports kind, active client and active memberships in me', async () => {
    const { a, b, person } = await twoClients();
    await t.db.updateTable('client_membership').set({ status: 'disabled' }).where('client_id', '=', b.id).execute();
    const p = await signIn(person.email, person.password);
    const me = await controller().me({ principal: { ...p, secondFactorComplete: true }, auth: await authorisation().load(p.administratorId, p.activeClientId) } as never);
    expect(me).toMatchObject({ kind: 'client', active_client: { id: a.id, name: 'A' }, clients: [{ id: a.id, name: 'A' }] });
  });
});

async function tokenOf(sessionId: string) {
  // Sessions are stored by token hash, so mint a lookup by swapping in a known token.
  const token = CryptoService.randomToken(32);
  await t.db.updateTable('admin_session').set({ token_hash: CryptoService.tokenHash(token) }).where('id', '=', sessionId).execute();
  return token;
}
