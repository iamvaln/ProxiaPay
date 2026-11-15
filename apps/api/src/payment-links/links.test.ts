import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { AuthorisationService } from '../admin-auth/authorisation.service';
import { AuditService } from '../audit/audit.service';
import { PaymentLinksController } from '../console-api/payment-links.controller';
import type { ConsoleRequest } from '../console-api/session.guard';
import { filtered } from '../test/filtered';
import { BrandService } from './brand.service';
import { LinksService, newLinkCode } from './links.service';

let t: TestContext;
const get = <T>(token: new (...a: never[]) => T) => t.app.get(token as never) as T;
const BASE = 'https://pay.example.com';
const controller = (base: string | null = BASE) => new PaymentLinksController(t.db, new LinksService(t.db, { PAYLINK_BASE_URL: base ?? undefined }, get(AuditService), new BrandService(t.db, get(AuditService))));

beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(async () => { await t.reset(); });

async function clientPerson(clientId: string, roleName: string) {
  const a = await t.admin();
  await t.db.deleteFrom('role_assignment').where('administrator_id', '=', a.id).execute();
  await t.db.updateTable('administrator').set({ kind: 'client' }).where('id', '=', a.id).execute();
  const m = await t.db.insertInto('client_membership').values({ administrator_id: a.id, client_id: clientId, status: 'active', accepted_at: new Date() }).returning('id').executeTakeFirstOrThrow();
  const role = await t.db.selectFrom('role').select('id').where('name', '=', roleName).executeTakeFirstOrThrow();
  await t.db.insertInto('role_assignment').values({ administrator_id: a.id, role_id: role.id, scope_type: 'client', membership_id: m.id }).execute();
  return a;
}
async function requestOf(admin: { id: string; email: string }, clientId: string): Promise<ConsoleRequest> {
  return {
    principal: { sessionId: '00000000-0000-0000-0000-00000000005e', administratorId: admin.id, name: 'Test', email: admin.email, language: 'en', timezone: 'UTC', secondFactorComplete: true, kind: 'client', activeClientId: clientId },
    auth: await new AuthorisationService(t.db).load(admin.id, clientId),
    clientAddress: '127.0.0.1', clientDescription: 'vitest',
  } as unknown as ConsoleRequest;
}
/** A client's project with an entitlement on every seeded route. */
async function acme(code = 'acme-shop') {
  const client = await t.db.insertInto('client').values({ name: `Acme ${code}` }).returning('id').executeTakeFirstOrThrow();
  const project = await t.project(code);
  await t.db.updateTable('project').set({ client_id: client.id }).where('id', '=', project.id).execute();
  return { client, project };
}
const routeId = async (country: string, method: string, currency: string, direction = 'collection') =>
  (await t.db.selectFrom('route').select('id').where('country_code', '=', country).where('payment_method_code', '=', method).where('currency_code', '=', currency).where('direction', '=', direction).executeTakeFirstOrThrow()).id;
const xafRoutes = async () => [await routeId('CM', 'MOMO', 'XAF'), await routeId('GA', 'AIRTEL', 'XAF').catch(async () => (await t.db.selectFrom('route').select('id').where('currency_code', '=', 'XAF').where('direction', '=', 'collection').where('country_code', '<>', 'CM').limit(1).executeTakeFirstOrThrow()).id)];
/** Route versions are closed, never edited; a test that needs a variant of the open one lifts the guard for that statement. */
async function patchVersion(routeId: string, patch: { active?: boolean; otp_required?: boolean; browser_required?: boolean }) {
  await sql`alter table route_version disable trigger route_version_close_only`.execute(t.db);
  try { await t.db.updateTable('route_version').set(patch).where('route_id', '=', routeId).where('valid_to', 'is', null).execute(); }
  finally { await sql`alter table route_version enable trigger route_version_close_only`.execute(t.db); }
}
const fixed = (route_ids: string[], extra: object = {}) => ({ title: 'Invoice 42', currency: 'XAF', amount_type: 'fixed', amount: 5000, route_ids, ...extra });

describe('payment links in the console API', () => {
  it('a client owner creates a fixed link over routes of two countries in XAF', async () => {
    const { client, project } = await acme();
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    const routes = await xafRoutes();
    const made = await controller().create(project.id, fixed(routes), req);
    expect(made.code).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(made.url).toBe(`${BASE}/${made.code}`);
    const { links } = await controller().list(project.id, req);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ id: made.id, code: made.code, url: made.url, title: 'Invoice 42', amount_type: 'fixed', amount: 5000, minimum_amount: 0, currency: 'XAF', single_use: false, expires_at: null, status: 'active', payments: { count: 0, succeeded: 0, total_collected: 0, last_at: null } });
    expect(links[0]!.methods).toHaveLength(2);
    expect(new Set(links[0]!.methods.map((m) => m.country)).size).toBe(2);
    expect(links[0]!.methods[0]).toEqual({ country: expect.any(String), payment_method: expect.any(String), payment_method_name: expect.any(String) });
    expect(await controller().detail(project.id, made.id, req)).toEqual(links[0]);
    expect((await t.db.selectFrom('audit_record').select('action').where('subject_id', '=', made.id).execute()).map((r) => r.action)).toEqual(['payment_link.create']);
  });

  it('refuses a route in another currency, an inactive route, a route without entitlement', async () => {
    const { client, project } = await acme();
    const bare = await t.db.insertInto('project').values({ code: 'bare', name: 'Bare', client_id: client.id }).returning('id').executeTakeFirstOrThrow();
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    const cm = await routeId('CM', 'MOMO', 'XAF');
    const other = (await t.db.selectFrom('route').select('id').where('currency_code', '<>', 'XAF').where('direction', '=', 'collection').limit(1).executeTakeFirstOrThrow()).id;
    const refused = { code: 'FIELD_INVALID', options: { field: 'route_ids' } };
    await expect(controller().create(project.id, fixed([cm, other]), req)).rejects.toMatchObject(refused);

    await patchVersion(cm, { active: false });
    await expect(controller().create(project.id, fixed([cm]), req)).rejects.toMatchObject(refused);
    await patchVersion(cm, { active: true });

    const ent = await t.db.selectFrom('entitlement').select('id').where('project_id', '=', project.id).where('route_id', '=', cm).executeTakeFirstOrThrow();
    await t.db.updateTable('entitlement_version').set({ active: false }).where('entitlement_id', '=', ent.id).where('valid_to', 'is', null).execute();
    await expect(controller().create(project.id, fixed([cm]), req)).rejects.toMatchObject(refused);
    // A project of the same client that was never granted the route.
    await expect(controller().create(bare.id, fixed([cm]), req)).rejects.toMatchObject(refused);
    expect(await t.db.selectFrom('payment_link').select('id').execute()).toEqual([]);
  });

  it('refuses a route where the payer must type a code or open a page, and a disbursement route', async () => {
    const { client, project } = await acme();
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    const cm = await routeId('CM', 'MOMO', 'XAF');
    const refused = { code: 'FIELD_INVALID', options: { field: 'route_ids' } };
    for (const column of ['otp_required', 'browser_required'] as const) {
      await patchVersion(cm, { [column]: true });
      await expect(controller().create(project.id, fixed([cm]), req)).rejects.toMatchObject(refused);
      await patchVersion(cm, { [column]: false });
    }
    await expect(controller().create(project.id, fixed([await routeId('CM', 'MOMO', 'XAF', 'disbursement')]), req)).rejects.toMatchObject(refused);
  });

  it('refuses a fixed amount below a route minimum, or above its maximum, and a free minimum above a maximum', async () => {
    const { client, project } = await acme();
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    const cm = await routeId('CM', 'MOMO', 'XAF');
    const rv = await t.db.selectFrom('route_version').select(['minimum_amount', 'maximum_amount']).where('route_id', '=', cm).where('valid_to', 'is', null).executeTakeFirstOrThrow();
    if (rv.minimum_amount > 1) await expect(controller().create(project.id, fixed([cm], { amount: rv.minimum_amount - 1 }), req)).rejects.toMatchObject({ code: 'AMOUNT_INVALID' });
    await expect(controller().create(project.id, fixed([cm], { amount: rv.maximum_amount + 1 }), req)).rejects.toMatchObject({ code: 'AMOUNT_INVALID', options: { field: 'amount' } });
    await expect(controller().create(project.id, { title: 'Gift', currency: 'XAF', amount_type: 'free', minimum_amount: rv.maximum_amount + 1, route_ids: [cm] }, req)).rejects.toMatchObject({ code: 'AMOUNT_INVALID', options: { field: 'minimum_amount' } });
    // A project's narrower limit counts, not just the route's.
    const ent = await t.db.selectFrom('entitlement').select('id').where('project_id', '=', project.id).where('route_id', '=', cm).executeTakeFirstOrThrow();
    await t.db.updateTable('entitlement_version').set({ maximum_amount: 3000 }).where('entitlement_id', '=', ent.id).where('valid_to', 'is', null).execute();
    await expect(controller().create(project.id, fixed([cm], { amount: 5000 }), req)).rejects.toMatchObject({ code: 'AMOUNT_INVALID' });
    await expect(controller().create(project.id, fixed([cm], { amount: 3000 }), req)).resolves.toBeTruthy();
  });

  it('copies the project brand when none is given, and a given logo must belong to the project', async () => {
    const { client, project } = await acme();
    const other = await acme('other-shop');
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    const brand = new BrandService(t.db, get(AuditService));
    await t.db.transaction().execute(async (tx) => {
      await brand.setLogo(tx, project.id, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]), project.adminId);
      await brand.setColors(tx, project.id, { primary_color: '#1A56DB', secondary_color: '#0E7490' }, project.adminId);
    });
    const cm = await routeId('CM', 'MOMO', 'XAF');
    const made = await controller().create(project.id, fixed([cm]), req);
    const row = await t.db.selectFrom('payment_link').select(['logo_asset_id', 'primary_color', 'secondary_color']).where('id', '=', made.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ ...(await brand.get(project.id)), });
    expect(row).toMatchObject({ primary_color: '#1A56DB', secondary_color: '#0E7490', logo_asset_id: expect.any(String) });
    // Changing the project's brand afterwards leaves the link as it was shared.
    await t.db.transaction().execute((tx) => brand.setColors(tx, project.id, { primary_color: '#0E7490' }, project.adminId));
    expect((await t.db.selectFrom('payment_link').select('primary_color').where('id', '=', made.id).executeTakeFirstOrThrow()).primary_color).toBe('#1A56DB');

    const foreign = await t.db.insertInto('brand_asset').values({ project_id: other.project.id, bytes: Buffer.alloc(4), content_type: 'image/png', sha256: 'x' }).returning('id').executeTakeFirstOrThrow();
    await expect(controller().create(project.id, fixed([cm], { brand: { logo_asset_id: foreign.id } }), req)).rejects.toMatchObject({ code: 'FIELD_INVALID', options: { field: 'brand.logo_asset_id' } });
    await expect(controller().create(project.id, fixed([cm], { brand: { primary_color: '#FFFF00' } }), req)).rejects.toMatchObject({ options: { field: 'brand.primary_color' } });
    const own = await controller().create(project.id, fixed([cm], { brand: { primary_color: '#7C2D12' } }), req);
    expect(await t.db.selectFrom('payment_link').select(['primary_color', 'secondary_color']).where('id', '=', own.id).executeTakeFirstOrThrow()).toEqual({ primary_color: '#7C2D12', secondary_color: null });
  });

  it('a client developer cannot create or disable; finance can list', async () => {
    const { client, project } = await acme();
    const owner = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    const cm = await routeId('CM', 'MOMO', 'XAF');
    const made = await controller().create(project.id, fixed([cm]), owner);
    const developer = await requestOf(await clientPerson(client.id, 'Client developer'), client.id);
    const finance = await requestOf(await clientPerson(client.id, 'Client finance'), client.id);
    for (const req of [developer, finance]) {
      await expect(controller().create(project.id, fixed([cm]), req)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(controller().disable(project.id, made.id, req)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect((await controller().list(project.id, finance)).links).toHaveLength(1);
    await controller().disable(project.id, made.id, owner);
    expect((await controller().detail(project.id, made.id, finance)).status).toBe('disabled');
    // Disabling twice changes nothing and is audited once.
    await controller().disable(project.id, made.id, owner);
    expect((await t.db.selectFrom('audit_record').select('action').where('subject_id', '=', made.id).orderBy('id').execute()).map((r) => r.action)).toEqual(['payment_link.create', 'payment_link.disable']);
  });

  it('refuses :lid of another project, and another client\'s project', async () => {
    const a = await acme('proj-a');
    const b = await acme('proj-b');
    const a2 = await t.project('proj-a2');
    await t.db.updateTable('project').set({ client_id: a.client.id }).where('id', '=', a2.id).execute();
    const reqA = await requestOf(await clientPerson(a.client.id, 'Client owner'), a.client.id);
    const reqB = await requestOf(await clientPerson(b.client.id, 'Client owner'), b.client.id);
    const cm = await routeId('CM', 'MOMO', 'XAF');
    const inB = await controller().create(b.project.id, fixed([cm]), reqB);
    // A second project of the same client: its link is not reachable through the first project's path.
    const inA2 = await controller().create(a2.id, fixed([cm]), reqA);
    for (const lid of [inB.id, inA2.id]) {
      await expect(controller().detail(a.project.id, lid, reqA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(controller().disable(a.project.id, lid, reqA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    await expect(controller().detail(b.project.id, inB.id, reqA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(controller().create(b.project.id, fixed([cm]), reqA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await t.db.selectFrom('payment_link').select('status').where('id', '=', inB.id).executeTakeFirstOrThrow()).status).toBe('active');
  });

  it('a malformed :lid answers like a missing link, not a fault', async () => {
    const { client, project } = await acme();
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    for (const call of [() => controller().detail(project.id, 'not-a-uuid', req), () => controller().disable(project.id, 'not-a-uuid', req)]) {
      const error = await call().then(() => null, (e: unknown) => e);
      expect(filtered(error)).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'No such resource.', retryable: false } } });
    }
  });

  it('refuses creation when PAYLINK_BASE_URL is unset', async () => {
    const { client, project } = await acme();
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    await expect(controller(null).create(project.id, fixed([await routeId('CM', 'MOMO', 'XAF')]), req)).rejects.toMatchObject({ code: 'RULE_VIOLATION', message: 'Payment links are not configured on this platform.' });
    expect(await t.db.selectFrom('payment_link').select('id').execute()).toEqual([]);
  });

  it('validates the body: title, amount kind, future expiry, at least one route', async () => {
    const { client, project } = await acme();
    const req = await requestOf(await clientPerson(client.id, 'Client owner'), client.id);
    const cm = await routeId('CM', 'MOMO', 'XAF');
    await expect(controller().create(project.id, fixed([cm], { title: '' }), req)).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    await expect(controller().create(project.id, fixed([cm], { description: 'x'.repeat(501) }), req)).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    await expect(controller().create(project.id, fixed([]), req)).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    await expect(controller().create(project.id, fixed([cm], { expires_at: new Date(Date.now() - 1000).toISOString() }), req)).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    await expect(controller().create(project.id, fixed([cm], { amount: undefined }), req)).rejects.toMatchObject({ code: 'AMOUNT_INVALID' });
    await expect(controller().create(project.id, { title: 'x', currency: 'XAF', amount_type: 'free', amount: 100, route_ids: [cm] }, req)).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    const ok = await controller().create(project.id, { title: 'x', currency: 'XAF', amount_type: 'free', minimum_amount: 500, single_use: true, expires_at: new Date(Date.now() + 86_400_000).toISOString(), route_ids: [cm, cm] }, req);
    expect(await controller().detail(project.id, ok.id, req)).toMatchObject({ amount_type: 'free', amount: null, minimum_amount: 500, single_use: true, methods: [expect.anything()] });
  });

  it('draws codes from base62', () => {
    const codes = new Set(Array.from({ length: 200 }, newLinkCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^[0-9A-Za-z]{10}$/);
  });
});
