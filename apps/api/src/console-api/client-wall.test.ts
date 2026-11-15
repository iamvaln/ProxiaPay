import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformError } from '../common/errors';
import { Authorisation, type AuthorisationService, type Grant } from '../admin-auth/authorisation.service';
import type { AdminAuthService, SessionPrincipal } from '../admin-auth/admin-auth.service';
import type { ConfirmationService } from '../admin-auth/confirmation.service';
import { ALL_PERMISSIONS, type Permission } from '../permissions/permissions';
import type { TreasuryService } from '../treasury/treasury.service';
import { createTestContext, type TestContext } from '../test/context';
import { consoleRoutes, type ConsoleRoute as Route } from '../test/console-routes';
import { ApprovalService } from './approval.service';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';
import { SessionGuard, type ConsoleRequest } from './session.guard';
import { ClientAccessible } from './client-access';

/**
 * The handlers a client account may reach, as "METHOD path". The test walks every console handler
 * Nest registers: a handler missing from this list must answer a client NOT_FOUND, so adding one
 * without deciding here fails the test.
 */
const CLIENT_ACCESSIBLE_ROUTES = [
  'GET console/auth/me',
  'PATCH console/auth/preferences',
  'POST console/auth/password',
  'GET console/auth/sessions',
  'POST console/auth/confirmations',
  'POST console/auth/sign-out',
  'POST console/auth/second-factor',
  'POST console/auth/second-factor/enrol',
  'POST console/auth/active-client',
  'GET console/client/home',
  'GET console/transactions',
  'GET console/transactions/export',
  'GET console/search',
  'GET console/transactions/:reference',
  'GET console/previews',
  'GET console/projects',
  'POST console/projects',
  'GET console/projects/:id',
  'GET console/projects/:id/origin-refusals',
  'GET console/projects/:id/deliveries',
  'POST console/projects/:id/credentials',
  'POST console/projects/:id/credentials/:cid/promote',
  'DELETE console/projects/:id/credentials/:cid',
  'POST console/projects/:id/credentials/:cid/revoke',
  'POST console/projects/:id/origins',
  'GET console/projects/:id/brand',
  'PUT console/projects/:id/brand',
  'POST console/projects/:id/brand/logo',
  'GET console/projects/:id/payment-links',
  'GET console/projects/:id/payment-links/routes',
  'POST console/projects/:id/payment-links',
  'GET console/projects/:id/payment-links/:lid',
  'POST console/projects/:id/payment-links/:lid/disable',
  'DELETE console/projects/:id/origins/:oid',
  'PUT console/projects/:id/notification-endpoint',
  'POST console/projects/:id/notification-endpoint/regenerate-secret',
  'GET console/treasury/balances',
  'GET console/treasury/project/:projectId/accounts',
  'GET console/team',
  'POST console/team',
  'PUT console/team/:mid',
  'POST console/team/:mid/status',
  'POST console/team/:mid/resend',
  'POST console/auth/memberships/:mid/accept',
];

/** Handlers that run before any session exists, so SessionGuard (and the wall) never sees them. */
const UNGUARDED_ROUTES = ['GET console/auth/environment', 'POST console/auth/sign-in', 'GET console/invitations/:token', 'POST console/invitations/:token'];

const principalOf = (kind: 'platform' | 'client', secondFactorComplete = true): SessionPrincipal => ({
  sessionId: 's', administratorId: '00000000-0000-0000-0000-0000000000ad', name: 'Someone', email: 'someone@proxia.test', language: 'en', timezone: 'UTC',
  secondFactorComplete, kind, activeClientId: kind === 'client' ? '00000000-0000-0000-0000-0000000000c1' : null,
});

function guardFor(principal: SessionPrincipal, permissions: Permission[]) {
  const sessions = { resolveSession: async () => principal } as unknown as AdminAuthService;
  const grants = permissions.map((permission): Grant => ({ permission, scopeType: 'all', projectIds: [], providerAccountIds: [] }));
  const authorisation = { load: async () => new Authorisation(principal.administratorId, grants, principal.activeClientId, principal.kind === 'client') } as unknown as AuthorisationService;
  return new SessionGuard(new Reflector(), sessions, authorisation, { TRUSTED_PROXY_HOPS: 0 });
}

function contextFor(route: Route): ExecutionContext {
  const req = { method: route.key.split(' ')[0], headers: { cookie: 'pp_session=token', 'x-requested-with': 'ProxiaPay' }, socket: { remoteAddress: '127.0.0.1' } };
  return { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => route.handler, getClass: () => route.controller } as unknown as ExecutionContext;
}

async function outcome(guard: SessionGuard, route: Route): Promise<string> {
  try {
    return String(await guard.canActivate(contextFor(route)));
  } catch (e) {
    if (e instanceof PlatformError) return `${e.code}: ${e.message}`;
    throw e;
  }
}

describe('the client wall', () => {
  it('walks every console route and closes it to clients unless allowed', async () => {
    const routes = consoleRoutes();
    const keys = routes.map((r) => r.key);
    // A stale entry (a renamed or removed handler) fails here instead of silently allowing nothing.
    for (const allowed of [...CLIENT_ACCESSIBLE_ROUTES, ...UNGUARDED_ROUTES]) expect(keys).toContain(allowed);
    expect(routes.filter((r) => !r.guarded).map((r) => r.key).sort()).toEqual([...UNGUARDED_ROUTES].sort());

    const guarded = routes.filter((r) => r.guarded);
    expect(guarded.length).toBeGreaterThan(CLIENT_ACCESSIBLE_ROUTES.length);
    // Every permission, then none: the answer to a client on a closed handler does not depend on what it holds.
    for (const permissions of [ALL_PERMISSIONS as Permission[], []]) {
      const guard = guardFor(principalOf('client'), permissions);
      for (const route of guarded) {
        const result = await outcome(guard, route);
        if (CLIENT_ACCESSIBLE_ROUTES.includes(route.key)) expect(result, route.key).not.toBe('NOT_FOUND: No such resource.');
        else expect(result, route.key).toBe('NOT_FOUND: No such resource.');
      }
    }
  });

  it('refuses a client before the second factor too, without naming the second factor', async () => {
    const guard = guardFor(principalOf('client', false), ALL_PERMISSIONS as Permission[]);
    const closed = consoleRoutes().find((r) => r.key === 'GET console/approvals')!;
    expect(await outcome(guard, closed)).toBe('NOT_FOUND: No such resource.');
  });

  it('asks a client for the second factor on an open data handler, as it asks anyone', async () => {
    const guard = guardFor(principalOf('client', false), ALL_PERMISSIONS as Permission[]);
    const open = consoleRoutes().find((r) => r.key === 'GET console/transactions')!;
    expect(await outcome(guard, open)).toBe('SECOND_FACTOR_REQUIRED: Complete the second factor to continue.');
  });

  it('ignores @ClientAccessible on a controller: only a handler is opened', async () => {
    @ClientAccessible()
    class Marked { closed() { return 'reached'; } }
    const route = { key: 'GET console/marked', controller: Marked, handler: Marked.prototype.closed, guarded: true, clientAccessible: false } as unknown as Route;
    expect(await outcome(guardFor(principalOf('client'), ALL_PERMISSIONS as Permission[]), route)).toBe('NOT_FOUND: No such resource.');
    expect(await outcome(guardFor(principalOf('platform'), ALL_PERMISSIONS as Permission[]), route)).toBe('true');
  });

  it('lets platform staff through unchanged', async () => {
    const guarded = consoleRoutes().filter((r) => r.guarded);
    const all = guardFor(principalOf('platform'), ALL_PERMISSIONS as Permission[]);
    for (const route of guarded) expect(await outcome(all, route), route.key).toBe('true');
    const none = guardFor(principalOf('platform'), []);
    const configuration = guarded.find((r) => r.key === 'GET console/configuration/countries')!;
    expect(await outcome(none, configuration)).toMatch(/^PERMISSION_DENIED: /);
  });
});

describe('approval reach', () => {
  let t: TestContext;
  const ids: Record<'initiator' | 'cashoutApprover' | 'bystander', string> = { initiator: '', cashoutApprover: '', bystander: '' };
  let cashout: string;
  let roleChange: string;

  const controller = () => {
    const approvals = new ApprovalService(t.db, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    return new HomeController(t.db, {} as TreasuryService, approvals, {} as ConfirmationService, new HomeService(t.db));
  };
  const requestOf = (administratorId: string, ...permissions: Permission[]) =>
    ({ principal: { administratorId }, auth: new Authorisation(administratorId, permissions.map((permission) => ({ permission, scopeType: 'all', projectIds: [], providerAccountIds: [] })), null, false) }) as unknown as ConsoleRequest;
  const listed = async (req: ConsoleRequest) => (await controller().approvalQueue(req)).requests.map((r) => r.id).sort();
  const detail = async (id: string, req: ConsoleRequest) => {
    try {
      return (await controller().approval(id, req)).id;
    } catch (e) {
      if (e instanceof PlatformError) return e.code;
      throw e;
    }
  };

  beforeAll(async () => { t = await createTestContext(); });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    for (const k of Object.keys(ids) as (keyof typeof ids)[]) ids[k] = (await t.admin()).id;
    const insert = (type: string, initiated_by: string) => t.db.insertInto('approval_request').values({ type, subject: JSON.stringify({}), summary: type, initiated_by, justification: 'test' }).returning('id').executeTakeFirstOrThrow();
    cashout = (await insert('cashout', ids.initiator)).id;
    roleChange = (await insert('role_change', ids.initiator)).id;
  });

  it('hides approval requests the caller can neither decide nor initiated', async () => {
    const approver = requestOf(ids.cashoutApprover, 'treasury.cashout.approve', 'transactions.read');
    const bystander = requestOf(ids.bystander, 'transactions.read');
    const initiator = requestOf(ids.initiator);

    expect(await listed(approver)).toEqual([cashout]);
    expect(await listed(bystander)).toEqual([]);
    expect(await listed(initiator)).toEqual([cashout, roleChange].sort());

    expect(await detail(cashout, approver)).toBe(cashout);
    expect(await detail(roleChange, approver)).toBe('NOT_FOUND');
    expect(await detail(cashout, bystander)).toBe('NOT_FOUND');
    expect(await detail(roleChange, initiator)).toBe(roleChange);
  });

  it('keeps a decided request visible to whoever could decide it', async () => {
    await t.db.updateTable('approval_request').set({ status: 'declined', decided_by: ids.cashoutApprover, decision_reason: 'no' }).where('id', '=', cashout).execute();
    expect(await detail(cashout, requestOf(ids.cashoutApprover, 'treasury.cashout.approve'))).toBe(cashout);
    expect(await detail(cashout, requestOf(ids.bystander))).toBe('NOT_FOUND');
  });
});
