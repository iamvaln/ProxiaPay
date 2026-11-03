import { RouteService } from '../console-api/route.service';
import { AuditService } from '../audit/audit.service';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { ProjectAuthService, type ProjectPrincipal } from '../project-auth/project-auth.service';
import { PreviewService } from '../transactions/preview.service';
import { TransactionService } from '../transactions/transaction.service';
import { SubmissionService } from '../providers/submission.service';
import { StatusService } from '../providers/status.service';
import { LedgerService } from '../ledger/ledger.service';
import { TransactionReader } from '../transactions/transaction-reader';
import { SimulatorAdapter } from '../providers/adapters/simulator.adapter';
import { PlatformError } from '../common/errors';
import { NotificationService } from '../notifications/notification.service';
import { TreasuryService } from '../treasury/treasury.service';

let t: TestContext;
let auth: ProjectAuthService, previews: PreviewService, transactions: TransactionService, submission: SubmissionService, status: StatusService, ledger: LedgerService, reader: TransactionReader, notifications: NotificationService, treasury: TreasuryService;
let principal: ProjectPrincipal;
let project: { id: string; key: string; secret: string; adminId: string };

beforeAll(async () => {
  t = await createTestContext();
  auth = t.app.get(ProjectAuthService); previews = t.app.get(PreviewService); transactions = t.app.get(TransactionService); submission = t.app.get(SubmissionService);
  status = t.app.get(StatusService); ledger = t.app.get(LedgerService); reader = t.app.get(TransactionReader); notifications = t.app.get(NotificationService); treasury = t.app.get(TreasuryService);
  SimulatorAdapter.settleAfterMs = 0;
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  project = await t.project('shop', { fundXaf: 50_000 });
  const token = await auth.exchange(project.key, project.secret, '10.0.0.1');
  principal = await auth.resolveToken(token.access_token, '10.0.0.1');
});

const collection = (msisdn: string, reference: string, amount = 1000) => ({ direction: 'collection', amount, currency: 'XAF', country: 'CM', payment_method: 'MOMO', counterparty: { msisdn, name: 'A. Mbarga' }, reference });
const providerAccount = async () => (await t.db.selectFrom('provider_account').select('id').executeTakeFirstOrThrow()).id;

describe('token exchange', () => {
  it('refuses a wrong secret and a revoked credential the same way the spec names', async () => {
    await expect(auth.exchange(project.key, 'sk_test_wrong', '10.0.0.1')).rejects.toMatchObject({ code: 'CREDENTIALS_INVALID' });
    await expect(auth.exchange('pk_test_nope', 'x', '10.0.0.1')).rejects.toMatchObject({ code: 'CREDENTIALS_INVALID' });
  });
  it('refuses an undeclared origin before credentials once an origin is declared', async () => {
    await t.db.insertInto('project_origin').values({ project_id: project.id, cidr: '10.0.0.0/8', description: 'dc' }).execute();
    await expect(auth.exchange(project.key, 'whatever', '192.168.1.1')).rejects.toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    await expect(auth.exchange(project.key, project.secret, '10.1.2.3')).resolves.toMatchObject({ token_type: 'Bearer' });
    expect(await t.db.selectFrom('origin_refusal').selectAll().execute()).toHaveLength(1);
  });
});

describe('collection', () => {
  it('previews with the spec figures, confirms, succeeds through the sweep and posts the ledger', async () => {
    const p = await previews.create(principal, collection('677123456', 'order-1'));
    expect(p).toMatchObject({ requested_amount: 1000, charged_amount: 1025, settled_amount: 1000, fees: { processing: { amount: 25, bearer: 'counterparty' }, platform: { amount: 0, bearer: 'counterparty' }, total: 25 }, counterparty: { msisdn: '+237677123456' }, payer_action: 'none' });
    const { transactionId, created } = await transactions.confirm(principal, p.reference, 'collection');
    expect(created).toBe(true);
    await submission.submit(transactionId);
    let api = await reader.apiById(t.db, transactionId, { revealMsisdn: true, revealAction: true });
    expect(api.state).toBe('processing');
    // The provider adds its 2 percent on top, so it is sent 1005, not the 1000 requested: 1005 + 20 = 1025, the quote.
    expect(api.provider_reference).toMatch(/^SIM-ok-c-1005-XAF-/);
    // Repeating the confirmation returns the same transaction.
    const again = await transactions.confirm(principal, p.reference, 'collection');
    expect(again).toEqual({ transactionId, created: false });
    await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).execute();
    await status.sweep();
    api = await reader.apiById(t.db, transactionId, { revealMsisdn: true, revealAction: true });
    expect(api.state).toBe('succeeded');
    expect(api.settled_amount).toBe(1000);
    expect(api.operator_reference).toMatch(/^MP/);
    expect(await ledger.projectBalances(t.db, project.id)).toEqual([{ currency: 'XAF', available: 51_000, reserved: 0 }]);
    expect(await ledger.balanceByKey(t.db, { type: 'float', providerAccountId: await providerAccount(), countryCode: 'CM', currency: 'XAF', direction: 'collection' })).toBe(1005); // 1025 − 20 provider fee
    expect(await ledger.balanceByKey(t.db, { type: 'processing_revenue', currency: 'XAF' })).toBe(25);
    const events = await t.db.selectFrom('transaction_event').select(['prior_state', 'new_state', 'source']).where('transaction_id', '=', transactionId).orderBy('id').execute();
    expect(events.map((e) => e.new_state)).toEqual(['created', 'submitted', 'processing', 'succeeded']);
    expect(events[3]!.source).toBe('status_check');
  });

  it('never debits the payer above the quote when the provider\'s rounding cannot reach it, and books what was debited', async () => {
    // 124 requested is quoted 127 (2.5 percent, half-up). The simulator's 2 percent half-up makes 126
    // and 128 reachable but not 127 — the shape of the live Ejara case, where 103 could not be hit.
    const p = await previews.create(principal, { ...collection('677123456', 'order-unreachable'), amount: 124 });
    expect(p.charged_amount).toBe(127);
    const { transactionId } = await transactions.confirm(principal, p.reference, 'collection');
    await submission.submit(transactionId);
    let api = await reader.apiById(t.db, transactionId, { revealMsisdn: true, revealAction: true });
    expect(api.provider_reference).toMatch(/^SIM-ok-c-124-XAF-/);
    await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).execute();
    await status.sweep();
    api = await reader.apiById(t.db, transactionId, { revealMsisdn: true, revealAction: true });
    expect(api.state).toBe('succeeded');
    expect(api.charged_amount).toBe(126); // what the payer was actually debited, one under the quote
    expect(await ledger.balanceByKey(t.db, { type: 'float', providerAccountId: await providerAccount(), countryCode: 'CM', currency: 'XAF', direction: 'collection' })).toBe(124);
    expect(await ledger.balanceByKey(t.db, { type: 'processing_revenue', currency: 'XAF' })).toBe(2); // 3 quoted, 1 not collected
  });

  it('rejects malformed and foreign numbers, reference reuse, and similar pending payments', async () => {
    await expect(previews.create(principal, collection('12', 'x'))).rejects.toMatchObject({ code: 'PAYER_IDENTIFIER_INVALID' });
    await expect(previews.create(principal, collection('+221771234567', 'x'))).rejects.toMatchObject({ code: 'PAYER_IDENTIFIER_INVALID' });
    await expect(previews.create(principal, { ...collection('677123456', 'x'), amount: 10 })).rejects.toMatchObject({ code: 'AMOUNT_BELOW_MINIMUM', options: { details: { minimum: 100 } } });
    await expect(previews.create(principal, { ...collection('677123456', 'x'), country: 'ZZ' })).rejects.toMatchObject({ code: 'COUNTRY_UNKNOWN' });
    await expect(previews.create(principal, { ...collection('677123456', 'x'), payment_method: 'WAVE' })).rejects.toMatchObject({ code: 'ROUTE_UNAVAILABLE' });
    const p = await previews.create(principal, collection('677123456', 'order-2'));
    // Same reference, same intent: the original comes back. Different intent: conflict.
    expect((await previews.create(principal, collection('677123456', 'order-2'))).reference).toBe(p.reference);
    await expect(previews.create(principal, collection('677123456', 'order-2', 2000))).rejects.toMatchObject({ code: 'REFERENCE_CONFLICT' });
    const { transactionId } = await transactions.confirm(principal, p.reference, 'collection');
    await submission.submit(transactionId);
    await expect(previews.create(principal, collection('0677123456', 'order-3'))).rejects.toMatchObject({ code: 'SIMILAR_PAYMENT_PENDING' });
    await expect(transactions.confirm(principal, p.reference, 'disbursement')).rejects.toMatchObject({ code: 'PREVIEW_DIRECTION_MISMATCH' });
  });

  it('expires a preview after its window', async () => {
    const p = await previews.create(principal, collection('677123456', 'order-4'));
    await t.db.updateTable('preview').set({ expires_at: new Date(Date.now() - 1000) }).execute();
    await expect(transactions.confirm(principal, p.reference, 'collection')).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });
    await previews.expireOpen();
    expect((await t.db.selectFrom('preview').select('status').executeTakeFirstOrThrow()).status).toBe('expired');
  });

  it('records a payer decline as a failure with no ledger movement, and notifies the project', async () => {
    await notifications.setEndpoint(t.db, project.id, 'http://127.0.0.1:1/hook', project.adminId);
    const p = await previews.create(principal, collection('677123401', 'order-5'));
    const { transactionId } = await transactions.confirm(principal, p.reference, 'collection');
    await submission.submit(transactionId);
    await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).execute();
    await status.sweep();
    const api = await reader.apiById(t.db, transactionId, { revealMsisdn: true, revealAction: true });
    expect(api).toMatchObject({ state: 'failed', failure_reason: 'PAYER_DECLINED', settled_amount: null });
    expect(await t.db.selectFrom('ledger_entry').selectAll().where('transaction_id', '=', transactionId).execute()).toHaveLength(0);
    const deliveries = await t.db.selectFrom('notification_delivery').selectAll().execute();
    expect(deliveries.map((d) => d.event_type)).toEqual(['transaction.failed']);
    expect((deliveries[0]!.payload as { data: { transaction: { state: string } } }).data.transaction.state).toBe('failed');
    await t.drain(); // delivery attempt fails against the closed port and is rescheduled
    const attempts = await t.db.selectFrom('notification_delivery_attempt').selectAll().execute();
    expect(attempts).toHaveLength(1);
    expect((await t.db.selectFrom('notification_delivery').select('status').executeTakeFirstOrThrow()).status).toBe('pending');
  });

  it('falls back to a second provider when the first is unreachable, and fails with NO_PROVIDER_AVAILABLE when none remain', async () => {
    const p = await previews.create(principal, collection('677123403', 'order-6'));
    const { transactionId } = await transactions.confirm(principal, p.reference, 'collection');
    await submission.submit(transactionId);
    const api = await reader.apiById(t.db, transactionId, { revealMsisdn: true, revealAction: true });
    expect(api).toMatchObject({ state: 'failed', failure_reason: 'NO_PROVIDER_AVAILABLE' });
    const attempts = await t.db.selectFrom('transaction_attempt').selectAll().execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ state: 'failed', failure_reason: 'PROVIDER_UNAVAILABLE' });
  });

  it('moves a silent provider to undetermined at the sweep ceiling', async () => {
    const p = await previews.create(principal, collection('677123402', 'order-7'));
    const { transactionId } = await transactions.confirm(principal, p.reference, 'collection');
    await submission.submit(transactionId);
    await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0), sweep_ceiling_at: new Date(Date.now() - 1000) }).execute();
    await status.sweep();
    const api = await reader.apiById(t.db, transactionId, { revealMsisdn: true, revealAction: true });
    expect(api).toMatchObject({ state: 'undetermined', failure_reason: 'OUTCOME_UNDETERMINED' });
    expect(await t.db.selectFrom('alert').select('title').where('fingerprint', '=', `undetermined:${transactionId}`).executeTakeFirst()).toBeTruthy();
  });

  it('handles a one-time code: wrong code counts down, right code succeeds', async () => {
    const p = await previews.create(principal, collection('677123406', 'order-8'));
    const { transactionId } = await transactions.confirm(principal, p.reference, 'collection');
    await submission.submit(transactionId);
    let api = await reader.apiById(t.db, transactionId, { revealMsisdn: true, revealAction: true });
    expect(api.state).toBe('action_required');
    expect(api.action).toMatchObject({ type: 'code', attempts_remaining: 3 });
    const submitCode = (code: string) => transactions.submitCode(principal, api.reference, code, async (txn, ref, c) => {
      const r = await new SimulatorAdapter().submitCode({ account: { id: '', baseUrl: '', credentials: {} }, correlationId: '', recordPayload: async () => (await t.db.insertInto('provider_payload').values({ flow: 'outbound_response', kind: 'otp', body: '{}' }).returning('id').executeTakeFirstOrThrow()).id }, ref, c);
      return { state: r.state, actualProviderFee: r.providerFee ?? null, operatorReference: r.operatorReference ?? null, payloadId: r.payloadId };
    });
    await expect(submitCode('000000')).rejects.toMatchObject({ code: 'CODE_INVALID', options: { details: { attempts_remaining: 2 } } });
    api = await submitCode('123456');
    expect(api.state).toBe('succeeded');
    const events = await t.db.selectFrom('transaction_event').select('detail').where('transaction_id', '=', transactionId).execute();
    expect(JSON.stringify(events)).not.toContain('123456');
  });
});

describe('disbursement', () => {
  it('raises an alert at settlement when a fee-deducting provider delivers less than it should have', async () => {
    // The live Ejara payout: promised 520, delivered 512. A provider that deducts its fee reports
    // the recipient's amount, so it is compared with the delivery expected for what it was sent.
    const admin = await t.admin();
    const float = await ledger.getOrCreateAccount(t.db, { type: 'float', providerAccountId: await providerAccount(), countryCode: 'CM', currency: 'XAF', direction: 'disbursement' });
    await t.db.transaction().execute((tx) => ledger.postFloatFunding(tx, { floatAccountId: float, currency: 'XAF', amount: 100_000, authorId: admin.id, justification: 'capital' }));
    const p = await previews.create(principal, { ...collection('677123456', 'deliver-1'), direction: 'disbursement' });
    const { transactionId } = await transactions.confirm(principal, p.reference, 'disbursement');
    await submission.submit(transactionId);
    // As a deducting provider's submission records it: sent enough to deliver the promised 975.
    const row0 = await t.db.selectFrom('transaction').select('current_attempt_id').where('id', '=', transactionId).executeTakeFirstOrThrow();
    await t.db.updateTable('transaction_attempt').set({ binding_snapshot: JSON.stringify({ sent_amount: 990, expected_delivery: 975 }) }).where('id', '=', row0.current_attempt_id!).execute();
    await t.db.transaction().execute(async (tx) => {
      const row = await transactions.lock(tx, transactionId);
      await transactions.finalizeSuccess(tx, row, { actualProviderFee: 15, chargedAmount: 967, providerAccountId: await providerAccount(), attemptId: row.current_attempt_id, source: 'status_check' });
    });
    const alerts = await t.db.selectFrom('alert').selectAll().where('fingerprint', 'like', 'delivery_divergence:%').execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.detail).toMatchObject({ sent: 990, expected_delivery: 975, reported_delivery: 967, difference: -8 });
  });

  it('holds a provider\'s minimum to what the recipient receives, and names the smallest amount that clears it', async () => {
    // Ejara refuses payouts that would deliver under 500; our route minimum (100) is on the requested
    // amount. A 510 request delivers 497 after our 2.5 percent, so it must be refused at preview —
    // not confirmed, reserved and then failed a second later as PROVIDER_REJECTED.
    // Bindings are append-only, so the minimum arrives as a new route version, as it would in production.
    const route = await t.db.selectFrom('route').select('id').where('country_code', '=', 'CM').where('payment_method_code', '=', 'MOMO').where('direction', '=', 'disbursement').executeTakeFirstOrThrow();
    const admin = await t.admin();
    const pa = await providerAccount();
    const routes = new RouteService(t.db, t.app.get(AuditService));
    await t.db.transaction().execute((tx) => routes.openVersion(tx, route.id, {
      processing_fee_bps: 250, processing_fee_fixed: 0, processing_fee_floor: null, processing_fee_ceiling: null, platform_fee_bps: 0, platform_fee_fixed: 0, platform_fee_floor: null, platform_fee_ceiling: null,
      processing_fee_bearer: 'counterparty', platform_fee_bearer: 'counterparty', minimum_amount: 100, maximum_amount: 1_000_000,
      otp_required: false, browser_required: false, disbursement_fallback: false, active: true, accept_shortfall: false,
      bindings: [{ provider_account_id: pa, expected_fee_bps: 150, expected_fee_fixed: 0, terms_status: 'indicative', enabled: true, minimum_amount: 500, maximum_amount: null }],
      note: 'Provider payout minimum of 500 on what the recipient receives.',
    }, admin.id, { requireFeePermission: false, hasFeePermission: true }));
    await expect(previews.create(principal, { ...collection('677123456', 'min-1'), direction: 'disbursement', amount: 510 }))
      .rejects.toMatchObject({ code: 'AMOUNT_BELOW_MINIMUM', options: { details: { minimum: 513 } } });
    const ok = await previews.create(principal, { ...collection('677123456', 'min-2'), direction: 'disbursement', amount: 513 });
    expect(ok.settled_amount).toBe(500);
  });

  it('pays out through the next provider in the country when the first one\'s float cannot cover it', async () => {
    // Two providers on CM/MOMO payouts; the first, by priority, holds no float. The payout must go to
    // the second rather than be refused — the decision is made before anything is sent, so it cannot
    // pay twice, unlike fallback after submission.
    const admin = await t.admin();
    const first = await providerAccount();
    const second = (await t.db.insertInto('provider_account').values({ provider_code: 'simulator', name: 'Simulator (second)', base_url: 'simulator://second' }).returning('id').executeTakeFirstOrThrow()).id;
    const route = await t.db.selectFrom('route').select('id').where('country_code', '=', 'CM').where('payment_method_code', '=', 'MOMO').where('direction', '=', 'disbursement').executeTakeFirstOrThrow();
    const routes = new RouteService(t.db, t.app.get(AuditService));
    await t.db.transaction().execute((tx) => routes.openVersion(tx, route.id, {
      processing_fee_bps: 250, processing_fee_fixed: 0, processing_fee_floor: null, processing_fee_ceiling: null, platform_fee_bps: 0, platform_fee_fixed: 0, platform_fee_floor: null, platform_fee_ceiling: null,
      processing_fee_bearer: 'counterparty', platform_fee_bearer: 'counterparty', minimum_amount: 100, maximum_amount: 1_000_000,
      otp_required: false, browser_required: false, disbursement_fallback: false, active: true, accept_shortfall: false,
      bindings: [
        { provider_account_id: first, expected_fee_bps: 150, expected_fee_fixed: 0, terms_status: 'indicative', enabled: true, minimum_amount: null, maximum_amount: null },
        { provider_account_id: second, expected_fee_bps: 150, expected_fee_fixed: 0, terms_status: 'indicative', enabled: true, minimum_amount: null, maximum_amount: null },
      ],
      note: 'Two providers for payouts.',
    }, admin.id, { requireFeePermission: false, hasFeePermission: true }));
    const secondFloat = await ledger.getOrCreateAccount(t.db, { type: 'float', providerAccountId: second, countryCode: 'CM', currency: 'XAF', direction: 'disbursement' });
    await t.db.transaction().execute((tx) => ledger.postFloatFunding(tx, { floatAccountId: secondFloat, currency: 'XAF', amount: 100_000, authorId: admin.id, justification: 'capital' }));

    const p = await previews.create(principal, { ...collection('677123456', 'route-by-float'), direction: 'disbursement' });
    const { transactionId } = await transactions.confirm(principal, p.reference, 'disbursement');
    const txn = await t.db.selectFrom('transaction').select(['selected_provider_account_id', 'binding_id']).where('id', '=', transactionId).executeTakeFirstOrThrow();
    expect(txn.selected_provider_account_id).toBe(second);
  });

  it('still refuses a payout no provider in the country can cover', async () => {
    const p = await previews.create(principal, { ...collection('677123456', 'no-float'), direction: 'disbursement' });
    await expect(transactions.confirm(principal, p.reference, 'disbursement')).rejects.toMatchObject({ code: 'FLOAT_INSUFFICIENT' });
  });

  it('reserves, checks liquidity, settles per spec 6.1 and releases on failure', async () => {
    const admin = await t.admin();
    const pa = await providerAccount();
    const float = await ledger.getOrCreateAccount(t.db, { type: 'float', providerAccountId: pa, countryCode: 'CM', currency: 'XAF', direction: 'disbursement' });
    await t.db.transaction().execute((tx) => ledger.postFloatFunding(tx, { floatAccountId: float, currency: 'XAF', amount: 100_000, authorId: admin.id, justification: 'capital' }));
    const p = await previews.create(principal, { ...collection('677123456', 'wd-1'), direction: 'disbursement' });
    expect(p).toMatchObject({ charged_amount: 1000, settled_amount: 975 });
    const { transactionId } = await transactions.confirm(principal, p.reference, 'disbursement');
    expect(await ledger.projectBalances(t.db, project.id)).toEqual([{ currency: 'XAF', available: 49_000, reserved: 1000 }]);
    await submission.submit(transactionId);
    await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).execute();
    await status.sweep();
    expect((await reader.apiById(t.db, transactionId, { revealMsisdn: true, revealAction: true })).state).toBe('succeeded');
    expect(await ledger.projectBalances(t.db, project.id)).toEqual([{ currency: 'XAF', available: 49_000, reserved: 0 }]);
    expect(await ledger.balance(t.db, float)).toBe(100_000 - 975 - 20);
    // Failure path releases the reservation.
    const p2 = await previews.create(principal, { ...collection('677123401', 'wd-2'), direction: 'disbursement' });
    const r2 = await transactions.confirm(principal, p2.reference, 'disbursement');
    await submission.submit(r2.transactionId);
    await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).execute();
    await status.sweep();
    expect(await ledger.projectBalances(t.db, project.id)).toEqual([{ currency: 'XAF', available: 49_000, reserved: 0 }]);
  });

  it('refuses beyond the balance with the shortfall, and beyond float with no amounts', async () => {
    const p = await previews.create(principal, { ...collection('677123456', 'wd-3', 60_000), direction: 'disbursement' });
    await expect(transactions.confirm(principal, p.reference, 'disbursement')).rejects.toMatchObject({ code: 'BALANCE_INSUFFICIENT', options: { details: { shortfall: 10_000, currency: 'XAF' } } });
    const p2 = await previews.create(principal, { ...collection('677123456', 'wd-4', 5000), direction: 'disbursement' });
    const err = await transactions.confirm(principal, p2.reference, 'disbursement').catch((e) => e as PlatformError);
    expect(err).toMatchObject({ code: 'FLOAT_INSUFFICIENT' });
    expect((err as PlatformError).options.details).toBeUndefined();
    expect(await t.db.selectFrom('transaction').selectAll().execute()).toHaveLength(0);
    expect(await ledger.projectBalances(t.db, project.id)).toEqual([{ currency: 'XAF', available: 50_000, reserved: 0 }]);
    expect(await t.db.selectFrom('alert').select('title').where('category', '=', 'treasury').executeTakeFirst()).toBeTruthy();
  });

  it('holds the reservation in suspense when undetermined, and never jointly exceeds float under concurrency', async () => {
    const admin = await t.admin();
    const pa = await providerAccount();
    const float = await ledger.getOrCreateAccount(t.db, { type: 'float', providerAccountId: pa, countryCode: 'CM', currency: 'XAF', direction: 'disbursement' });
    await t.db.transaction().execute((tx) => ledger.postFloatFunding(tx, { floatAccountId: float, currency: 'XAF', amount: 3000, authorId: admin.id, justification: 'capital' }));
    const p = await previews.create(principal, { ...collection('677123404', 'wd-5'), direction: 'disbursement' });
    const { transactionId } = await transactions.confirm(principal, p.reference, 'disbursement');
    await submission.submit(transactionId);
    expect((await reader.apiById(t.db, transactionId, { revealMsisdn: true, revealAction: true })).state).toBe('undetermined');
    expect(await ledger.balanceByKey(t.db, { type: 'suspense', currency: 'XAF' })).toBe(1000);
    expect(await ledger.projectBalances(t.db, project.id)).toEqual([{ currency: 'XAF', available: 49_000, reserved: 0 }]);
    // Each disbursement reserves the settled 975 plus the expected provider fee of 15 (150 bps).
    // Free liquidity now 3000 − 990 = 2010: two more of 990 fit, a third does not.
    const ps = await Promise.all([1, 2, 3].map((i) => previews.create(principal, { ...collection(`67712300${i}`.replace(/0(\d)$/, '1$1'), `wd-c${i}`), direction: 'disbursement' })));
    const results = await Promise.allSettled(ps.map((pp) => transactions.confirm(principal, pp.reference, 'disbursement')));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const floatShort = results.filter((r) => r.status === 'rejected' && (r.reason as PlatformError).code === 'FLOAT_INSUFFICIENT').length;
    expect(ok).toBe(2);
    expect(floatShort).toBe(1);
    expect((await treasury.freeLiquidity(t.db, float)).free).toBe(3000 - 990 * 3);
  });
});
