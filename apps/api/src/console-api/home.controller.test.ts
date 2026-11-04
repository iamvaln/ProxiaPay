import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { Authorisation, type Grant } from '../admin-auth/authorisation.service';
import type { Permission } from '../permissions/permissions';
import type { ApprovalService } from './approval.service';
import type { ConfirmationService } from '../admin-auth/confirmation.service';
import { TreasuryService, type FloatAccountView } from '../treasury/treasury.service';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';
import type { ConsoleRequest } from './session.guard';

let t: TestContext;
let adminId: string;
let floats: Partial<FloatAccountView>[] = [];
let floatScope: string[] | null | undefined;
let pending: Record<string, unknown>[] = [];

const grant = (permission: Permission, scope: Partial<Grant> = {}): Grant => ({ permission, scopeType: 'all', projectIds: [], providerAccountIds: [], ...scope });
const requestOf = (...grants: Grant[]) => ({ principal: { administratorId: adminId }, auth: new Authorisation(adminId, grants) }) as unknown as ConsoleRequest;

function controller(): HomeController {
  const treasury = { floatAccounts: async (_db: unknown, scope: string[] | null) => { floatScope = scope; return floats; } } as unknown as TreasuryService;
  const approvals = { pending: async () => pending } as unknown as ApprovalService;
  return new HomeController(t.db, treasury, approvals, {} as ConfirmationService, new HomeService(t.db));
}
const home = async (...grants: Grant[]) => (await controller().home(requestOf(...grants))).cards as Record<string, unknown>;

beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  adminId = (await t.admin()).id;
  floats = [];
  pending = [];
  floatScope = undefined;
});

const removed = ['open_alerts', 'float_cover', 'coverage_ratio', 'open_discrepancies', 'todays_activity', 'provider_status'];

describe('GET /console/home', () => {
  it('serves the headline blocks to an administrator holding only oversight.reports', async () => {
    const cards = await home(grant('oversight.reports'));
    for (const key of ['success_rate', 'collected_today', 'undetermined', 'routes', 'earnings', 'awaiting_your_approval']) expect(cards).toHaveProperty(key);
    for (const key of ['verdict', 'lowest_float', 'assigned_discrepancies']) expect(cards).not.toHaveProperty(key);
    expect(cards.routes).toMatchObject({ scoped: false });
    expect(cards.earnings).toMatchObject({ period: 'month_to_date', scoped: false });
  });

  it('gives providers.read a verdict made of suspended accounts only', async () => {
    const pa = await t.db.selectFrom('provider_account').select(['id', 'name']).limit(1).executeTakeFirstOrThrow();
    await t.db.updateTable('provider_account').set({ status: 'suspended', suspended_at: new Date() }).where('id', '=', pa.id).execute();
    const cards = await home(grant('providers.read'));
    const problems = (cards.verdict as { problems: { kind: string; subject_reference: string }[] }).problems;
    expect(problems.map((p) => p.kind)).toEqual(['provider_suspended']);
    expect(problems[0]!.subject_reference).toBe(pa.id);
    expect(cards).not.toHaveProperty('success_rate');
  });

  it('has no verdict key without oversight.alerts.read or providers.read', async () => {
    const cards = await home(grant('oversight.reports'), grant('treasury.read_float'));
    expect(cards).not.toHaveProperty('verdict');
  });

  it('offers the verdict to oversight.alerts.read alone', async () => {
    expect((await home(grant('oversight.alerts.read')))).toHaveProperty('verdict');
  });

  it('picks the float view with the smallest cover, scoped by treasury.read_float', async () => {
    floats = [
      { id: 'a', providerAccountName: 'MTN', countryCode: 'CM', currency: 'XAF', direction: 'disbursement', coverHours: 30, band: 'watch', proposedTransfer: null },
      { id: 'b', providerAccountName: 'Orange', countryCode: 'CI', currency: 'XOF', direction: 'disbursement', coverHours: 4, band: 'critical', proposedTransfer: 90000 },
      { id: 'c', providerAccountName: 'Wave', countryCode: 'SN', currency: 'XOF', direction: 'collection', coverHours: null, band: 'healthy', proposedTransfer: null },
    ];
    const cards = await home(grant('treasury.read_float', { scopeType: 'provider_accounts', providerAccountIds: ['p1'] }));
    expect(floatScope).toEqual(['p1']);
    expect(cards.lowest_float).toEqual({ scoped: true, id: 'b', provider: 'Orange', country: 'CI', currency: 'XOF', direction: 'disbursement', cover_hours: 4, band: 'critical', proposed_transfer: 90000 });
  });

  it('marks the lowest float as limited by scope only when the grant is scoped', async () => {
    floats = [{ id: 'a', providerAccountName: 'MTN', countryCode: 'CM', currency: 'XAF', direction: 'disbursement', coverHours: 30, band: 'watch', proposedTransfer: null }];
    expect(((await home(grant('treasury.read_float'))).lowest_float as { scoped: boolean }).scoped).toBe(false);
  });

  it('gives a null lowest_float when no view has cover', async () => {
    floats = [{ id: 'c', providerAccountName: 'Wave', countryCode: 'SN', currency: 'XOF', direction: 'collection', coverHours: null, band: 'healthy', proposedTransfer: null }];
    expect((await home(grant('treasury.read_float'))).lowest_float).toBeNull();
  });

  it('lists discrepancies assigned to the caller under reconciliation.read', async () => {
    const cards = await home(grant('reconciliation.read'));
    expect(cards.assigned_discrepancies).toEqual([]);
  });

  it('lists only the approvals the caller can act on, with today\'s fields', async () => {
    pending = [
      { id: 'r1', type: 'x', summary: 's', amount: 5, currency_code: 'XAF', initiator_name: 'Ann', created_at: 'now', can_act: true, extra: 1 },
      { id: 'r2', type: 'x', summary: 's', amount: 5, currency_code: 'XAF', initiator_name: 'Bob', created_at: 'now', can_act: false },
    ];
    expect((await home()).awaiting_your_approval).toEqual([{ id: 'r1', type: 'x', summary: 's', amount: 5, currency: 'XAF', initiator: 'Ann', created_at: 'now' }]);
  });

  it('passes the project scope and the alerts flag to every figure', async () => {
    const calls: Record<string, unknown[]> = {};
    const spy = new HomeService(t.db);
    for (const name of ['overallSuccess', 'collectedToday', 'undetermined', 'routeSeries'] as const) {
      const original = spy[name].bind(spy) as (...a: unknown[]) => Promise<unknown>;
      (spy as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => { calls[name] = a; return original(...a); };
    }
    const c = new HomeController(t.db, {} as TreasuryService, { pending: async () => [] } as unknown as ApprovalService, {} as ConfirmationService, spy);
    const scoped = grant('oversight.reports', { scopeType: 'projects', projectIds: ['11111111-1111-1111-1111-111111111111'] });
    const cards = (await c.home(requestOf(scoped))).cards as { routes: { scoped: boolean } };
    expect(cards.routes.scoped).toBe(true);
    expect(calls.overallSuccess).toEqual([['11111111-1111-1111-1111-111111111111']]);
    expect(calls.collectedToday).toEqual([['11111111-1111-1111-1111-111111111111']]);
    expect(calls.undetermined).toEqual([['11111111-1111-1111-1111-111111111111']]);
    expect(calls.routeSeries).toEqual([['11111111-1111-1111-1111-111111111111'], false]);
    await c.home(requestOf(scoped, grant('oversight.alerts.read')));
    expect(calls.routeSeries).toEqual([['11111111-1111-1111-1111-111111111111'], true]);
  });

  it('never emits the removed keys', async () => {
    const cards = await home(...(['oversight.alerts.read', 'providers.read', 'treasury.read_float', 'reconciliation.read', 'oversight.reports'] as Permission[]).map((p) => grant(p)));
    for (const key of removed) expect(cards).not.toHaveProperty(key);
  });
});
