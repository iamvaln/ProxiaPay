import 'reflect-metadata';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestContext, type TestContext } from '../test/context';
import { AppModule } from '../app.module';
import { configureBodyParsers } from '../http/body-parsers';
import { CryptoService } from '../crypto/crypto.service';
import { RateLimiter } from '../project-auth/rate-limiter';
import { LedgerService } from '../ledger/ledger.service';
import { StatusService } from '../providers/status.service';
import { TransactionService } from '../transactions/transaction.service';
import { PreviewService } from '../transactions/preview.service';
import { PlatformError } from '../common/errors';
import { SimulatorAdapter } from '../providers/adapters/simulator.adapter';
import { NotificationService } from '../notifications/notification.service';
import { deliveryTransport } from '../notifications/delivery-transport';

/** Paying through a link over HTTP, as the payment page does: no session, no credential, the real store. */
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
  SimulatorAdapter.settleAfterMs = 0;
});
afterAll(async () => { await app?.close(); await t.close(); });
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await t.reset();
  project = await t.project('acme-shop');
});

const routeId = async (country: string, method: string) =>
  (await t.db.selectFrom('route').select('id').where('country_code', '=', country).where('payment_method_code', '=', method).where('currency_code', '=', 'XAF').where('direction', '=', 'collection').executeTakeFirstOrThrow()).id;
let codes = 0;
async function link(routes: string[], opts: { amount_type?: 'fixed' | 'free'; amount?: number; minimum_amount?: number; single_use?: boolean } = {}) {
  const amountType = opts.amount_type ?? 'fixed';
  const row = await t.db.insertInto('payment_link').values({
    code: `Pay${String(++codes).padStart(7, '0')}`, project_id: project.id, title: 'Invoice 42', currency_code: 'XAF', amount_type: amountType,
    amount: amountType === 'fixed' ? (opts.amount ?? 5000) : null, minimum_amount: opts.minimum_amount ?? 0, single_use: opts.single_use ?? false,
    primary_color: '#1A56DB', created_by: project.adminId,
  }).returning(['id', 'code']).executeTakeFirstOrThrow();
  const keys = await t.db.insertInto('payment_link_route').values(routes.map((route_id) => ({ link_id: row.id, route_id }))).returning(['id', 'route_id']).execute();
  return { ...row, keys: Object.fromEntries(keys.map((k) => [k.route_id, k.id])) as Record<string, string> };
}
const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const answer = async (res: Response) => ({ status: res.status, body: await res.json() });
const preview = (code: string, body: unknown) => post(`/pay-api/v1/links/${code}/previews`, body);
const confirm = (token: string) => post(`/pay-api/v1/payments/${token}/confirm`);
/** A preview that must succeed; returns its token. */
async function token(code: string, body: { method?: string; msisdn: string; amount?: number }): Promise<string> {
  const res = await preview(code, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { payment_token: string }).payment_token;
}
/** The address limits are per minute; tests that make many calls start each round afresh. */
const forgetLimits = () => t.db.deleteFrom('rate_limit_window').execute();
const linkTransactions = (linkId: string) => t.db.selectFrom('transaction').select(['id', 'reference', 'state', 'project_reference', 'payment_link_id']).where('payment_link_id', '=', linkId).execute();
const IN_PROGRESS = { status: 409, body: { error: { code: 'CONFLICT', message: 'A payment is already in progress on this link', retryable: false } } };

describe('paying a link', () => {
  it('a payer pays a fixed link: one transaction with project_reference PL-<code>-…, payment_link_id set, normal ledger and webhook', async () => {
    await t.app.get(NotificationService).setEndpoint(t.db, project.id, 'https://hooks.example.com/hook', project.adminId);
    vi.spyOn(deliveryTransport, 'post').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);

    const res = await preview(l.code, { method: l.keys[momo], msisdn: '677 12 34 56' });
    expect(res.status).toBe(201);
    const text = await res.text();
    const body = JSON.parse(text) as { payment_token: string; review: { expires_at: string } };
    expect(body).toEqual({
      payment_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      review: { amount: 5000, fees_borne_by_payer: 125, total: 5125, currency: 'XAF', method: { country: 'CM', name: 'MTN Mobile Money' }, msisdn_formatted: '+237 677 12 34 56', expires_at: expect.any(String) },
    });
    // The total holds as long as the preview does.
    expect(new Date(body.review.expires_at).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    for (const word of ['prv_', 'route', project.id, momo, 'provider']) expect(text).not.toContain(word);
    // Stored hashed, valid a day, no transaction until the payer confirms.
    const row = await t.db.selectFrom('payment_link_payment').selectAll().executeTakeFirstOrThrow();
    expect(row.token_hash.equals(CryptoService.tokenHash(body.payment_token))).toBe(true);
    expect(row.transaction_id).toBeNull();
    expect(Math.abs(row.expires_at.getTime() - Date.now() - 24 * 3600_000)).toBeLessThan(60_000);
    expect(await t.db.selectFrom('transaction').select('id').execute()).toEqual([]);

    const done = await confirm(body.payment_token);
    expect(done.status).toBe(200);
    const { reference } = (await done.json()) as { reference: string };
    const txns = await linkTransactions(l.id);
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ reference, payment_link_id: l.id, state: 'processing' });
    expect(txns[0]!.project_reference).toMatch(new RegExp(`^PL-${l.code}-[0-9A-Z]{12}$`));
    expect((await t.db.selectFrom('payment_link_payment').select('transaction_id').executeTakeFirstOrThrow()).transaction_id).toBe(txns[0]!.id);

    // From here it is any collection: the status check settles it, the ledger credits the project, the project is told.
    await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).execute();
    await t.app.get(StatusService).sweep();
    expect((await linkTransactions(l.id))[0]!.state).toBe('succeeded');
    expect(await t.app.get(LedgerService).projectBalances(t.db, project.id)).toEqual([{ currency: 'XAF', available: 5000, reserved: 0 }]);
    expect((await t.db.selectFrom('notification_delivery').select('event_type').execute()).map((d) => d.event_type)).toEqual(['transaction.succeeded']);

    // Confirming again answers the same payment, and creates nothing.
    expect(await answer(await confirm(body.payment_token))).toEqual({ status: 200, body: { reference } });
    expect(await linkTransactions(l.id)).toHaveLength(1);
  });

  it('free amount: refuses below floor (link minimum 500 over a 100 route minimum), above max, 0, -1, 10.5 for XAF', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { amount_type: 'free', minimum_amount: 500 });
    const attempt = async (amount: unknown) => { await forgetLimits(); return answer(await preview(l.code, { method: l.keys[momo], msisdn: '677123456', amount })); };
    expect(await attempt(499)).toEqual({ status: 400, body: { error: { code: 'FIELD_INVALID', field: 'amount', message: 'The amount must be at least 500 XAF.', retryable: false } } });
    expect(await attempt(1_000_001)).toEqual({ status: 400, body: { error: { code: 'FIELD_INVALID', field: 'amount', message: 'The amount must be at most 1000000 XAF.', retryable: false } } });
    for (const bad of [0, -1, 10.5, '2000', undefined]) expect(await attempt(bad)).toMatchObject({ status: 400, body: { error: { code: 'FIELD_INVALID', field: 'amount' } } });
    // No preview was created for any of them.
    expect(await t.db.selectFrom('preview').select('id').execute()).toEqual([]);
    expect(await t.db.selectFrom('payment_link_payment').select('id').execute()).toEqual([]);
    // The floor itself is fine.
    expect((await attempt(500)).status).toBe(201);
  });

  it('an amount no provider takes is refused without the provider\'s figure or wording', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { amount_type: 'free' });
    const rv = await t.db.selectFrom('route_version').select('id').where('route_id', '=', momo).where('valid_to', 'is', null).executeTakeFirstOrThrow();
    await sql`alter table route_binding disable trigger route_binding_immutable`.execute(t.db);
    try { await t.db.updateTable('route_binding').set({ minimum_amount: 3000, maximum_amount: 8000 }).where('route_version_id', '=', rv.id).execute(); }
    finally { await sql`alter table route_binding enable trigger route_binding_immutable`.execute(t.db); }
    const neutral = { status: 400, body: { error: { code: 'FIELD_INVALID', field: 'amount', message: 'This amount cannot be paid with this method.', retryable: false } } };
    for (const amount of [1000, 9000]) expect(await answer(await preview(l.code, { method: l.keys[momo], msisdn: '677123456', amount }))).toEqual(neutral);
    expect(await t.db.selectFrom('preview').select('id').execute()).toEqual([]);
  });

  it('a method key of another link answers like an unavailable method', async () => {
    const momo = await routeId('CM', 'MOMO');
    const mine = await link([momo]);
    const theirs = await link([momo]);
    const unavailable = { status: 400, body: { error: { code: 'FIELD_INVALID', field: 'method', message: 'This payment method is not available on this link.', retryable: false } } };
    for (const method of [theirs.keys[momo], momo, 'not-a-key', 42, undefined]) {
      await forgetLimits();
      expect(await answer(await preview(mine.code, { method, msisdn: '677123456' }))).toEqual(unavailable);
    }
    expect(await t.db.selectFrom('preview').select('id').execute()).toEqual([]);
  });

  it('a route deactivated between review and confirmation creates nothing', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const tok = await token(l.code, { method: l.keys[momo], msisdn: '677123456' });
    const ent = await t.db.selectFrom('entitlement').select('id').where('project_id', '=', project.id).where('route_id', '=', momo).executeTakeFirstOrThrow();
    await t.db.updateTable('entitlement_version').set({ active: false }).where('entitlement_id', '=', ent.id).where('valid_to', 'is', null).execute();
    expect(await answer(await confirm(tok))).toEqual({ status: 400, body: { error: { code: 'FIELD_INVALID', field: 'method', message: 'This payment method is not available on this link.', retryable: false } } });
    expect(await t.db.selectFrom('transaction').select('id').execute()).toEqual([]);
  });

  it('a link disabled after the review is unavailable at confirmation', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const tok = await token(l.code, { method: l.keys[momo], msisdn: '677123456' });
    await t.db.updateTable('payment_link').set({ status: 'disabled' }).where('id', '=', l.id).execute();
    expect(await answer(await confirm(tok))).toEqual({ status: 404, body: { error: { code: 'LINK_UNAVAILABLE', message: 'This link is no longer available', retryable: false } } });
    expect(await t.db.selectFrom('transaction').select('id').execute()).toEqual([]);
  });

  it('an unknown or malformed token is a missing payment', async () => {
    for (const tok of ['A'.repeat(43), 'short', 'x'.repeat(200)]) {
      await forgetLimits();
      expect(await answer(await confirm(tok))).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'No such payment.', retryable: false } } });
    }
  });

  it('confirm after the preview expired answers "This total has expired; start again."', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const tok = await token(l.code, { method: l.keys[momo], msisdn: '677123456' });
    await t.db.updateTable('preview').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    const expired = { status: 409, body: { error: { code: 'PREVIEW_EXPIRED', message: 'This total has expired; start again.', retryable: false } } };
    expect(await answer(await confirm(tok))).toEqual(expired);
    // Past the token's own day, the same.
    await t.db.updateTable('payment_link_payment').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    expect(await answer(await confirm(tok))).toEqual(expired);
    expect(await t.db.selectFrom('transaction').select('id').execute()).toEqual([]);
  });

  it('confirming again after the token\'s day answers the payment already made', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const tok = await token(l.code, { method: l.keys[momo], msisdn: '677123456' });
    const first = await answer(await confirm(tok));
    expect(first.status).toBe(200);
    await t.db.updateTable('payment_link_payment').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    await t.db.updateTable('preview').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    expect(await answer(await confirm(tok))).toEqual(first);
    expect(await linkTransactions(l.id)).toHaveLength(1);
  });

  it('a refusal the payer has no words for answers a plain message, never the developer\'s', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const generic = { error: { code: 'REFERENCE_CONFLICT', message: 'We could not start this payment. Please try again.', retryable: false } };
    vi.spyOn(app.get(PreviewService), 'create').mockRejectedValueOnce(new PlatformError('REFERENCE_CONFLICT', 'The project reference is already used by prv_01J8.', { field: 'reference' }));
    expect(await answer(await preview(l.code, { method: l.keys[momo], msisdn: '677123456' }))).toEqual({ status: 409, body: generic });

    const tok = await token(l.code, { method: l.keys[momo], msisdn: '677123456' });
    vi.spyOn(app.get(TransactionService), 'confirmCollectionIn').mockRejectedValueOnce(new PlatformError('PREVIEW_DIRECTION_MISMATCH', 'The preview was raised as a disbursement.'));
    expect(await answer(await confirm(tok))).toEqual({ status: 409, body: { error: { ...generic.error, code: 'PREVIEW_DIRECTION_MISMATCH' } } });
    expect(await t.db.selectFrom('transaction').select('id').execute()).toEqual([]);
  });

  it('entitlement limits still apply', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const ent = await t.db.selectFrom('entitlement').select('id').where('project_id', '=', project.id).where('route_id', '=', momo).executeTakeFirstOrThrow();
    await t.db.updateTable('entitlement_version').set({ count_24h: 1 }).where('entitlement_id', '=', ent.id).where('valid_to', 'is', null).execute();
    const first = await token(l.code, { method: l.keys[momo], msisdn: '677111111' });
    const second = await token(l.code, { method: l.keys[momo], msisdn: '677222222' });
    expect((await confirm(first)).status).toBe(200);
    const refused = await answer(await confirm(second));
    expect(refused).toEqual({ status: 422, body: { error: { code: 'VELOCITY_COUNT_EXCEEDED', message: 'This link cannot take more payments right now. Try again later.', retryable: true } } });
    expect(await linkTransactions(l.id)).toHaveLength(1);
    // And an entitlement maximum below a fixed amount takes the method off the link before any preview.
    await t.db.updateTable('entitlement_version').set({ maximum_amount: 3000 }).where('entitlement_id', '=', ent.id).where('valid_to', 'is', null).execute();
    expect((await answer(await preview(l.code, { method: l.keys[momo], msisdn: '677333333' }))).body).toMatchObject({ error: { code: 'FIELD_INVALID', field: 'method' } });
  });
});

describe('a single-use link', () => {
  it('two concurrent confirms on a single-use link: exactly one transaction, the other refused with "A payment is already in progress on this link"', async () => {
    const momo = await routeId('CM', 'MOMO');
    // Several rounds, each a fresh link and two payers confirming at the same instant.
    for (let round = 0; round < 5; round++) {
      await forgetLimits();
      const l = await link([momo], { single_use: true });
      const a = await token(l.code, { method: l.keys[momo], msisdn: `6771000${round}1` });
      const b = await token(l.code, { method: l.keys[momo], msisdn: `6772000${round}2` });
      const answers = await Promise.all([confirm(a).then(answer), confirm(b).then(answer)]);
      expect(answers.map((x) => x.status).sort()).toEqual([200, 409]);
      expect(answers.find((x) => x.status === 409)).toEqual(IN_PROGRESS);
      const txns = await linkTransactions(l.id);
      expect(txns).toHaveLength(1);
      expect(answers.find((x) => x.status === 200)!.body).toEqual({ reference: txns[0]!.reference });
      // Only the winner's payment row carries a transaction.
      expect((await t.db.selectFrom('payment_link_payment').select('transaction_id').where('link_id', '=', l.id).where('transaction_id', 'is not', null).execute())).toHaveLength(1);
    }
  });

  it('an unconfirmed preview does not hold a single-use link', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { single_use: true });
    const idle = await token(l.code, { method: l.keys[momo], msisdn: '677100011' });
    const payer = await token(l.code, { method: l.keys[momo], msisdn: '677200022' });
    expect((await confirm(payer)).status).toBe(200);
    // The payer who only reviewed is now behind the payment in progress.
    expect(await answer(await confirm(idle))).toEqual(IN_PROGRESS);
    expect(await linkTransactions(l.id)).toHaveLength(1);
  });

  it('a payment being checked holds the link; a failed one releases it; a success closes it', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { single_use: true });
    // The simulator leaves a number ending 04 undetermined, and declines one ending 01.
    const checking = await token(l.code, { method: l.keys[momo], msisdn: '677100004' });
    const next = await token(l.code, { method: l.keys[momo], msisdn: '677200001' });
    expect((await confirm(checking)).status).toBe(200);
    expect((await linkTransactions(l.id))[0]!.state).toBe('undetermined');
    expect(await answer(await confirm(next))).toEqual({ status: 409, body: { error: { code: 'CONFLICT', message: 'A payment on this link is being checked', retryable: false } } });

    // Once that payment is known to have failed, the link takes the next payer.
    const transactions = t.app.get(TransactionService);
    const [held] = await linkTransactions(l.id);
    await t.db.transaction().execute(async (tx) => transactions.finalizeFailure(tx, await transactions.lock(tx, held!.id), 'PAYER_DECLINED', { source: 'reconciliation' }));
    await forgetLimits();
    expect((await confirm(next)).status).toBe(200);
    await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).execute();
    await t.app.get(StatusService).sweep();
    expect((await linkTransactions(l.id)).map((x) => x.state).sort()).toEqual(['failed', 'failed']);

    // A success, even before anything marks the link completed, never lets it collect again.
    const last = await token(l.code, { method: l.keys[momo], msisdn: '677300033' });
    const after = await token(l.code, { method: l.keys[momo], msisdn: '677400044' });
    await forgetLimits();
    expect((await confirm(last)).status).toBe(200);
    await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).execute();
    await t.app.get(StatusService).sweep();
    expect(await answer(await confirm(after))).toEqual({ status: 404, body: { error: { code: 'LINK_UNAVAILABLE', message: 'This link is no longer available', retryable: false } } });
    expect((await linkTransactions(l.id)).filter((x) => x.state === 'succeeded')).toHaveLength(1);
  });

  it('a reusable link takes payments side by side', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const a = await token(l.code, { method: l.keys[momo], msisdn: '677100011' });
    const b = await token(l.code, { method: l.keys[momo], msisdn: '677200022' });
    const answers = await Promise.all([confirm(a), confirm(b)]);
    expect(answers.map((x) => x.status)).toEqual([200, 200]);
    expect(await linkTransactions(l.id)).toHaveLength(2);
  });
});

describe('rate limits', () => {
  it('rate limit per number: the 4th request within 600 s answers 429', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const tok = await token(l.code, { method: l.keys[momo], msisdn: '677123456' });
    // Three earlier requests to the number spend its budget (a retried confirm does not: see below).
    const index = t.app.get(CryptoService).blindIndex('+237677123456').toString('hex');
    for (let i = 0; i < 3; i++) await t.app.get(RateLimiter).hit(`paylink:confirm-number:${index}`, 3, 600);
    const res = await confirm(tok);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many payment requests to this number. Wait a few minutes and try again.', retryable: true } });
    // The limit is kept against the number's keyed index: the window table never holds the number.
    const keys = (await t.db.selectFrom('rate_limit_window').select('key').execute()).map((k) => k.key);
    expect(keys.some((k) => k.startsWith('paylink:confirm-number:'))).toBe(true);
    for (const k of keys) expect(k).not.toMatch(/677123456|123456/);
    expect(keys).toContain(`paylink:confirm-number:${t.app.get(CryptoService).blindIndex('+237677123456').toString('hex')}`);
  });

  it('a retried confirm answers the same payment without spending the number\'s or the link\'s budget', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const tok = await token(l.code, { method: l.keys[momo], msisdn: '677123456' });
    const first = await confirm(tok);
    expect(first.status).toBe(200);
    const { reference } = (await first.json()) as { reference: string };
    const keys = async () => (await t.db.selectFrom('rate_limit_window').select(['key', 'count']).where('key', 'like', 'paylink:confirm-%').execute()).filter((k) => !k.key.startsWith('paylink:confirm:'));
    const spent = await keys();
    expect(spent.length).toBe(2);
    for (let i = 0; i < 4; i++) {
      const again = await confirm(tok);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ reference });
    }
    expect(await keys()).toEqual(spent);
  });

  it('previews: 10 per 600 s per number, keyed on the normalised number whatever its spelling', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const limiter = t.app.get(RateLimiter);
    const index = t.app.get(CryptoService).blindIndex('+237677123456').toString('hex');
    for (let i = 0; i < 10; i++) await limiter.hit(`paylink:preview-number:${index}`, 10, 600);
    const res = await preview(l.code, { method: l.keys[momo], msisdn: '+237 677-12-34-56' });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'RATE_LIMITED', message: 'Too many payment requests to this number. Wait a few minutes and try again.' } });
    // Another number is not held back.
    expect((await preview(l.code, { method: l.keys[momo], msisdn: '677654321' })).status).toBe(201);
  });

  it('5 a minute per address on previews and on confirmations', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { amount_type: 'free' });
    for (let i = 0; i < 5; i++) expect((await preview(l.code, { method: l.keys[momo], msisdn: `6771000${i}9`, amount: 1000 + i })).status).toBe(201);
    const sixth = await preview(l.code, { method: l.keys[momo], msisdn: '677100069', amount: 2000 });
    expect(await answer(sixth)).toEqual({ status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Too many requests from this connection. Wait a minute and try again.', retryable: true } } });
    for (let i = 0; i < 5; i++) await confirm('A'.repeat(43));
    expect((await confirm('A'.repeat(43))).status).toBe(429);
  });

  it('30 confirmations a minute per link', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const tok = await token(l.code, { method: l.keys[momo], msisdn: '677123456' });
    const limiter = t.app.get(RateLimiter);
    for (let i = 0; i < 30; i++) await limiter.hit(`paylink:confirm-link:${l.id}`, 30, 60);
    expect(await answer(await confirm(tok))).toEqual({ status: 429, body: { error: { code: 'RATE_LIMITED', message: 'This link is taking too many payments at once. Wait a minute and try again.', retryable: true } } });
    expect(await t.db.selectFrom('transaction').select('id').execute()).toEqual([]);
  });
});
