import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestContext, type TestContext } from '../test/context';
import { resetConfigForTests } from '../config/config';
import { AppModule } from '../app.module';
import { configureBodyParsers } from '../http/body-parsers';
import { StatusService } from '../providers/status.service';
import { SimulatorAdapter } from '../providers/adapters/simulator.adapter';

import { Mailer, fromHeader } from '../alerts/mailer';
import { escapeHtml, maskEmail, receiptDate, receiptMail, receiptSender, ZONES } from '../payment-links/receipt';

/** The receipt by email: branded, kept as a masked address only, three at most, and only once the payment succeeded. */
let t: TestContext;
let app: INestApplication;
let base: string;
let project: { id: string; key: string; secret: string; adminId: string };
const EMAIL = 'aicha.nkoulou@gmail.com';

const PAYLINK = 'https://pay.example.com';
const had = process.env.PAYLINK_BASE_URL;
beforeAll(async () => {
  process.env.PAYLINK_BASE_URL = PAYLINK;
  resetConfigForTests();
  t = await createTestContext();
  const nest = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: ['error'], abortOnError: false, bodyParser: true });
  configureBodyParsers(nest);
  await nest.listen(0, '127.0.0.1');
  app = nest;
  base = await nest.getUrl();
  SimulatorAdapter.settleAfterMs = 0;
});
afterAll(async () => {
  await app?.close(); await t.close();
  if (had === undefined) delete process.env.PAYLINK_BASE_URL; else process.env.PAYLINK_BASE_URL = had;
  resetConfigForTests();
});
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
    // Amounts grouped as the page shows them, in the mail's language.
    const en = (n: number) => new Intl.NumberFormat('en-GB').format(n);
    for (const part of ['Acme "Shop" <Ltd>', 'Invoice 42', 'Reference: ', 'Date: ', 'Amount: 5,000 XAF', `Fees borne by you: ${en(fees)} XAF`, `Total paid: ${en(row.charged_amount)} XAF`, 'Method: MTN Mobile Money', 'Number: ', 'Powered by ProxiaPay']) expect(mail.text).toContain(part);
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
    const fr = (n: number) => new Intl.NumberFormat('fr-FR').format(n);
    expect(mail.text).toContain(`Montant : ${fr(5000)} XAF`);
    expect(fr(5000)).not.toBe('5000');
    expect(mail.text).toContain(`Frais à votre charge : ${fr(charged_amount - 5000)} XAF`);
    expect(mail.text).toContain(`Total payé : ${fr(charged_amount)} XAF`);
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

  it('a send that went out answers sent even when recording it fails', async () => {
    const token = await pay();
    await settle();
    // The mail is gone: the payer is told so, whatever happens to the record of it afterwards.
    await sql`create function test_refuse_receipt_record() returns trigger language plpgsql as $$ begin raise exception 'store unavailable'; end $$`.execute(t.db);
    await sql`create trigger test_refuse_receipt_record before update on payment_link_payment for each row when (new.receipt_sent_to is distinct from old.receipt_sent_to) execute function test_refuse_receipt_record()`.execute(t.db);
    try {
      expect(await receipt(token, { email: EMAIL })).toEqual({ status: 200, body: { status: 'sent' } });
      expect(mailer().sent.filter((m) => m.to === EMAIL)).toHaveLength(1);
    } finally {
      await sql`drop trigger test_refuse_receipt_record on payment_link_payment`.execute(t.db);
      await sql`drop function test_refuse_receipt_record()`.execute(t.db);
    }
  });

  it('dates the mail in the method country’s time, in the mail’s language', async () => {
    const token = await pay();
    await settle();
    await t.db.updateTable('transaction').set({ terminal_at: new Date('2026-11-15T13:32:00Z') }).execute();
    await receipt(token, { email: EMAIL, language: 'en' });
    expect(mailer().sent[0]!.text).toContain('Date: 15 November 2026 at 14:32\n');
  });
});

describe('the receipt’s words', () => {
  const data = { projectName: 'Acme', title: 'Invoice 42', reference: 'PP-1', paidAt: new Date('2026-11-15T13:32:00Z'), amount: 1_250_000, fees: 3125, total: 1_253_125, exponent: 0, currency: 'XAF', country: 'CM', method: 'MTN Mobile Money', maskedNumber: '+237•••••3456' };

  it('dates in the country’s own zone, or in UTC said so for a country over several zones', () => {
    expect(receiptDate(new Date('2026-11-15T13:32:00Z'), 'CM', 'en')).toBe('15 November 2026 at 14:32');
    expect(receiptDate(new Date('2026-11-15T13:32:00Z'), 'SN', 'fr')).toMatch(/^15 novembre 2026 (à )?13:32$/);
    // Kinshasa and Lubumbashi are an hour apart: neither is the country's time.
    expect(receiptDate(new Date('2026-11-15T13:32:00Z'), 'CD', 'en')).toBe('15 November 2026 at 13:32 UTC');
    expect(receiptDate(new Date('2026-11-15T13:32:00Z'), 'ZZ', 'fr')).toMatch(/^15 novembre 2026 (à )?13:32 UTC$/);
  });

  it('groups amounts by language and keeps the currency’s decimals', () => {
    expect(receiptMail(data, 'en').text).toContain('Total paid: 1,253,125 XAF');
    expect(receiptMail(data, 'fr').text).toContain(`Total payé : ${new Intl.NumberFormat('fr-FR').format(1_253_125)} XAF`);
    expect(receiptMail({ ...data, amount: 123_456_789, fees: 5, total: 1255, exponent: 2, currency: 'USD' }, 'en').text).toContain('Amount: 1,234,567.89 USD');
    expect(receiptMail({ ...data, amount: 123_456_789, fees: 5, total: 1255, exponent: 2, currency: 'USD' }, 'fr').text).toContain(`Montant : ${new Intl.NumberFormat('fr-FR').format(1_234_567)},89 USD`);
    expect(receiptMail({ ...data, amount: 1250, fees: 5, total: 1255, exponent: 2, currency: 'USD' }, 'en').text).toContain('Fees borne by you: 0.05 USD');
  });

  it('keeps the page’s zones', () => {
    const page = readFileSync(join(__dirname, '../../../console/src/pay/country.ts'), 'utf8');
    const zones = Object.fromEntries([...page.matchAll(/'([A-Za-z_/-]+)': '([A-Z]{2})'/g)].map((m) => [m[1], m[2]]));
    expect(ZONES).toEqual(zones);
  });

  it('masks an address from its first character, whatever it is', () => {
    expect(maskEmail('😀ama@example.com')).toBe('😀***@example.com');
  });
});

describe('the sender header', () => {
  it('a long project name is cut before " via ProxiaPay", which always survives', () => {
    const long = receiptSender('Ü'.repeat(300));
    expect(long.endsWith(' via ProxiaPay')).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(128);
    expect(fromHeader('no-reply@proxia.test', long)).toMatch(/ via ProxiaPay" <no-reply@proxia\.test>$/);
    expect(fromHeader('no-reply@proxia.test', receiptSender(`${'😀'.repeat(200)}`))).toMatch(/ via ProxiaPay" </);
    expect(receiptSender('Acme')).toBe('Acme via ProxiaPay');
  });

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

describe('the receipt in HTML', () => {
  const data = { projectName: 'Acme', title: 'Invoice 42', reference: 'PP-1', paidAt: new Date('2026-11-15T13:32:00Z'), amount: 1_250_000, fees: 3125, total: 1_253_125, exponent: 0, currency: 'XAF', country: 'CM', method: 'MTN Mobile Money', maskedNumber: '+237•••••3456', primaryColor: '#1A56DB', logoUrl: 'https://pay.example.com/pay-api/v1/assets/abc' };

  it('the html escapes a project name with markup', () => {
    const evil = `<script>alert(1)</script> & "Q" 'S'`;
    const html = receiptMail({ ...data, projectName: evil, title: evil, reference: evil, method: evil, maskedNumber: evil }, 'en').html;
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Q&quot; &#39;S&#39;');
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    // The text part stays plain.
    expect(receiptMail({ ...data, projectName: evil }, 'en').text).toContain(evil);
  });

  it('the html carries the logo URL on the paylink host and the primary colour', () => {
    const html = receiptMail(data, 'en').html;
    expect(html).toContain('<img src="https://pay.example.com/pay-api/v1/assets/abc"');
    expect(html).toContain('background:#1A56DB');
    expect(html).toContain('Powered by ProxiaPay');
    expect(html).toContain('Total paid');
    expect(html).toContain('1,253,125 XAF');
    expect(html).not.toMatch(/<script|<style|<link|class=/);
    const fr = receiptMail(data, 'fr').html;
    expect(fr).toContain('lang="fr"');
    expect(fr).toContain('Total payé');
    expect(fr).toContain('Référence');
  });

  it('no logo, no img', () => {
    expect(receiptMail({ ...data, logoUrl: null }, 'en').html).not.toContain('<img');
    expect(receiptMail({ ...data, logoUrl: undefined }, 'en').html).not.toContain('<img');
  });

  it('a non-hex colour never reaches the html', () => {
    for (const bad of ['crimson', '#12345', 'url(javascript:x)', '#1A56DB;background:url(x)', '"><script>']) {
      const html = receiptMail({ ...data, primaryColor: bad }, 'en').html;
      expect(html).not.toContain(bad);
      expect(html).toContain('background:#0B0D12');
    }
  });

  it('sends html beside the text to Resend, and logs the text only without a key', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ id: 'e1' }), { status: 200 }));
    const live = new Mailer({ RESEND_API_KEY: 'k', MAIL_FROM: 'no-reply@proxia.test', NODE_ENV: 'production' });
    await live.send({ to: EMAIL, subject: 's', text: 'plain', html: '<p>rich</p>' });
    await live.send({ to: EMAIL, subject: 's', text: 'plain' });
    const bodies = fetched.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { text: string; html?: string });
    expect(bodies[0]).toMatchObject({ text: 'plain', html: '<p>rich</p>' });
    expect(bodies[1]!.html).toBeUndefined();
    const logged = new Mailer({ RESEND_API_KEY: undefined, MAIL_FROM: undefined, NODE_ENV: 'test' });
    fetched.mockClear();
    expect(await logged.send({ to: EMAIL, subject: 's', text: 'plain', html: '<p>rich</p>' })).toBe('logged');
    expect(fetched).not.toHaveBeenCalled();
  });

  it('the receipt endpoint sends the link’s logo and colour, text and html both', async () => {
    const asset = await t.db.insertInto('brand_asset').values({ project_id: project.id, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), content_type: 'image/png', sha256: 'x' }).returning('id').executeTakeFirstOrThrow();
    const token = await pay();
    await t.db.updateTable('payment_link').set({ logo_asset_id: asset.id, primary_color: '#047857' }).execute();
    await settle();
    expect(await receipt(token, { email: EMAIL, language: 'en' })).toEqual({ status: 200, body: { status: 'sent' } });
    const mail = mailer().sent.find((m) => m.to === EMAIL)!;
    expect(mail.text).toContain('Powered by ProxiaPay');
    expect(mail.html).toContain(`src="${PAYLINK}/pay-api/v1/assets/${asset.id}"`);
    expect(mail.html).toContain('background:#047857');
    expect(mail.html).toContain('Acme &quot;Shop&quot; &lt;Ltd&gt;');

    // The link is disabled later: the receipt's logo is still served, because a payment succeeded through it.
    await t.db.updateTable('payment_link').set({ status: 'disabled' }).execute();
    const res = await fetch(`${base}/pay-api/v1/assets/${asset.id}`);
    expect(res.status).toBe(200);
  });

  it('a logo of a disabled link nobody paid through is still not served', async () => {
    const asset = await t.db.insertInto('brand_asset').values({ project_id: project.id, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), content_type: 'image/png', sha256: 'y' }).returning('id').executeTakeFirstOrThrow();
    const l = await link(await routeId('CM', 'MOMO'));
    await t.db.updateTable('payment_link').set({ logo_asset_id: asset.id, status: 'disabled' }).where('id', '=', l.id).execute();
    expect((await fetch(`${base}/pay-api/v1/assets/${asset.id}`)).status).toBe(404);
  });
});
