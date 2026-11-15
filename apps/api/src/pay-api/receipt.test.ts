import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestContext, type TestContext } from '../test/context';
import { AppModule } from '../app.module';
import { configureBodyParsers } from '../http/body-parsers';
import { StatusService } from '../providers/status.service';
import { SimulatorAdapter } from '../providers/adapters/simulator.adapter';

import { Mailer, fromHeader } from '../alerts/mailer';
import { maskEmail } from '../payment-links/receipt';

/** The receipt by email: branded, kept as a masked address only, three at most, and only once the payment succeeded. */
let t: TestContext;
let app: INestApplication;
let base: string;
let project: { id: string; key: string; secret: string; adminId: string };
const EMAIL = 'aicha.nkoulou@gmail.com';

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
  await t.db.updateTable('project').set({ name: 'Acme "Shop" <Ltd>' }).where('id', '=', project.id).execute();
  app.get(Mailer).sent.length = 0;
});

const routeId = async (country: string, method: string) =>
  (await t.db.selectFrom('route').select('id').where('country_code', '=', country).where('payment_method_code', '=', method).where('currency_code', '=', 'XAF').where('direction', '=', 'collection').executeTakeFirstOrThrow()).id;
async function link(route: string) {
  const row = await t.db.insertInto('payment_link').values({
    code: 'Rcpt000001', project_id: project.id, title: 'Invoice 42', currency_code: 'XAF', amount_type: 'fixed',
    amount: 5000, minimum_amount: 0, single_use: false, primary_color: '#1A56DB', created_by: project.adminId,
  }).returning(['id', 'code']).executeTakeFirstOrThrow();
  const key = await t.db.insertInto('payment_link_route').values({ link_id: row.id, route_id: route }).returning('id').executeTakeFirstOrThrow();
  return { ...row, key: key.id };
}
const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const forgetLimits = () => t.db.deleteFrom('rate_limit_window').execute();
async function pay(msisdn = '677123456'): Promise<string> {
  const momo = await routeId('CM', 'MOMO');
  const l = await link(momo);
  const res = await post(`/pay-api/v1/links/${l.code}/previews`, { method: l.key, msisdn });
  const made = (await res.json()) as { payment_token: string };
  if (res.status !== 201) throw new Error(JSON.stringify(made));
  const { payment_token } = made;
  await forgetLimits();
  const confirmed = await post(`/pay-api/v1/payments/${payment_token}/confirm`);
  expect(await confirmed.json()).toMatchObject({ reference: expect.any(String) });
  return payment_token;
}
async function settle() {
  await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).execute();
  await t.app.get(StatusService).sweep();
}
const receipt = async (token: string, body: unknown) => {
  const res = await post(`/pay-api/v1/payments/${token}/receipt`, body);
  return { status: res.status, body: (await res.json()) as { status?: string; error?: { code: string } } };
};
// The HTTP app is its own Nest application: its mailer is the one that sent.
const mailer = () => app.get(Mailer);

describe('receipt by email', () => {
  it('sends a branded receipt with the sender "<Project> via ProxiaPay"', async () => {
    const token = await pay();
    await settle();
    expect(await receipt(token, { email: EMAIL, language: 'en' })).toEqual({ status: 200, body: { status: 'sent' } });
    const mail = mailer().sent.find((m) => m.to === EMAIL)!;
    expect(mail.fromName).toBe('Acme "Shop" <Ltd> via ProxiaPay');
    const row = await t.db.selectFrom('transaction').select(['reference', 'msisdn_masked', 'charged_amount']).executeTakeFirstOrThrow();
    const fees = row.charged_amount - 5000;
    expect(fees).toBeGreaterThan(0);
    for (const part of ['Acme "Shop" <Ltd>', 'Invoice 42', 'Reference: ', 'Date: ', 'Amount: 5000 XAF', `Fees borne by you: ${fees} XAF`, `Total paid: ${row.charged_amount} XAF`, 'Method: MTN Mobile Money', 'Number: ', 'Powered by ProxiaPay']) expect(mail.text).toContain(part);
    expect(mail.text).toContain(row.reference);
    expect(mail.text).toContain(row.msisdn_masked);
    expect(mail.text).not.toContain('677123456');
  });

  it('writes the mail in French when asked', async () => {
    const token = await pay();
    await settle();
    await receipt(token, { email: EMAIL, language: 'fr' });
    const mail = mailer().sent.find((m) => m.to === EMAIL)!;
    const { charged_amount } = await t.db.selectFrom('transaction').select('charged_amount').executeTakeFirstOrThrow();
    expect(mail.text).toContain(`Frais à votre charge : ${charged_amount - 5000} XAF`);
    expect(mail.text).toContain(`Total payé : ${charged_amount} XAF`);
    expect(mail.text).toContain('Powered by ProxiaPay');
    expect((await receipt(token, { email: EMAIL, language: 'de' })).status).toBe(400);
  });

  it('stores only the masked address', async () => {
    const token = await pay();
    await settle();
    expect((await receipt(token, { email: EMAIL })).status).toBe(200);
    const stored = await t.db.selectFrom('payment_link_payment').select(['receipts_sent', 'receipt_sent_at', 'receipt_sent_to']).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ receipts_sent: 1, receipt_sent_to: 'a***@gmail.com' });
    expect(stored.receipt_sent_at).toBeInstanceOf(Date);
    expect(maskEmail('aicha@gmail.com')).toBe('a***@gmail.com');
    // No table holds the raw address: dump every row of every table and look.
    const tables = (await t.db.introspection.getTables()).map((x) => x.name);
    for (const name of tables) {
      const dump = JSON.stringify(await t.db.selectFrom(name as 'alert').selectAll().execute());
      expect(dump, name).not.toContain(EMAIL);
      expect(dump, name).not.toContain('aicha.nkoulou');
    }
  });

  it('refuses a 4th receipt', async () => {
    const token = await pay();
    await settle();
    for (let i = 0; i < 3; i++) expect((await receipt(token, { email: EMAIL })).status).toBe(200);
    expect(await receipt(token, { email: EMAIL })).toMatchObject({ status: 409, body: { error: { code: 'RECEIPT_LIMIT_REACHED' } } });
    expect(mailer().sent.filter((m) => m.to === EMAIL)).toHaveLength(3);
    expect((await t.db.selectFrom('payment_link_payment').select('receipts_sent').executeTakeFirstOrThrow()).receipts_sent).toBe(3);
  });

  it('refuses before success, and for an unknown token or a bad address', async () => {
    const token = await pay();
    expect(await receipt(token, { email: EMAIL })).toMatchObject({ status: 409, body: { error: { code: 'RECEIPT_NOT_READY' } } });
    expect(mailer().sent).toHaveLength(0);
    expect((await t.db.selectFrom('payment_link_payment').select('receipts_sent').executeTakeFirstOrThrow()).receipts_sent).toBe(0);
    await settle();
    for (const email of ['nope', 'a@b', 'a b@c.de', 'x@y.zz\nBcc: z@z.zz', '<a>@b.cd', 42, undefined]) expect((await receipt(token, { email })).status).toBe(400);
    expect((await receipt('A'.repeat(43), { email: EMAIL })).status).toBe(404);
  });

  it('a mailer failure answers failed without throwing, keeps no address, and does not mark the receipt as sent', async () => {
    const token = await pay();
    await settle();
    vi.spyOn(mailer(), 'send').mockRejectedValueOnce(new Error(`resend: 422 ${EMAIL} invalid`));
    expect(await receipt(token, { email: EMAIL })).toEqual({ status: 200, body: { status: 'failed' } });
    const stored = await t.db.selectFrom('payment_link_payment').select(['receipt_sent_at', 'receipt_sent_to']).executeTakeFirstOrThrow();
    expect(stored).toEqual({ receipt_sent_at: null, receipt_sent_to: null });
    expect(await receipt(token, { email: EMAIL })).toEqual({ status: 200, body: { status: 'sent' } });
  });
});

describe('the sender header', () => {
  it('quotes the name with the address of MAIL_FROM', () => {
    expect(fromHeader('no-reply@proxia.test', 'Acme Shop via ProxiaPay')).toBe('"Acme Shop via ProxiaPay" <no-reply@proxia.test>');
    expect(fromHeader('ProxiaPay <no-reply@proxia.test>', 'Acme via ProxiaPay')).toBe('"Acme via ProxiaPay" <no-reply@proxia.test>');
  });

  it('a name with quotes, angle brackets or line breaks cannot break or add a header', () => {
    const header = fromHeader('no-reply@proxia.test', 'Evil" <x@evil.test>\r\nBcc: victim@x.test\nSubject: hi \\');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toMatch(/^"[^"\\<>]*" <no-reply@proxia\.test>$/);
    expect(fromHeader('no-reply@proxia.test', '"<>\r\n')).toBe('no-reply@proxia.test');
  });

  it('is what Resend is sent as From', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ id: 'e1' }), { status: 200 }));
    const live = new Mailer({ RESEND_API_KEY: 'k', MAIL_FROM: 'ProxiaPay <no-reply@proxia.test>', NODE_ENV: 'production' });
    await live.send({ to: EMAIL, subject: 's', text: 't', fromName: 'Acme via ProxiaPay' });
    await live.send({ to: EMAIL, subject: 's', text: 't' });
    const sentFrom = fetched.mock.calls.map((c) => (JSON.parse(String((c[1] as RequestInit).body)) as { from: string }).from);
    expect(sentFrom).toEqual(['"Acme via ProxiaPay" <no-reply@proxia.test>', 'ProxiaPay <no-reply@proxia.test>']);
  });
});
