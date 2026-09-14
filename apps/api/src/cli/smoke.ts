/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end smoke test against a running API and worker (spec 16.2: "one internal product
 * collecting real money, with every movement in the ledger"), through HTTP alone.
 *
 * Prerequisites: a migrated and seeded database, an administrator created with admin:create
 * (default ada@example.com / correct-horse-battery-staple) who has not yet enrolled an
 * authenticator, the API and worker running without SMTP so codes appear in the API log.
 *
 *   npm run smoke -w apps/api -- --base http://127.0.0.1:3000 --api-log /path/to/api.log
 */
import { readFileSync } from 'node:fs';
import { totp } from '../crypto/totp';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : [])).filter((p) => p.length)) as Record<string, string>;
const BASE = args.base ?? 'http://127.0.0.1:3000';
const EMAIL = args.email ?? 'ada@example.com';
const PASSWORD = args.password ?? 'correct-horse-battery-staple';
const API_LOG = args['api-log'] ?? process.env.API_LOG ?? '';
async function main() {

let cookie = '';
const j = async (path: string, init: { method?: string; body?: unknown } = {}, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> => {
  const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', 'x-requested-with': 'ProxiaPay', cookie, ...headers }, body: init.body ? JSON.stringify(init.body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0] ?? '';
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};
const check = (name: string, cond: unknown, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); if (!cond) process.exitCode = 1; };

// Console: sign in, enrol, second factor
let r = await j('/console/auth/sign-in', { method: 'POST', body: { email: EMAIL, password: 'wrong-password-here' } });
check('sign-in wrong password → 401 CREDENTIALS_INVALID', r.status === 401 && r.body.error.code === 'CREDENTIALS_INVALID');
r = await j('/console/auth/sign-in', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
check('sign-in → second factor enrol', r.status === 200 && r.body.second_factor === 'enrol', JSON.stringify(r.body));
r = await j('/console/home');
check('home before second factor → 401 SECOND_FACTOR_REQUIRED', r.status === 401 && r.body.error.code === 'SECOND_FACTOR_REQUIRED');
r = await j('/console/auth/second-factor/enrol', { method: 'POST' });
const secret = r.body.secret;
check('enrolment returns secret', typeof secret === 'string' && secret.length >= 32);
r = await j('/console/auth/second-factor', { method: 'POST', body: { code: totp(secret) } });
check('second factor accepted', r.status === 200);
r = await j('/console/auth/me');
check('me has Owner permissions and environment', r.body.permissions?.length > 40 && r.body.environment === 'sandbox');
r = await j('/console/home');
check('home renders cards', r.status === 200 && r.body.cards.provider_status?.length === 1, Object.keys(r.body.cards ?? {}).join(','));
r = await j('/console/projects', { method: 'GET', body: undefined }, { 'x-requested-with': '' });
check('GET without header is fine', r.status === 200);
r = await j('/console/projects', { method: 'POST', body: { code: 'shop', name: 'Shop' } }, { 'x-requested-with': '' });
check('POST without X-Requested-With → 403', r.status === 403);
r = await j('/console/projects', { method: 'POST', body: { code: 'shop', name: 'Shop' } });
check('project created', r.status === 201, JSON.stringify(r.body));
const projectId = r.body.id;
// Credential issue requires a confirmation code: request one, read it from the API log
r = await j(`/console/projects/${projectId}/credentials`, { method: 'POST', body: { scopes: ['collection', 'disbursement', 'read'] } });
check('credential without code → 428 CONFIRMATION_REQUIRED', r.status === 428);
r = await j('/console/auth/confirmations', { method: 'POST', body: { operation_type: 'credential.issue', values: { project_id: projectId, scopes: ['collection', 'disbursement', 'read'] } } });
const confirmationId = r.body.confirmation_id;
check('confirmation issued', r.status === 201 && confirmationId);
await new Promise((res) => setTimeout(res, 300));
const log = API_LOG ? readFileSync(API_LOG, 'utf8') : '';
const codes = [...log.matchAll(/is (\d{6})\./g)].map((m) => m[1]!);
const code = codes.at(-1) ?? '';
check('code visible in development log', Boolean(code));
r = await j(`/console/projects/${projectId}/credentials`, { method: 'POST', body: { scopes: ['collection', 'disbursement', 'read'], confirmation: { id: confirmationId, code: '000000' } } });
check('wrong code → 422 with attempts_remaining 2', r.status === 422 && r.body.error.details?.attempts_remaining === 2, JSON.stringify(r.body));
r = await j(`/console/projects/${projectId}/credentials`, { method: 'POST', body: { scopes: ['collection', 'disbursement', 'read'], confirmation: { id: confirmationId, code } } });
check('credential issued with code', r.status === 201 && r.body.key.startsWith('pk_test_'), JSON.stringify(r.body).slice(0, 80));
const { key, secret: clientSecret } = r.body;
// Grant a route
r = await j('/console/configuration/routes');
const route = r.body.routes.find((x: any) => x.country_code === 'CM' && x.payment_method_code === 'MOMO' && x.direction === 'collection');
check('routes listed with the CM MOMO collection route', Boolean(route), `${r.body.routes.length} routes`);
r = await j(`/console/projects/${projectId}/entitlements`, { method: 'POST', body: { route_id: route.id, count_24h: 100, value_24h: 10000000, count_30d: 1000, value_30d: 100000000, note: 'pilot' } });
check('entitlement granted', r.status === 201, JSON.stringify(r.body));
r = await j(`/console/projects/${projectId}/notification-endpoint`, { method: 'PUT', body: { url: 'http://127.0.0.1:9/hook' } });
check('notification endpoint set; secret shown once', r.status === 200 && r.body.signing_secret.startsWith('whsec_'));

// Project API
r = await j('/v1/auth/tokens', { method: 'POST', body: { client_key: key, client_secret: clientSecret } }, { cookie: '' });
check('token exchange', r.status === 200 && r.body.token_type === 'Bearer' && r.headers.get('x-request-id'), JSON.stringify(r.body).slice(0, 60));
const auth = { authorization: `Bearer ${r.body.access_token}`, cookie: '' };
r = await j('/v1/settings', {}, auth);
check('settings with ETag and route', r.status === 200 && r.headers.get('etag') && r.body.routes.length === 1 && r.body.routes[0].fees.processing.percentage === '2.5', JSON.stringify(r.body.routes[0]?.fees));
const etag = r.headers.get('etag') ?? '';
r = await j('/v1/settings', {}, { ...auth, 'if-none-match': etag });
check('settings If-None-Match → 304', r.status === 304);
r = await j('/v1/previews', { method: 'POST', body: { direction: 'collection', amount: 1000.5, currency: 'XAF', country: 'CM', payment_method: 'MOMO', counterparty: { msisdn: '677123456' }, reference: 'o1' } }, auth);
check('decimal amount → AMOUNT_INVALID', r.status === 400 && r.body.error.code === 'AMOUNT_INVALID');
r = await j('/v1/previews', { method: 'POST', body: { direction: 'collection', amount: 1000, currency: 'XAF', country: 'CM', payment_method: 'MOMO', counterparty: { msisdn: '677123456', name: 'A. Mbarga' }, reference: 'order-4417' } }, auth);
check('preview 201 with figures', r.status === 201 && r.body.charged_amount === 1025 && r.body.counterparty.msisdn === '+237677123456' && r.body.payer_action === 'none', JSON.stringify(r.body).slice(0, 120));
const prv = r.body.reference;
r = await j('/v1/disbursements', { method: 'POST', body: { preview_reference: prv } }, auth);
check('wrong endpoint → PREVIEW_DIRECTION_MISMATCH', r.status === 409 && r.body.error.code === 'PREVIEW_DIRECTION_MISMATCH');
r = await j('/v1/collections', { method: 'POST', body: { preview_reference: prv } }, auth);
check('confirm 201 processing with provider reference', r.status === 201 && r.body.state === 'processing' && r.body.provider_reference?.startsWith('SIM-'), JSON.stringify(r.body).slice(0, 100));
const txn = r.body.reference;
r = await j('/v1/collections', { method: 'POST', body: { preview_reference: prv } }, auth);
check('repeat confirm → 200 same transaction', r.status === 200 && r.body.reference === txn);
check('rate limit headers present', r.headers.get('x-ratelimit-limit') && r.headers.get('x-ratelimit-remaining'));
// wait for the worker sweep (simulator settles after 2 s, sweep every 10 s, first check at 10 s)
let state = 'processing';
for (let i = 0; i < 30 && state !== 'succeeded'; i++) { await new Promise((res) => setTimeout(res, 1000)); r = await j(`/v1/transactions/${txn}`, {}, auth); state = r.body.state; }
check('transaction succeeded through the worker sweep', state === 'succeeded' && r.body.settled_amount === 1000 && r.body.operator_reference?.startsWith('MP'), `state=${state}`);
r = await j('/v1/balances', {}, auth);
check('balance credited 1000 XAF', r.body.balances?.[0]?.available === 1000, JSON.stringify(r.body));
r = await j(`/v1/transactions?project_reference=order-4417`, {}, auth);
check('list by project reference', r.body.data?.length === 1 && r.body.has_more === false);
r = await j('/v1/previews', { method: 'POST', body: { direction: 'collection', amount: 1000, currency: 'XAF', country: 'CM', payment_method: 'MOMO', counterparty: { msisdn: '677123456' }, reference: 'order-4417' } }, auth);
check('reused reference → REFERENCE_CONFLICT', r.status === 409 && r.body.error.code === 'REFERENCE_CONFLICT');
// Console views
r = await j(`/console/transactions/${txn}`);
check('console detail masks payer and shows ledger', r.status === 200 && r.body.payer.masked.includes('•') && r.body.ledger_entries.length === 1 && r.body.amounts.margin === 5, JSON.stringify(r.body.amounts));
r = await j(`/console/search?q=677123456`);
check('search by number finds the transaction and is audited', r.body.results?.some((x: any) => x.reference === txn));
r = await j(`/console/oversight/audit?subject_type=payer`);
check('audit record for identifier search', r.body.records?.length >= 1);
r = await j(`/console/treasury/float`);
check('float account for CM XAF collection exists with balance 1005', r.body.accounts?.[0]?.balance === 1005 && r.body.coverage?.[0]?.ratio === 1.005, JSON.stringify(r.body.coverage));
r = await j(`/console/projects/${projectId}`);
check('project detail shows notification delivery attempts', r.body.deliveries?.length === 1 && r.body.deliveries[0].event_type === 'transaction.succeeded');
r = await j('/console/auth/sign-out', { method: 'POST' });
r = await j('/console/home');
check('after sign-out → 401', r.status === 401);
console.log('done');
}
main().catch((e) => { console.error(e); process.exit(1); });
