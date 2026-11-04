import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { ProjectAuthService, type ProjectPrincipal } from '../project-auth/project-auth.service';
import { PreviewService } from '../transactions/preview.service';
import { TransactionService } from '../transactions/transaction.service';
import { SubmissionService } from '../providers/submission.service';
import { StatusService } from '../providers/status.service';
import { SimulatorAdapter } from '../providers/adapters/simulator.adapter';
import { LedgerService } from '../ledger/ledger.service';
import { TreasuryService } from '../treasury/treasury.service';
import { HomeService } from './home.service';

let t: TestContext;
let auth: ProjectAuthService, previews: PreviewService, transactions: TransactionService, submission: SubmissionService, status: StatusService, home: HomeService;
let project: { id: string; key: string; secret: string; adminId: string };
let principal: ProjectPrincipal;
let counter = 0;

beforeAll(async () => {
  t = await createTestContext();
  auth = t.app.get(ProjectAuthService); previews = t.app.get(PreviewService); transactions = t.app.get(TransactionService); submission = t.app.get(SubmissionService); status = t.app.get(StatusService); home = new HomeService(t.db);
  SimulatorAdapter.settleAfterMs = 0;
});
afterAll(() => t.close());

async function principalOf(p: { key: string; secret: string }): Promise<ProjectPrincipal> {
  const token = await auth.exchange(p.key, p.secret, '10.0.0.1');
  return auth.resolveToken(token.access_token, '10.0.0.1');
}

beforeEach(async () => {
  await t.reset();
  SimulatorAdapter.wallets = [];
  project = await t.project('shop', { fundXaf: 5_000_000 });
  principal = await principalOf(project);
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

/** A real collection through the whole flow, then placed in time and in a terminal state. */
async function txn(route: 'MOMO' | 'OM', at: Date, state: 'succeeded' | 'failed', who: ProjectPrincipal = principal, direction: 'collection' | 'disbursement' = 'collection', settled = 1000): Promise<string> {
  const n = ++counter;
  // Disbursements need float to confirm; the flow runs as a collection and the row is turned into one afterwards.
  const p = await previews.create(who, { direction: 'collection', amount: 1000, currency: 'XAF', country: 'CM', payment_method: route, counterparty: { msisdn: `2376${String(70000000 + n)}` }, reference: `home-${n}` });
  const { transactionId } = await transactions.confirm(who, p.reference, 'collection');
  await submission.submit(transactionId);
  await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).where('id', '=', transactionId).execute();
  await status.sweep();
  await t.db.updateTable('transaction').set({ direction, state, terminal_at: at, settled_amount: state === 'succeeded' ? settled : null, failure_reason: state === 'failed' ? 'declined' : null }).where('id', '=', transactionId).execute();
  return transactionId;
}

const routeId = async (code: string, direction = 'collection') =>
  (await t.db.selectFrom('route').select('id').where('country_code', '=', 'CM').where('payment_method_code', '=', code).where('direction', '=', direction).executeTakeFirstOrThrow()).id;

describe('overallSuccess', () => {
  it('compares the last hour with the days before it', async () => {
    for (let i = 0; i < 3; i++) await txn('MOMO', hoursAgo(0.1), 'succeeded');
    await txn('MOMO', hoursAgo(0.1), 'failed');
    // 20 terminal transactions in the baseline: the smallest sample the baseline is trusted on.
    for (let i = 0; i < 16; i++) await txn('MOMO', daysAgo(2), 'succeeded');
    for (let i = 0; i < 4; i++) await txn('MOMO', daysAgo(2), 'failed');
    expect(await home.overallSuccess(null)).toEqual({ current: 0.75, baseline: 0.8, sample: 4 });
  });

  it('gives no baseline on fewer than 20 terminal transactions, and no current rate in a quiet hour', async () => {
    for (let i = 0; i < 3; i++) await txn('MOMO', daysAgo(2), 'succeeded');
    expect(await home.overallSuccess(null)).toEqual({ current: null, baseline: null, sample: 0 });
  });
});

describe('routeSeries', () => {
  it('returns 24 hourly buckets per route, oldest first, and keeps two routes of one country apart', async () => {
    // Anchored to the current hour, so the buckets do not depend on the minute the test runs in.
    const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    await txn('MOMO', new Date(hourStart - 3 * 3_600_000 + 60_000), 'failed');
    await txn('MOMO', new Date(), 'succeeded');
    await txn('OM', new Date(), 'succeeded');
    const series = await home.routeSeries(null, true);
    expect(series).toHaveLength(2);
    const momo = series.find((s) => s.payment_method_code === 'MOMO')!;
    const om = series.find((s) => s.payment_method_code === 'OM')!;
    expect(momo.route_id).toBe(await routeId('MOMO'));
    expect(om.route_id).toBe(await routeId('OM'));
    expect(momo).toMatchObject({ country_code: 'CM', currency: 'XAF', direction: 'collection', payment_method_name: expect.any(String) });
    expect(momo.hours).toHaveLength(24);
    expect(momo.hours.map((h) => h.hour)).toEqual([...momo.hours.map((h) => h.hour)].sort());
    expect(momo.hours[20]).toMatchObject({ terminal: 1, succeeded: 0 });
    expect(momo.hours[23]).toMatchObject({ terminal: 1, succeeded: 1 });
    expect(om.hours[20]).toMatchObject({ terminal: 0, succeeded: 0 });
    expect(Date.parse(momo.hours[23]!.hour)).toBeLessThanOrEqual(Date.now());
  });

  it('marks a route with an open health alert as alerted and departing', async () => {
    await txn('MOMO', hoursAgo(0.1), 'succeeded');
    await txn('OM', hoursAgo(0.1), 'succeeded');
    const id = await routeId('MOMO');
    await t.db.insertInto('alert').values({ category: 'service_health', severity: 'warning', subject_type: 'route', subject_reference: id, fingerprint: `health:success_rate:route:${id}`, title: 'fell', action_reference: '/x' }).execute();
    const series = await home.routeSeries(null, true);
    expect(series.find((s) => s.route_id === id)).toMatchObject({ alerted: true, departing: true });
    expect(series.find((s) => s.route_id !== id)).toMatchObject({ alerted: false, departing: false });
    // Without the permission to read alerts the same route is judged on its rate alone, which is healthy.
    expect((await home.routeSeries(null, false)).find((s) => s.route_id === id)).toMatchObject({ alerted: false, departing: false });
  });
});

describe('collectedToday', () => {
  it('sums succeeded collections settled today per currency, against the same stretch a week ago', async () => {
    await txn('MOMO', new Date(), 'succeeded', principal, 'collection', 1000);
    await txn('MOMO', new Date(), 'failed');
    await txn('MOMO', new Date(), 'succeeded', principal, 'disbursement', 700);
    // A moment before this time last week, but never before last week's midnight, even just after UTC midnight.
    const sinceMidnight = Date.now() - Math.floor(Date.now() / 86_400_000) * 86_400_000;
    await txn('MOMO', new Date(daysAgo(7).getTime() - Math.min(60_000, sinceMidnight / 2)), 'succeeded', principal, 'collection', 400);
    expect(await home.collectedToday(null)).toEqual([{ currency: 'XAF', today: 1000, last_week: 400 }]);
  });

  it('has no last-week figure when nothing was collected then', async () => {
    await txn('MOMO', new Date(), 'succeeded', principal, 'collection', 1000);
    expect(await home.collectedToday(null)).toEqual([{ currency: 'XAF', today: 1000, last_week: null }]);
  });
});

describe('undetermined', () => {
  it('counts transactions with no known outcome', async () => {
    const a = await txn('MOMO', new Date(), 'succeeded');
    const b = await txn('OM', new Date(), 'succeeded');
    await txn('OM', new Date(), 'succeeded');
    await t.db.updateTable('transaction').set({ state: 'undetermined', terminal_at: null, settled_amount: null }).where('id', 'in', [a, b]).execute();
    expect(await home.undetermined(null)).toBe(2);
  });
});

describe('scope', () => {
  it("hides another project's transactions, and an empty scope sees nothing", async () => {
    const other = await t.project('other', { fundXaf: 5_000_000 });
    const otherPrincipal = await principalOf(other);
    for (let i = 0; i < 2; i++) await txn('MOMO', new Date(), 'succeeded');
    const u = await txn('MOMO', new Date(), 'succeeded');
    await t.db.updateTable('transaction').set({ state: 'undetermined', terminal_at: null, settled_amount: null }).where('id', '=', u).execute();
    for (let i = 0; i < 5; i++) await txn('OM', new Date(), 'failed', otherPrincipal);
    const v = await txn('OM', new Date(), 'succeeded', otherPrincipal, 'collection', 9000);
    await t.db.updateTable('transaction').set({ state: 'undetermined', terminal_at: null, settled_amount: null }).where('id', '=', v).execute();

    const mine = [project.id];
    expect(await home.overallSuccess(mine)).toEqual({ current: 1, baseline: null, sample: 2 });
    expect((await home.routeSeries(mine, true)).map((s) => s.payment_method_code)).toEqual(['MOMO']);
    expect(await home.collectedToday(mine)).toEqual([{ currency: 'XAF', today: 2000, last_week: null }]);
    expect(await home.undetermined(mine)).toBe(1);

    expect(await home.overallSuccess([])).toEqual({ current: null, baseline: null, sample: 0 });
    expect(await home.routeSeries([], true)).toEqual([]);
    expect(await home.collectedToday([])).toEqual([]);
    expect(await home.undetermined([])).toBe(0);
  });
});

describe('problems', () => {
  const alert = (subject_type: string, subject_reference: string, fingerprint: string, severity = 'warning') =>
    t.db.insertInto('alert').values({ category: 'service_health', severity, subject_type, subject_reference, fingerprint, title: `alert ${fingerprint}`, action_reference: '/somewhere' }).execute();

  it('reports a suspended provider account as critical, only when providers are in scope', async () => {
    const acct = await t.db.selectFrom('provider_account').select(['id', 'name']).executeTakeFirstOrThrow();
    await t.db.updateTable('provider_account').set({ status: 'suspended', suspended_at: new Date() }).where('id', '=', acct.id).execute();
    expect(await home.problems({ alerts: false, providers: true })).toMatchObject([{ severity: 'critical', kind: 'provider_suspended', subject_type: 'provider_account', subject_reference: acct.id, subject_name: acct.name, link: `/configuration/providers/${acct.id}` }]);
    expect(await home.problems({ alerts: true, providers: false })).toEqual([]);
  });

  it('leaves alert-backed problems out unless alerts are in scope', async () => {
    await alert('project', project.id, `health:success_rate:project:${project.id}`);
    expect(await home.problems({ alerts: false, providers: true })).toEqual([]);
    expect(await home.problems({ alerts: true, providers: false })).toHaveLength(1);
  });

  it('names routes, provider accounts, projects and float accounts, and falls back to the reference for float drift', async () => {
    const rid = await routeId('MOMO');
    const pm = await t.db.selectFrom('payment_method').select('name').where('code', '=', 'MOMO').executeTakeFirstOrThrow();
    const acct = await t.db.selectFrom('provider_account').select(['id', 'name']).executeTakeFirstOrThrow();
    const accountId = await t.app.get(LedgerService).getOrCreateAccount(t.db, { type: 'float', providerAccountId: acct.id, countryCode: 'CM', currency: 'XAF', direction: 'disbursement' });
    const float = (await t.app.get(TreasuryService).floatAccounts(t.db)).find((f) => f.id === accountId)!;
    await alert('route', rid, `health:success_rate:route:${rid}`);
    await alert('provider_account', acct.id, `health:success_rate:provider_account:${acct.id}`);
    await alert('project', project.id, `health:success_rate:project:${project.id}`);
    await alert('float_account', float.id, `float_cover:${float.id}`, 'critical');
    await alert('float_account', 'CM/XAF/disbursement', 'float_drift:CM/XAF/disbursement');
    const names = new Map((await home.problems({ alerts: true, providers: false })).map((p) => [`${p.subject_type}:${p.subject_reference}`, p.subject_name]));
    expect(names.get(`route:${rid}`)).toBe(`${pm.name} CM · collection`);
    expect(names.get(`provider_account:${acct.id}`)).toBe(acct.name);
    expect(names.get(`project:${project.id}`)).toBe('shop');
    expect(names.get(`float_account:${float.id}`)).toBe(`${float.providerAccountName} ${float.countryCode} ${float.currency} ${float.direction}`);
    expect(names.get('float_account:CM/XAF/disbursement')).toBe('CM/XAF/disbursement');
  });
});
