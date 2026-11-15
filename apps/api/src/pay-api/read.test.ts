import 'reflect-metadata';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestContext, type TestContext } from '../test/context';
import { consoleRoutes } from '../test/console-routes';
import { AppModule } from '../app.module';
import { ConsoleApiModule } from '../console-api/console-api.module';
import { configureBodyParsers } from '../http/body-parsers';
import { RateLimiter } from '../project-auth/rate-limiter';
import { PreviewService } from '../transactions/preview.service';
import { PublicLinkService, linkPrincipal, type PublicLinkView } from '../payment-links/public-view';
import { PayApiController } from './pay-api.controller';
import { PayApiModule } from './pay-api.module';

/** The whole application, as main.ts builds it, called over HTTP with no session and no credential. */
let t: TestContext;
let app: INestApplication;
let base: string;
let project: { id: string; adminId: string };

beforeAll(async () => {
  t = await createTestContext();
  const nest = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: ['error'], abortOnError: false, bodyParser: true });
  configureBodyParsers(nest);
  await nest.listen(0, '127.0.0.1');
  app = nest;
  base = await nest.getUrl();
});
afterAll(async () => { await app?.close(); await t.close(); });
beforeEach(async () => {
  await t.reset();
  project = await t.project('acme-shop');
  await t.db.updateTable('project').set({ name: 'Acme Shop' }).where('id', '=', project.id).execute();
});

const routeId = async (country: string, method: string, currency = 'XAF') =>
  (await t.db.selectFrom('route').select('id').where('country_code', '=', country).where('payment_method_code', '=', method).where('currency_code', '=', currency).where('direction', '=', 'collection').executeTakeFirstOrThrow()).id;
/** Route versions are closed, never edited; a test that needs a variant of the open one lifts the guard for that statement. */
async function patchVersion(route: string, patch: { active?: boolean; otp_required?: boolean; browser_required?: boolean }) {
  await sql`alter table route_version disable trigger route_version_close_only`.execute(t.db);
  try { await t.db.updateTable('route_version').set(patch).where('route_id', '=', route).where('valid_to', 'is', null).execute(); }
  finally { await sql`alter table route_version enable trigger route_version_close_only`.execute(t.db); }
}
let codes = 0;
async function link(routes: string[], opts: { amount_type?: 'fixed' | 'free'; amount?: number | null; minimum_amount?: number; status?: string; expires_at?: Date | null; logo_asset_id?: string | null; projectId?: string } = {}) {
  const amountType = opts.amount_type ?? 'fixed';
  const row = await t.db.insertInto('payment_link').values({
    code: `Code${String(++codes).padStart(6, '0')}`, project_id: opts.projectId ?? project.id, title: 'Invoice 42', description: 'November subscription', currency_code: 'XAF',
    amount_type: amountType, amount: amountType === 'fixed' ? (opts.amount ?? 5000) : null, minimum_amount: opts.minimum_amount ?? 0, status: opts.status ?? 'active',
    expires_at: opts.expires_at ?? null, logo_asset_id: opts.logo_asset_id ?? null, primary_color: '#1A56DB', created_by: project.adminId,
  }).returning(['id', 'code', 'project_id']).executeTakeFirstOrThrow();
  const keys = await t.db.insertInto('payment_link_route').values(routes.map((route_id) => ({ link_id: row.id, route_id }))).returning(['id', 'route_id']).execute();
  return { ...row, keys: Object.fromEntries(keys.map((k) => [k.route_id, k.id])) as Record<string, string> };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of the image')]);
const asset = async () => (await t.db.insertInto('brand_asset').values({ project_id: project.id, bytes: PNG, content_type: 'image/png', sha256: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
const get = (path: string) => fetch(`${base}${path}`);
const viewOf = async (code: string) => (await (await get(`/pay-api/v1/links/${code}`)).json()) as PublicLinkView;
const quote = (code: string, body: unknown) => fetch(`${base}/pay-api/v1/links/${code}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('reading a payment link', () => {
  it('shows a fixed link with per-method charged amount and no internal ids', async () => {
    const [momo, om, airtel] = [await routeId('CM', 'MOMO'), await routeId('CM', 'OM'), await routeId('GA', 'AIRTEL')];
    const l = await link([momo, om, airtel]);
    const res = await get(`/pay-api/v1/links/${l.code}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const view = JSON.parse(text);
    expect(view).toEqual({
      code: l.code, project_name: 'Acme Shop', title: 'Invoice 42', description: 'November subscription', amount_type: 'fixed', amount: 5000, minimum_amount: 0,
      currency: 'XAF', exponent: 0, sandbox: true,
      brand: { logo_url: null, primary_color: '#1A56DB', secondary_color: null },
      countries: [{ code: 'CM', name: 'Cameroon', dialling_prefix: '+237' }, { code: 'GA', name: 'Gabon', dialling_prefix: '+241' }],
      methods: expect.any(Array),
    });
    // 2.5 % processing borne by the payer on the seeded routes.
    expect(view.methods).toEqual(expect.arrayContaining([
      { key: l.keys[momo], country: 'CM', name: 'MTN Mobile Money', minimum_amount: 100, maximum_amount: 1_000_000, charged_amount: 5125 },
      { key: l.keys[om], country: 'CM', name: 'Orange Money', minimum_amount: 100, maximum_amount: 1_000_000, charged_amount: 5125 },
      { key: l.keys[airtel], country: 'GA', name: 'Airtel Money', minimum_amount: 100, maximum_amount: 1_000_000, charged_amount: 5125 },
    ]));
    expect(view.methods).toHaveLength(3);
    for (const word of ['route_id', 'project_id', 'provider', 'margin', 'expected_fee', 'payer_action', 'Simulator', 'entitlement', 'created_by', project.id, project.adminId, momo, om, airtel]) expect(text).not.toContain(word);
  });

  it('a free link lists each method with its floor and no charged amount', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { amount_type: 'free', minimum_amount: 500 });
    const view = await viewOf(l.code);
    expect(view).toMatchObject({ amount_type: 'free', amount: null, minimum_amount: 500 });
    // The floor is the higher of the link's minimum and the route's.
    expect(view.methods).toEqual([{ key: l.keys[momo], country: 'CM', name: 'MTN Mobile Money', minimum_amount: 500, maximum_amount: 1_000_000 }]);
  });

  it('one neutral answer for unknown, disabled, expired, completed', async () => {
    const momo = await routeId('CM', 'MOMO');
    const disabled = await link([momo], { status: 'disabled' });
    const completed = await link([momo], { status: 'completed' });
    const expired = await link([momo], { expires_at: new Date(Date.now() - 1000) });
    const answers = [];
    for (const code of ['Zzzzzzzzzz', disabled.code, completed.code, expired.code, 'not-a-code', '00000000-0000-0000-0000-000000000000']) {
      const res = await get(`/pay-api/v1/links/${code}`);
      answers.push({ status: res.status, body: await res.json() });
    }
    for (const a of answers) expect(a).toEqual({ status: 404, body: { error: { code: 'LINK_UNAVAILABLE', message: 'This link is no longer available', retryable: false } } });
    // A quote on an unavailable link answers the same.
    const res = await quote(disabled.code, { method: disabled.keys[momo], amount: 5000 });
    expect({ status: res.status, body: await res.json() }).toEqual(answers[0]);
    // A link still within its expiry is shown.
    const later = await link([momo], { expires_at: new Date(Date.now() + 3600_000) });
    expect((await get(`/pay-api/v1/links/${later.code}`)).status).toBe(200);
  });

  it('drops a method whose route was deactivated', async () => {
    const [momo, om, airtel, moov] = [await routeId('CM', 'MOMO'), await routeId('CM', 'OM'), await routeId('GA', 'AIRTEL'), await routeId('GA', 'MOOV')];
    const l = await link([momo, om, airtel, moov]);
    const methods = async () => (await viewOf(l.code)).methods.map((m) => m.key).sort();
    expect(await methods()).toHaveLength(4);

    await patchVersion(momo, { active: false });
    // A route that now asks the payer to type a code is no use on a page where nothing is typed.
    await patchVersion(om, { otp_required: true });
    const ent = await t.db.selectFrom('entitlement').select('id').where('project_id', '=', project.id).where('route_id', '=', airtel).executeTakeFirstOrThrow();
    await t.db.updateTable('entitlement_version').set({ active: false }).where('entitlement_id', '=', ent.id).where('valid_to', 'is', null).execute();
    const view = await viewOf(l.code);
    expect(view.methods.map((m) => m.key)).toEqual([l.keys[moov]]);
    // A country left with no method is not offered.
    expect(view.countries.map((c) => c.code)).toEqual(['GA']);

    await t.db.updateTable('country').set({ active: false }).where('code', '=', 'GA').execute();
    expect(await methods()).toEqual([]);
    await t.db.updateTable('country').set({ active: true }).where('code', '=', 'GA').execute();
    // Nor can a dropped method be quoted.
    await t.db.updateTable('country').set({ active: false }).where('code', '=', 'GA').execute();
    const res = await quote(l.code, { method: l.keys[momo], amount: 5000 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'FIELD_INVALID', field: 'method', message: 'This payment method is not available on this link.' } });
  });

  it('a suspended project\'s link is as unavailable as an unknown one, for read, quote and logo', async () => {
    const momo = await routeId('CM', 'MOMO');
    const logo = await asset();
    const l = await link([momo], { logo_asset_id: logo });
    await t.db.updateTable('project').set({ status: 'suspended' }).where('id', '=', project.id).execute();
    const gone = { error: { code: 'LINK_UNAVAILABLE', message: 'This link is no longer available', retryable: false } };
    const read = await get(`/pay-api/v1/links/${l.code}`);
    expect(read.status).toBe(404);
    expect(await read.json()).toEqual(gone);
    const q = await quote(l.code, { method: l.keys[momo] });
    expect(q.status).toBe(404);
    expect(await q.json()).toEqual(gone);
    expect((await get(`/pay-api/v1/assets/${logo}`)).status).toBe(404);
  });

  it('a fixed amount outside a method\'s current limits drops that method', async () => {
    const [momo, om] = [await routeId('CM', 'MOMO'), await routeId('CM', 'OM')];
    const l = await link([momo, om], { amount: 5000 });
    const ent = await t.db.selectFrom('entitlement').select('id').where('project_id', '=', project.id).where('route_id', '=', om).executeTakeFirstOrThrow();
    await t.db.updateTable('entitlement_version').set({ maximum_amount: 3000 }).where('entitlement_id', '=', ent.id).where('valid_to', 'is', null).execute();
    const view = await viewOf(l.code);
    expect(view.methods.map((m) => m.key)).toEqual([l.keys[momo]]);
  });
});

describe('quoting a payment link', () => {
  it('quote for a free link matches what a preview would charge', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { amount_type: 'free', minimum_amount: 500 });
    const res = await quote(l.code, { method: l.keys[momo], amount: 2000 });
    expect(res.status).toBe(200);
    const q = (await res.json()) as { charged_amount: number; fees_borne_by_payer: number };
    expect(q).toEqual({ charged_amount: 2050, fees_borne_by_payer: 50 });
    // Nothing is created by a quote.
    expect(await t.db.selectFrom('preview').select('id').execute()).toEqual([]);

    const project_ = await t.db.selectFrom('project').select(['id as project_id', 'code']).where('id', '=', project.id).executeTakeFirstOrThrow();
    const preview = await t.app.get(PreviewService).create(linkPrincipal({ project_id: project_.project_id, project_code: project_.code }), {
      direction: 'collection', amount: 2000, currency: 'XAF', country: 'CM', payment_method: 'MOMO', counterparty: { msisdn: '+237677123456' }, reference: `PL-${l.code}-test`,
    });
    expect(q.charged_amount).toBe(preview.charged_amount);
    expect(q.fees_borne_by_payer).toBe(preview.charged_amount - preview.requested_amount);
  });

  it('refuses a free amount below the floor, above the maximum, zero, negative or fractional', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { amount_type: 'free', minimum_amount: 500 });
    const refusal = async (amount: unknown) => { const r = await quote(l.code, { method: l.keys[momo], amount }); return { status: r.status, body: await r.json() }; };
    expect(await refusal(499)).toEqual({ status: 400, body: { error: { code: 'FIELD_INVALID', field: 'amount', message: 'The amount must be at least 500 XAF.', retryable: false } } });
    expect(await refusal(1_000_001)).toEqual({ status: 400, body: { error: { code: 'FIELD_INVALID', field: 'amount', message: 'The amount must be at most 1000000 XAF.', retryable: false } } });
    for (const bad of [0, -1, 10.5, '2000', undefined]) expect(await refusal(bad)).toMatchObject({ status: 400, body: { error: { code: 'FIELD_INVALID', field: 'amount' } } });
  });

  it('a fixed link quotes its own amount', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { amount: 5000 });
    const ok = await quote(l.code, { method: l.keys[momo] });
    expect(await ok.json()).toEqual({ charged_amount: 5125, fees_borne_by_payer: 125 });
    // Its own amount stated, or null, is the same as none.
    for (const amount of [5000, null]) expect(await (await quote(l.code, { method: l.keys[momo], amount })).json()).toEqual({ charged_amount: 5125, fees_borne_by_payer: 125 });
    const other = await quote(l.code, { method: l.keys[momo], amount: 100 });
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: { code: 'FIELD_INVALID', field: 'amount' } });
  });

  it('refuses, without the provider\'s figure or wording, an amount no provider takes', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { amount_type: 'free' });
    const rv = await t.db.selectFrom('route_version').select('id').where('route_id', '=', momo).where('valid_to', 'is', null).executeTakeFirstOrThrow();
    await sql`alter table route_binding disable trigger route_binding_immutable`.execute(t.db);
    try { await t.db.updateTable('route_binding').set({ maximum_amount: 3000 }).where('route_version_id', '=', rv.id).execute(); }
    finally { await sql`alter table route_binding enable trigger route_binding_immutable`.execute(t.db); }
    const res = await quote(l.code, { method: l.keys[momo], amount: 5000 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'FIELD_INVALID', field: 'amount', message: 'This amount cannot be paid with this method.', retryable: false } });
    expect((await quote(l.code, { method: l.keys[momo], amount: 2000 })).status).toBe(200);
  });

  it('a method key from another link is unknown', async () => {
    const momo = await routeId('CM', 'MOMO');
    const mine = await link([momo], { amount_type: 'free' });
    const theirs = await link([momo], { amount_type: 'free' });
    const unavailable = { status: 400, body: { error: { code: 'FIELD_INVALID', field: 'method', message: 'This payment method is not available on this link.', retryable: false } } };
    for (const method of [theirs.keys[momo], momo, '00000000-0000-0000-0000-000000000000', 'not-a-key', 42]) {
      const res = await quote(mine.code, { method, amount: 2000 });
      expect({ status: res.status, body: await res.json() }).toEqual(unavailable);
    }
    // The key works on its own link.
    expect((await quote(theirs.code, { method: theirs.keys[momo], amount: 2000 })).status).toBe(200);
  });

  it('limits quotes to 60 a minute per address, with a plain 429', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { amount_type: 'free' });
    const limiter = t.app.get(RateLimiter);
    for (let i = 0; i < 60; i++) await limiter.hit('paylink:quote:127.0.0.1', 60, 60);
    const res = await quote(l.code, { method: l.keys[momo], amount: 2000 });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests from this connection. Wait a minute and try again.', retryable: true } });
  });
});

describe('reading a payment link', () => {
  it('limits reads to 300 a minute per address, with a plain 429', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const limiter = t.app.get(RateLimiter);
    for (let i = 0; i < 300; i++) await limiter.hit('paylink:read:127.0.0.1', 300, 60);
    const res = await get(`/pay-api/v1/links/${l.code}`);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests from this connection. Wait a minute and try again.', retryable: true } });
  });
});

describe('serving a logo', () => {
  it('an asset not referenced by an active link or brand is 404', async () => {
    const momo = await routeId('CM', 'MOMO');
    const [loose, onBrand, onDisabled, onActive] = [await asset(), await asset(), await asset(), await asset()];
    await t.db.insertInto('project_brand').values({ project_id: project.id, logo_asset_id: onBrand, primary_color: '#1A56DB' }).execute();
    await link([momo], { status: 'disabled', logo_asset_id: onDisabled });
    const active = await link([momo], { logo_asset_id: onActive });

    const notFound = { error: { code: 'NOT_FOUND', message: 'No such resource.', retryable: false } };
    for (const id of [loose, onDisabled, '00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
      const res = await get(`/pay-api/v1/assets/${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(notFound);
    }
    for (const id of [onBrand, onActive]) {
      const res = await get(`/pay-api/v1/assets/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(res.headers.get('content-disposition')).toBe('inline; filename="logo"');
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    }
    const view = await viewOf(active.code);
    expect(view.brand.logo_url).toBe(`/pay-api/v1/assets/${onActive}`);
  });

  it('serves no type outside png, jpeg and webp, whatever the store hands back', async () => {
    const onBrand = await asset();
    await t.db.insertInto('project_brand').values({ project_id: project.id, logo_asset_id: onBrand, primary_color: '#1A56DB' }).execute();
    // The table refuses other types; the service is made to hand one back, as a defect upstream would.
    const spy = vi.spyOn(PublicLinkService.prototype, 'asset').mockResolvedValue({ bytes: Buffer.from('<svg onload="alert(1)"/>'), content_type: 'image/svg+xml' });
    try {
      const res = await get(`/pay-api/v1/assets/${onBrand}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No such resource.', retryable: false } });
    } finally { spy.mockRestore(); }
  });
});

describe('the public surface', () => {
  it('sits outside the console and behind no guard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PayApiController)).toBeUndefined();
    for (const name of Object.getOwnPropertyNames(PayApiController.prototype)) {
      const handler = Object.getOwnPropertyDescriptor(PayApiController.prototype, name)?.value as object;
      if (typeof handler === 'function') expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    }
    expect(Reflect.getMetadata('imports', ConsoleApiModule)).not.toContain(PayApiModule);
    expect(consoleRoutes().filter((r) => r.key.includes('pay-api'))).toEqual([]);
  });

  it('linkPrincipal carries the project and the collection scope, and no credential', () => {
    expect(linkPrincipal({ project_id: 'p', project_code: 'acme' })).toEqual({ projectId: 'p', projectCode: 'acme', scopes: ['collection'], credentialId: '', credentialKey: '', tokenId: '' });
  });
});
