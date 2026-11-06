import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { consoleRoutes } from '../test/console-routes';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { Authorisation, AuthorisationService } from '../admin-auth/authorisation.service';
import type { ConfirmationService } from '../admin-auth/confirmation.service';
import { AlertService } from '../alerts/alert.service';
import { Mailer } from '../alerts/mailer';
import { AuditService } from '../audit/audit.service';
import { CONFIG, type AppConfig } from '../config/config';
import { CryptoService } from '../crypto/crypto.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notifications/notification.service';
import { ALL_PERMISSIONS, type Permission } from '../permissions/permissions';
import { CredentialService } from '../project-auth/credential.service';
import { ProjectAuthService } from '../project-auth/project-auth.service';
import { SimulatorAdapter } from '../providers/adapters/simulator.adapter';
import { StatusService } from '../providers/status.service';
import { SubmissionService } from '../providers/submission.service';
import { SettingsService } from '../settings/settings.service';
import { TreasuryService } from '../treasury/treasury.service';
import { PreviewService } from '../transactions/preview.service';
import { TransactionReader } from '../transactions/transaction-reader';
import { TransactionService } from '../transactions/transaction.service';
import { ConsoleAuthController } from './auth.controller';
import { EntitlementService } from './entitlement.service';
import { ExportService } from './export.service';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';
import { ConsoleProjectsController } from './projects.controller';
import type { ConsoleRequest } from './session.guard';
import { ConsoleTransactionsController } from './transactions.controller';
import { TreasuryController } from './treasury.controller';
import { TeamController } from './team.controller';
import { InvitationService } from '../clients/invitation.service';

let t: TestContext;
const get = <T>(token: new (...a: never[]) => T) => t.app.get(token as never) as T;
const nul = null as never;
const controllers = {
  transactions: () => new ConsoleTransactionsController(t.db, get(TransactionReader), get(TransactionService), get(LedgerService), get(NotificationService), get(CryptoService), get(AuditService), new ExportService(t.db, t.app.get(CONFIG))),
  projects: () => new ConsoleProjectsController(t.db, get(LedgerService), get(CredentialService), get(NotificationService), nul, new EntitlementService(t.db, get(AuditService)), get(AuditService), nul),
  treasury: () => new TreasuryController(t.db, get(LedgerService), get(TreasuryService), nul, nul, nul, nul, nul),
  home: () => new HomeController(t.db, get(TreasuryService), nul, {} as ConfirmationService, new HomeService(t.db)),
  auth: () => new ConsoleAuthController(t.db, t.app.get<AppConfig>(CONFIG), get(AdminAuthService), get(SettingsService), nul),
  team: () => new TeamController(t.db, new InvitationService(t.db, t.app.get(CONFIG), get(Mailer), get(AlertService), get(AuditService))),
};

beforeAll(async () => {
  t = await createTestContext();
  SimulatorAdapter.settleAfterMs = 0;
});
afterAll(() => t.close());
beforeEach(() => t.reset());

/** The internals of the brief: a client response carries none of these, at any depth. */
const FORBIDDEN = ['provider_account', 'actual_provider_fee', 'margin', 'expected_fee_bps', 'terms', 'route_version', 'entitlement_version', 'postings', 'account_id', 'created_by', 'note'];
/** And the platform's other names for the same internals, as the platform responses spell them. */
const ALSO_FORBIDDEN = ['provider_account_id', 'provider_account_name', 'provider_reference', 'expected_provider_fee', 'binding_snapshot', 'terms_snapshot', 'limits_snapshot', 'platform_revenue',
  'coverage', 'ledger_entries', 'configuration', 'issued_by', 'revoked_by', 'deleted_by', 'author', 'actor', 'history', 'route_processing_fee_bps', 'route_platform_fee_bps'];

/** Every key of a response, at any depth, as it would be serialised. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, inner] of Object.entries(v)) { into.add(k); walk(inner); }
  };
  walk(JSON.parse(JSON.stringify(value)));
  return into;
}
const leaks = (value: unknown, forbidden = [...FORBIDDEN, ...ALSO_FORBIDDEN]) => [...keysOf(value)].filter((k) => forbidden.includes(k));

async function newClient(name: string) {
  return t.db.insertInto('client').values({ name }).returning('id').executeTakeFirstOrThrow();
}
/** A client account holding the owner role (every client permission) through an active membership. */
async function clientOwner(...clientIds: string[]) {
  const a = await t.admin();
  await t.db.deleteFrom('role_assignment').where('administrator_id', '=', a.id).execute();
  await t.db.updateTable('administrator').set({ kind: 'client' }).where('id', '=', a.id).execute();
  const role = await t.db.selectFrom('role').select('id').where('name', '=', 'Client owner').executeTakeFirstOrThrow();
  for (const clientId of clientIds) {
    const m = await t.db.insertInto('client_membership').values({ administrator_id: a.id, client_id: clientId, status: 'active' }).returning('id').executeTakeFirstOrThrow();
    await t.db.insertInto('role_assignment').values({ administrator_id: a.id, role_id: role.id, scope_type: 'client', membership_id: m.id }).execute();
  }
  return a;
}
/** A request as the session guard builds it for a client account working in `activeClientId`. */
async function clientRequest(admin: { id: string; email: string }, activeClientId: string, auth?: Authorisation): Promise<ConsoleRequest> {
  return {
    principal: { sessionId: '00000000-0000-0000-0000-00000000005e', administratorId: admin.id, name: 'Test Admin', email: admin.email, language: 'en', timezone: 'UTC', secondFactorComplete: true, kind: 'client', activeClientId },
    auth: auth ?? await new AuthorisationService(t.db).load(admin.id, activeClientId),
    clientAddress: '127.0.0.1', clientDescription: 'vitest',
  } as unknown as ConsoleRequest;
}

/** A project of `clientId`, granted every route by a platform administrator (`created_by` and notes set), with a notification endpoint. */
async function clientProject(code: string, clientId: string) {
  const project = await t.project(code, { fundXaf: 50_000 });
  await t.db.updateTable('project').set({ client_id: clientId }).where('id', '=', project.id).execute();
  await get(NotificationService).setEndpoint(t.db, project.id, 'http://127.0.0.1:1/hook', project.adminId);
  return project;
}

const momo = async () => t.db.selectFrom('route as r').innerJoin('route_version as rv', (j) => j.onRef('rv.route_id', '=', 'r.id').on('rv.valid_to', 'is', null))
  .selectAll('rv').select('r.id as route').where('r.country_code', '=', 'CM').where('r.payment_method_code', '=', 'MOMO').where('r.direction', '=', 'collection').where('r.currency_code', '=', 'XAF').executeTakeFirstOrThrow();

/** Amends the CM MOMO collection grant with the project's own fees and narrower limits, and an internal note. */
async function override(projectId: string, adminId: string) {
  const rv = await momo();
  const terms = {
    route_id: rv.route, minimum_amount: rv.minimum_amount + 50, maximum_amount: rv.maximum_amount - 1, count_24h: 7, value_24h: 70_000, count_30d: 70, value_30d: 700_000,
    processing_fee_bps: 300, processing_fee_fixed: 0, platform_fee_bps: 50, platform_fee_fixed: 0, processing_fee_bearer: 'counterparty' as const, platform_fee_bearer: 'project' as const,
    note: 'Internal: negotiated against the provider cost', accept_shortfall: true,
  };
  await new EntitlementService(t.db, get(AuditService)).grantOrAmend(projectId, terms, adminId);
  return { rv, terms };
}

/** Drives one collection to success through the simulator: an attempt, ledger postings and a notification delivery attempt. */
async function succeededCollection(project: { id: string; key: string; secret: string }, reference: string, amount = 1000) {
  const auth = get(ProjectAuthService);
  const principal = await auth.resolveToken((await auth.exchange(project.key, project.secret, '10.0.0.1')).access_token, '10.0.0.1');
  const p = await get(PreviewService).create(principal, { direction: 'collection', amount, currency: 'XAF', country: 'CM', payment_method: 'MOMO', counterparty: { msisdn: '+237677123456', name: 'A. Mbarga' }, reference });
  const { transactionId } = await get(TransactionService).confirm(principal, p.reference, 'collection');
  await get(SubmissionService).submit(transactionId);
  await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).where('id', '=', transactionId).execute();
  await get(StatusService).sweep();
  await t.drain();
  const txn = await t.db.selectFrom('transaction').select(['reference', 'state']).where('id', '=', transactionId).executeTakeFirstOrThrow();
  expect(txn.state).toBe('succeeded');
  return { id: transactionId, reference: txn.reference, previewReference: p.reference };
}

describe('client views', () => {
  it('client transaction detail carries none of the platform internals', async () => {
    const acme = await newClient('Acme');
    const owner = await clientOwner(acme.id);
    const project = await clientProject('acme-shop', acme.id);
    await override(project.id, project.adminId);
    const txn = await succeededCollection(project, 'order-1');

    const platform = await controllers.transactions().detail(txn.reference, await clientRequest(owner, acme.id, new Authorisation(owner.id, ALL_PERMISSIONS.map((permission) => ({ permission: permission as Permission, scopeType: 'all', projectIds: [], providerAccountIds: [] })), null, false)));
    // The platform shape does carry them: the test would pass vacuously otherwise.
    expect(leaks(platform, FORBIDDEN).sort()).toEqual([...FORBIDDEN].sort());

    const detail = await controllers.transactions().detail(txn.reference, await clientRequest(owner, acme.id));
    const json = JSON.stringify(detail);
    for (const key of FORBIDDEN) expect(json, key).not.toContain(`"${key}"`);
    expect(leaks(detail)).toEqual([]);
    expect(detail).toMatchObject({
      reference: txn.reference, project_reference: 'order-1', project: { id: project.id, code: 'acme-shop', name: 'acme-shop' }, direction: 'collection', state: 'succeeded',
      country: 'CM', payment_method: 'MOMO', currency: 'XAF', requested_amount: 1000, processing_fee: 30, platform_fee: 5, processing_fee_bearer: 'counterparty', platform_fee_bearer: 'project',
      msisdn_masked: expect.stringMatching(/^\+237.*456$/), failure_reason: null,
    });
    expect(typeof (detail as { payment_method_name: string }).payment_method_name).toBe('string');
    expect(Object.keys((detail as { attempts: object[] }).attempts[0]!).sort()).toEqual(['ended_at', 'failure_reason', 'operator_reference', 'started_at', 'state']);
    expect((detail as { notifications: object[] }).notifications).toEqual([{ event_type: 'transaction.succeeded', status: 'pending', attempts: 1, last_attempt_at: expect.any(Date) }]);
  });

  it('client project routes show the client\'s own fees and limits, not the route base when overridden', async () => {
    const acme = await newClient('Acme');
    const owner = await clientOwner(acme.id);
    const project = await clientProject('acme-shop', acme.id);
    const { rv, terms } = await override(project.id, project.adminId);
    // The override differs from the base on every figure, so a base value showing through would be seen.
    expect(rv.processing_fee_bps).not.toBe(terms.processing_fee_bps);
    expect(rv.platform_fee_bps).not.toBe(terms.platform_fee_bps);
    expect(rv.platform_fee_bearer).not.toBe(terms.platform_fee_bearer);

    const detail = await controllers.projects().detail(project.id, await clientRequest(owner, acme.id));
    const routes = (detail as unknown as { routes: Record<string, unknown>[] }).routes;
    const overridden = routes.find((r) => r.country === 'CM' && r.payment_method === 'MOMO' && r.direction === 'collection' && r.currency === 'XAF')!;
    expect(overridden).toEqual({
      country: 'CM', payment_method: 'MOMO', payment_method_name: expect.any(String), direction: 'collection', currency: 'XAF', active: true,
      fees: { processing_bps: 300, processing_fixed: 0, processing_bearer: 'counterparty', platform_bps: 50, platform_fixed: 0, platform_bearer: 'project' },
      limits: { minimum_amount: terms.minimum_amount, maximum_amount: terms.maximum_amount, count_24h: 7, value_24h: 70_000, count_30d: 70, value_30d: 700_000 },
    });
    // A grant without overrides inherits the route's terms: what the client is charged there.
    const inherited = routes.find((r) => r !== overridden)!;
    const base = await t.db.selectFrom('route as r').innerJoin('route_version as v', (j) => j.onRef('v.route_id', '=', 'r.id').on('v.valid_to', 'is', null)).selectAll('v')
      .where('r.country_code', '=', inherited.country as string).where('r.payment_method_code', '=', inherited.payment_method as string).where('r.direction', '=', inherited.direction as string).where('r.currency_code', '=', inherited.currency as string).executeTakeFirstOrThrow();
    expect(inherited.fees).toEqual({ processing_bps: base.processing_fee_bps, processing_fixed: base.processing_fee_fixed, processing_bearer: base.processing_fee_bearer, platform_bps: base.platform_fee_bps, platform_fixed: base.platform_fee_fixed, platform_bearer: base.platform_fee_bearer });
    expect(detail).toMatchObject({ waiting_for_routes: false, project: { id: project.id, code: 'acme-shop', name: 'acme-shop', status: 'active' }, notification_endpoint: { url: 'http://127.0.0.1:1/hook' } });
    expect(leaks(detail)).toEqual([]);

    // A project with no open grant is waiting for ProxiaPay.
    const bare = await t.db.insertInto('project').values({ code: 'acme-bare', name: 'Bare', client_id: acme.id }).returning('id').executeTakeFirstOrThrow();
    expect(await controllers.projects().detail(bare.id, await clientRequest(owner, acme.id))).toMatchObject({ routes: [], waiting_for_routes: true, notification_endpoint: null });
  });

  it('client home counts only the active client\'s projects', async () => {
    const acme = await newClient('Acme');
    const other = await newClient('Other');
    // A member of both teams, working in Acme: Other's figures are not Acme's, whatever else the person can reach.
    const owner = await clientOwner(acme.id, other.id);
    const mine = await clientProject('acme-shop', acme.id);
    const theirs = await clientProject('other-shop', other.id);
    const platform = await t.project('platform-shop', { fundXaf: 50_000 });
    await succeededCollection(mine, 'a-1', 1000);
    await succeededCollection(theirs, 'o-1', 2000);
    await succeededCollection(platform, 'p-1', 4000);
    const stuck = await succeededCollection(theirs, 'o-2', 3000);
    await t.db.updateTable('transaction').set({ state: 'undetermined' }).where('id', '=', stuck.id).execute();

    const home = await controllers.home().clientHome(await clientRequest(owner, acme.id));
    expect(home).toEqual({ collected_today: [{ currency: 'XAF', today: 1000, last_week: null }], success_rate: { current: 1, baseline: null, sample: 1 }, undetermined: 0 });
    const there = await controllers.home().clientHome(await clientRequest(owner, other.id));
    expect(there).toMatchObject({ collected_today: [{ currency: 'XAF', today: 2000 }], undetermined: 1 });
  });

  it('no client-accessible read carries ProxiaPay\'s economics', async () => {
    const acme = await newClient('Acme');
    const owner = await clientOwner(acme.id);
    const project = await clientProject('acme-shop', acme.id);
    await override(project.id, project.adminId);
    const txn = await succeededCollection(project, 'order-1');
    await t.db.insertInto('project_origin').values({ project_id: project.id, cidr: '10.0.0.0/8', description: 'office', created_by: project.adminId }).execute();
    await t.db.insertInto('origin_refusal').values({ project_id: project.id, credential_key: project.key, origin_address: '192.168.1.1' }).execute();

    const ownerAuth = await new AuthorisationService(t.db).load(owner.id, acme.id);
    // Shaping does not rest on what the client holds: a client principal with every permission gets the client shapes too.
    const everything = new Authorisation(owner.id, ALL_PERMISSIONS.map((permission) => ({ permission: permission as Permission, scopeType: 'projects', projectIds: [project.id], providerAccountIds: [] })), acme.id, true);
    for (const auth of [ownerAuth, everything]) {
      const req = await clientRequest(owner, acme.id, auth);
      const calls: Record<string, () => Promise<unknown>> = {
        'GET console/auth/me': () => controllers.auth().me(req),
        'GET console/auth/sessions': () => controllers.auth().sessions(req),
        'GET console/client/home': () => controllers.home().clientHome(req),
        'GET console/transactions': () => controllers.transactions().search({}, req),
        'GET console/transactions/export': () => controllers.transactions().export({}, req),
        'GET console/search': () => controllers.transactions().globalSearch(txn.reference.slice(0, 10), req),
        'GET console/transactions/:reference': () => controllers.transactions().detail(txn.reference, req),
        'GET console/previews': () => controllers.transactions().previews({}, req),
        'GET console/projects': () => controllers.projects().list(req),
        'GET console/projects/:id': () => controllers.projects().detail(project.id, req),
        'GET console/projects/:id/origin-refusals': () => controllers.projects().originRefusals(project.id, {}, req),
        'GET console/projects/:id/deliveries': () => controllers.projects().deliveries(project.id, {}, req),
        'GET console/treasury/balances': () => controllers.treasury().balances(req),
        'GET console/treasury/project/:projectId/accounts': () => controllers.treasury().projectAccounts(project.id, req),
        'GET console/team': () => controllers.team().list(req),
      };
      // Every client-accessible read is called here: opening a new one to clients without adding it fails.
      expect(Object.keys(calls).sort()).toEqual(consoleRoutes().filter((r) => r.clientAccessible && r.key.startsWith('GET ')).map((r) => r.key).sort());

      for (const [key, call] of Object.entries(calls)) {
        const res = await call();
        expect(leaks(res), key).toEqual([]);
        // Not vacuous: each list holds the seeded rows.
        expect(JSON.stringify(res).length, key).toBeGreaterThan(20);
      }
      const csv = ((await calls['GET console/transactions/export']!()) as { csv: string }).csv;
      const [header, row] = csv.split('\n').filter((l) => l && !l.startsWith('# '));
      expect(row, 'export holds the transaction').toContain(txn.reference);
      expect(header!.split(',').filter((c) => [...FORBIDDEN, ...ALSO_FORBIDDEN].includes(c))).toEqual([]);
      const list = (await calls['GET console/transactions']!()) as { data: unknown[] };
      expect(list.data).toHaveLength(1);
      const detail = (await calls['GET console/transactions/:reference']!()) as { attempts: unknown[]; notifications: unknown[] };
      expect(detail.attempts.length).toBeGreaterThan(0);
      expect(detail.notifications.length).toBeGreaterThan(0);
    }
  });
});
