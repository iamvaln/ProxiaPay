import { Authorisation, type Grant } from '../admin-auth/authorisation.service';
import type { ConsoleRequest } from '../console-api/session.guard';
import { ALL_PERMISSIONS, type Permission } from '../permissions/permissions';
import type { TestContext } from './context';

/**
 * A ConsoleRequest for calling controller methods directly. `auth` is the production Authorisation class, so
 * require() and projectScope() behave as they do behind the session guard. By default: every permission, no
 * project scope. `scope` limits transactions.read to those projects (an empty list reaches none).
 */
export function consoleRequest(_ctx: TestContext, opts: { permissions?: string[]; scope?: string[] | null } = {}): ConsoleRequest {
  const administratorId = '00000000-0000-0000-0000-0000000000ad';
  const grants: Grant[] = ((opts.permissions ?? ALL_PERMISSIONS) as Permission[]).map((permission) =>
    permission === 'transactions.read' && opts.scope
      ? { permission, scopeType: 'projects', projectIds: opts.scope, providerAccountIds: [] }
      : { permission, scopeType: 'all', projectIds: [], providerAccountIds: [] });
  return {
    principal: { sessionId: 'test-session', administratorId, name: 'Test Admin', email: 'admin@proxia.test', language: 'en', timezone: 'UTC', secondFactorComplete: true },
    auth: new Authorisation(administratorId, grants),
    clientAddress: '127.0.0.1',
    clientDescription: 'vitest',
  } as unknown as ConsoleRequest;
}
