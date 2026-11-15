import 'reflect-metadata';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestContext, type TestContext } from '../test/context';
import { AppModule } from '../app.module';
import { configureBodyParsers } from '../http/body-parsers';
import { RateLimiter } from '../project-auth/rate-limiter';
import { CryptoService } from '../crypto/crypto.service';
import { StatusService } from '../providers/status.service';
import { SubmissionService } from '../providers/submission.service';
import { TransactionService } from '../transactions/transaction.service';
import { SimulatorAdapter } from '../providers/adapters/simulator.adapter';
import { NotificationService } from '../notifications/notification.service';
import { deliveryTransport } from '../notifications/delivery-transport';

/** Following a link payment from the page, and what its outcome does to a single-use link. */
let t: TestContext;
let app: INestApplication;
let base: string;
let project: { id: string; key: string; secret: string; adminId: string };

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
async function link(routes: string[], opts: { single_use?: boolean } = {}) {
  const row = await t.db.insertInto('payment_link').values({
    code: `Fol${String(++codes).padStart(7, '0')}`, project_id: project.id, title: 'Invoice 42', currency_code: 'XAF', amount_type: 'fixed',
    amount: 5000, minimum_amount: 0, single_use: opts.single_use ?? false, primary_color: '#1A56DB', created_by: project.adminId,
  }).returning(['id', 'code']).executeTakeFirstOrThrow();
  const keys = await t.db.insertInto('payment_link_route').values(routes.map((route_id) => ({ link_id: row.id, route_id }))).returning(['id', 'route_id']).execute();
  return { ...row, keys: Object.fromEntries(keys.map((k) => [k.route_id, k.id])) as Record<string, string> };
}
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
/** The JSON bodies these tests read: the followed payment, and the transaction and list of the project API. */
interface Body { state: string; reference: string; instructions: string | null; outcome: unknown; payment_link: unknown; data: { reference: string; payment_link: unknown }[] }
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
const follow = (token: string, lang?: string) => fetch(`${base}/pay-api/v1/payments/${token}${lang ? `?lang=${lang}` : ''}`).then(answer);
const confirm = (token: string) => post(`/pay-api/v1/payments/${token}/confirm`);
/** A preview, then the payer's confirmation; returns the token the page follows the payment by. */
async function pay(code: string, method: string, msisdn: string): Promise<string> {
  const res = await post(`/pay-api/v1/links/${code}/previews`, { method, msisdn });
  expect(res.status).toBe(201);
  const { payment_token } = (await res.json()) as { payment_token: string };
  await forgetLimits();
  expect((await confirm(payment_token)).status).toBe(200);
  return payment_token;
}
const forgetLimits = () => t.db.deleteFrom('rate_limit_window').execute();
/** Runs the status checks now, as the sweep does once they are due: the simulator settles at once. */
async function settle() {
  await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).execute();
  await t.app.get(StatusService).sweep();
}
const linkStatus = async (id: string) => (await t.db.selectFrom('payment_link').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
const txnOf = async (token: string) => t.db.selectFrom('payment_link_payment as pp').innerJoin('transaction as t', 't.id', 'pp.transaction_id')
  .select(['t.id', 't.reference', 't.state', 't.charged_amount']).where('pp.token_hash', '=', CryptoService.tokenHash(token)).executeTakeFirstOrThrow();
/** A reconciliation correction, as an administrator's accepted discrepancy applies it. */
async function correct(transactionId: string, target: 'succeeded' | 'failed') {
  const pa = (await t.db.selectFrom('transaction_attempt').select('provider_account_id').where('transaction_id', '=', transactionId).executeTakeFirstOrThrow()).provider_account_id;
  const run = await t.db.insertInto('reconciliation_run').values({ provider_account_id: pa, mode: 'manual', status: 'completed', period_start: new Date(Date.now() - 86_400_000), period_end: new Date() }).returning('id').executeTakeFirstOrThrow();
  const d = await t.db.insertInto('discrepancy').values({
    run_id: run.id, provider_account_id: pa, type: 'state_divergence', subject_type: 'transaction', subject_reference: transactionId, transaction_id: transactionId,
    fingerprint: `test:${transactionId}:${target}`, expected: JSON.stringify({}), observed: JSON.stringify({ state: target }),
  }).returning('id').executeTakeFirstOrThrow();
  const transactions = t.app.get(TransactionService);
  await t.db.transaction().execute((tx) => transactions.applyCorrection(tx, transactionId, target, { discrepancyId: d.id, actorId: project.adminId, failureReason: 'PAYER_DECLINED' }));
}
const twiceAlerts = () => t.db.selectFrom('alert').select(['category', 'severity', 'title', 'fingerprint', 'action_reference', 'project_id']).where('fingerprint', 'like', 'link_collected_twice:%').execute();

describe('following a payment', () => {
  it('follows a payment from created to succeeded; the link completes', async () => {
    const momo = await routeId('CM', 'MOMO');
    // The route table refuses updates; the console's instructions editor is a later task, so the test sets them past the trigger.
    await sql`alter table route disable trigger route_immutable`.execute(t.db);
    try { await t.db.updateTable('route').set({ payer_instructions: JSON.stringify({ en: 'Approve the request with your MoMo PIN.', fr: 'Validez la demande avec votre code MoMo.' }) }).where('id', '=', momo).execute(); }
    finally { await sql`alter table route enable trigger route_immutable`.execute(t.db); }
    const l = await link([momo], { single_use: true });
    // The submission is interrupted: the payment waits, created, for the queued retry.
    vi.spyOn(app.get(SubmissionService), 'submit').mockRejectedValueOnce(new Error('connect ECONNRESET'));
    const token = await pay(l.code, l.keys[momo]!, '677123456');
    const txn = await txnOf(token);

    const shown = await follow(token);
    expect(shown).toEqual({
      status: 200,
      body: {
        state: 'created', reference: txn.reference, amount: 5000, charged_amount: 5125, currency: 'XAF', method: { country: 'CM', name: 'MTN Mobile Money' },
        instructions: 'Approve the request with your MoMo PIN.', outcome: null,
      },
    });
    expect((await follow(token, 'fr')).body.instructions).toBe('Validez la demande avec votre code MoMo.');
    expect((await follow(token, 'de')).body.instructions).toBe('Approve the request with your MoMo PIN.');
    // Nothing the payer should not see: no internal id, no provider.
    const text = JSON.stringify(shown.body);
    for (const word of [txn.id, momo, project.id, 'simulator', 'provider']) expect(text).not.toContain(word);
    // A payment in progress holds the link, still active.
    expect(await linkStatus(l.id)).toBe('active');

    await t.app.get(SubmissionService).submit(txn.id);
    expect((await follow(token)).body).toMatchObject({ state: 'processing', outcome: null });

    await settle();
    const after = await follow(token);
    expect(after.body).toMatchObject({ state: 'succeeded', reference: txn.reference, charged_amount: (await txnOf(token)).charged_amount, outcome: { failure_reason_text: null } });
    expect(await linkStatus(l.id)).toBe('completed');
    expect(await answer(await fetch(`${base}/pay-api/v1/links/${l.code}`))).toEqual({ status: 404, body: { error: { code: 'LINK_UNAVAILABLE', message: 'This link is no longer available', retryable: false } } });
  });

  it('a route without instructions answers null, so the page shows its generic text', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const token = await pay(l.code, l.keys[momo]!, '677123456');
    expect((await follow(token, 'fr')).body.instructions).toBeNull();
  });

  it('a failed payment reopens a single-use link', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { single_use: true });
    // The simulator declines a number ending 01.
    const token = await pay(l.code, l.keys[momo]!, '677100001');
    await settle();
    expect(await follow(token)).toMatchObject({ status: 200, body: { state: 'failed', outcome: { failure_reason_text: 'The payment was declined on the phone.' } } });
    expect((await follow(token, 'fr')).body.outcome).toEqual({ failure_reason_text: 'Le paiement a été refusé sur le téléphone.' });
    // Never the provider's code or the platform's reason code.
    expect(JSON.stringify((await follow(token)).body)).not.toMatch(/PAYER_DECLINED|REJECTED/);
    expect(await linkStatus(l.id)).toBe('active');
    // The link takes the next payer.
    const next = await pay(l.code, l.keys[momo]!, '677200022');
    expect((await txnOf(next)).state).toBe('processing');
  });

  it('an expired payment reopens a single-use link too', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { single_use: true });
    const token = await pay(l.code, l.keys[momo]!, '677100002');
    const transactions = t.app.get(TransactionService);
    const { id } = await txnOf(token);
    await t.db.transaction().execute(async (tx) => transactions.finalizeFailure(tx, await transactions.lock(tx, id), 'ACTION_WINDOW_EXPIRED', { source: 'system' }));
    expect((await follow(token)).body).toMatchObject({ state: 'expired', outcome: { failure_reason_text: 'The payment request expired before it was approved.' } });
    expect(await linkStatus(l.id)).toBe('active');
    await pay(l.code, l.keys[momo]!, '677200022');
  });

  it('an undetermined payment holds the link with "A payment on this link is being checked"', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { single_use: true });
    // The simulator times out on a number ending 04: the outcome is undetermined.
    const token = await pay(l.code, l.keys[momo]!, '677100004');
    expect((await follow(token)).body).toMatchObject({ state: 'undetermined', outcome: null });
    expect(await linkStatus(l.id)).toBe('active');
    const res = await post(`/pay-api/v1/links/${l.code}/previews`, { method: l.keys[momo], msisdn: '677200022' });
    const { payment_token } = (await res.json()) as { payment_token: string };
    expect(await answer(await confirm(payment_token))).toEqual({ status: 409, body: { error: { code: 'CONFLICT', message: 'A payment on this link is being checked', retryable: false } } });
  });

  it('the state follows the provider callback: a succeeded callback makes GET return succeeded', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const token = await pay(l.code, l.keys[momo]!, '677123456');
    expect((await follow(token)).body.state).toBe('processing');
    const { id } = await txnOf(token);
    const attempt = await t.db.selectFrom('transaction_attempt').select(['provider_account_id', 'provider_reference']).where('transaction_id', '=', id).executeTakeFirstOrThrow();
    // The simulator calls back; the platform verifies by a status check, which the worker runs.
    const callback = await post(`/providers/${attempt.provider_account_id}/notifications`, { event: 'payment.succeeded', paymentReference: attempt.provider_reference });
    expect(callback.status).toBe(200);
    await t.drain();
    expect((await follow(token)).body).toMatchObject({ state: 'succeeded', outcome: { failure_reason_text: null } });
  });

  it('an expired token is 404', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const token = await pay(l.code, l.keys[momo]!, '677123456');
    const gone = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'This payment is no longer available', retryable: false } } };
    await t.db.updateTable('payment_link_payment').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    expect(await follow(token)).toEqual(gone);
    // An unknown or malformed token answers the same.
    for (const other of ['A'.repeat(43), 'short', 'x'.repeat(200)]) expect(await follow(other)).toEqual(gone);
  });

  it('a token whose total was never confirmed has no payment to follow', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const res = await post(`/pay-api/v1/links/${l.code}/previews`, { method: l.keys[momo], msisdn: '677123456' });
    const { payment_token } = (await res.json()) as { payment_token: string };
    expect((await follow(payment_token)).status).toBe(404);
  });

  it('guessed tokens write no per-token rate_limit_window rows; the address ceiling alone counts them', async () => {
    await forgetLimits();
    for (const guess of ['A'.repeat(43), 'B'.repeat(43), 'C'.repeat(43)]) expect((await follow(guess)).status).toBe(404);
    const keys = (await t.db.selectFrom('rate_limit_window').select('key').execute()).map((k) => k.key);
    expect(keys.filter((k) => k.startsWith('paylink:payment:'))).toEqual([]);
    expect(keys).toContain('paylink:payment-read:127.0.0.1');
  });

  it('60 reads a minute per token, kept against the token\'s hash', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const token = await pay(l.code, l.keys[momo]!, '677123456');
    const key = `paylink:payment:${CryptoService.tokenHash(token).toString('hex')}`;
    const limiter = t.app.get(RateLimiter);
    for (let i = 0; i < 60; i++) await limiter.hit(key, 60, 60);
    const res = await fetch(`${base}/pay-api/v1/payments/${token}`);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    for (const k of (await t.db.selectFrom('rate_limit_window').select('key').execute()).map((r) => r.key)) expect(k).not.toContain(token);
    // Another payment from the same address is not held back by that token, only by the address's own ceiling.
    const other = await pay(l.code, l.keys[momo]!, '677200022');
    expect((await follow(other)).status).toBe(200);
    for (let i = 0; i < 300; i++) await limiter.hit('paylink:payment-read:127.0.0.1', 300, 60);
    expect(await follow(other)).toEqual({ status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Too many requests from this connection. Wait a minute and try again.', retryable: true } } });
  });
});

describe('a single-use link never collects twice', () => {
  it('a failed-then-corrected success after another success raises the alert', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { single_use: true });
    const declined = await pay(l.code, l.keys[momo]!, '677100001');
    await settle();
    const paid = await pay(l.code, l.keys[momo]!, '677200022');
    await settle();
    expect(await linkStatus(l.id)).toBe('completed');
    expect(await twiceAlerts()).toEqual([]);

    // Reconciliation finds that the declined payment went through after all.
    await correct((await txnOf(declined)).id, 'succeeded');
    expect((await txnOf(declined)).state).toBe('succeeded');
    expect((await txnOf(paid)).state).toBe('succeeded');
    expect(await twiceAlerts()).toEqual([{
      category: 'treasury', severity: 'warning', title: 'Single-use link collected twice', fingerprint: `link_collected_twice:${l.id}`,
      action_reference: `/projects/${project.id}?tab=links`, project_id: project.id,
    }]);
    expect(await linkStatus(l.id)).toBe('completed');
  });

  it('a corrected failure of the completing payment reopens the link', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { single_use: true });
    const paid = await pay(l.code, l.keys[momo]!, '677200022');
    await settle();
    expect(await linkStatus(l.id)).toBe('completed');

    await correct((await txnOf(paid)).id, 'failed');
    expect((await txnOf(paid)).state).toBe('failed');
    expect(await linkStatus(l.id)).toBe('active');
    expect((await answer(await fetch(`${base}/pay-api/v1/links/${l.code}`))).status).toBe(200);
  });

  it('a corrected failure leaves a link completed while another success stands', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { single_use: true });
    const declined = await pay(l.code, l.keys[momo]!, '677100001');
    await settle();
    const paid = await pay(l.code, l.keys[momo]!, '677200022');
    await settle();
    await correct((await txnOf(declined)).id, 'succeeded');
    await correct((await txnOf(paid)).id, 'failed');
    expect(await linkStatus(l.id)).toBe('completed');
  });

  it('a disabled link stays disabled whatever its payments do', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo], { single_use: true });
    const paid = await pay(l.code, l.keys[momo]!, '677200022');
    await t.db.updateTable('payment_link').set({ status: 'disabled' }).where('id', '=', l.id).execute();
    await settle();
    expect(await linkStatus(l.id)).toBe('disabled');
    await correct((await txnOf(paid)).id, 'failed');
    expect(await linkStatus(l.id)).toBe('disabled');
  });

  it('a reusable link is never completed', async () => {
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    await pay(l.code, l.keys[momo]!, '677200022');
    await pay(l.code, l.keys[momo]!, '677300033');
    await settle();
    expect(await linkStatus(l.id)).toBe('active');
    expect(await twiceAlerts()).toEqual([]);
  });
});

describe('the link on the transaction resource', () => {
  it('webhook and GET /v1/transactions carry payment_link.code', async () => {
    await t.app.get(NotificationService).setEndpoint(t.db, project.id, 'https://hooks.example.com/hook', project.adminId);
    vi.spyOn(deliveryTransport, 'post').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const momo = await routeId('CM', 'MOMO');
    const l = await link([momo]);
    const token = await pay(l.code, l.keys[momo]!, '677123456');
    await settle();
    const { reference } = await txnOf(token);

    const deliveries = await t.db.selectFrom('notification_delivery').select(['event_type', 'payload']).execute();
    expect(deliveries.map((d) => d.event_type)).toEqual(['transaction.succeeded']);
    expect((deliveries[0]!.payload as { data: { transaction: { payment_link: unknown } } }).data.transaction.payment_link).toEqual({ code: l.code });

    const auth = (await (await post('/v1/auth/tokens', { client_key: project.key, client_secret: project.secret })).json()) as { access_token: string };
    const headers = { authorization: `Bearer ${auth.access_token}` };
    // A collection made through the project API carries no link.
    const pv = await answer(await post('/v1/previews', { direction: 'collection', amount: 1000, currency: 'XAF', country: 'CM', payment_method: 'MOMO', counterparty: { msisdn: '677999988' }, reference: 'order-1' }, headers));
    expect(pv.status).toBe(201);
    const direct = await answer(await post('/v1/collections', { preview_reference: pv.body.reference }, headers));
    expect(direct.body.payment_link).toBeNull();

    const one = await answer(await fetch(`${base}/v1/transactions/${reference}`, { headers }));
    expect(one).toMatchObject({ status: 200, body: { reference, payment_link: { code: l.code } } });
    const list = await answer(await fetch(`${base}/v1/transactions`, { headers }));
    const byRef = Object.fromEntries(list.body.data.map((x) => [x.reference, x.payment_link]));
    expect(byRef).toEqual({ [reference]: { code: l.code }, [direct.body.reference]: null });
  });
});
