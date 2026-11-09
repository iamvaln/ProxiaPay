import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { createTestContext, type TestContext } from '../test/context';
import { Authorisation, type Grant } from '../admin-auth/authorisation.service';
import type { Permission } from '../permissions/permissions';
import type { ConsoleRequest } from './session.guard';
import type { ConfirmationService } from '../admin-auth/confirmation.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notifications/notification.service';
import { addressResolver } from '../notifications/public-address';
import { CredentialService } from '../project-auth/credential.service';
import { ProjectAuthService } from '../project-auth/project-auth.service';
import { PreviewService } from '../transactions/preview.service';
import { TransactionService } from '../transactions/transaction.service';
import { TransactionReader } from '../transactions/transaction-reader';
import { CryptoService } from '../crypto/crypto.service';
import { PlatformExceptionFilter } from '../http/exception.filter';
import { ConsoleProjectsController } from './projects.controller';
import { ConsoleTransactionsController } from './transactions.controller';
import { EntitlementService } from './entitlement.service';

let t: TestContext;
let projects: ConsoleProjectsController;
let transactions: ConsoleTransactionsController;
let adminId: string;

const grant = (permission: Permission, projectIds: string[]): Grant => ({ permission, scopeType: 'projects', projectIds, providerAccountIds: [] });
const requestOf = (...grants: Grant[]) => ({ principal: { administratorId: adminId }, auth: new Authorisation(adminId, grants, null, false) }) as unknown as ConsoleRequest;
const confirmation = { id: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', code: '123456' };
// The code check is not under test here; the stub consumes any code.
const confirmations = { consume: async () => undefined, recordFailedAttempt: async () => undefined } as unknown as ConfirmationService;

beforeAll(async () => {
  t = await createTestContext();
  const get = <T>(token: new (...a: never[]) => T) => t.app.get(token as never) as T;
  projects = new ConsoleProjectsController(t.db, get(LedgerService), get(CredentialService), get(NotificationService), confirmations, new EntitlementService(t.db, get(AuditService)), get(AuditService), null as never);
  transactions = new ConsoleTransactionsController(t.db, get(TransactionReader), get(TransactionService), get(LedgerService), get(NotificationService), get(CryptoService), get(AuditService), null as never);
});
afterAll(() => t.close());
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await t.reset();
  adminId = (await t.admin()).id;
});

const credentialOf = async (projectId: string) => t.db.selectFrom('project_credential').select(['id', 'status']).where('project_id', '=', projectId).executeTakeFirstOrThrow();

describe('project sub-resources check their own permission', () => {
  it('a developer scoped to project A issues a credential on A without projects.manage', async () => {
    const a = await t.project('proj-a');
    const issued = await projects.issue(a.id, { scopes: ['read'], confirmation }, requestOf(grant('projects.credentials', [a.id])));
    expect(issued).toBeTruthy();
    expect(await t.db.selectFrom('project_credential').select('id').where('project_id', '=', a.id).execute()).toHaveLength(2);
  });

  it('keeps each sub-resource to its own permission and scope', async () => {
    const a = await t.project('proj-a');
    const b = await t.project('proj-b');
    const onlyCredentialsOnA = requestOf(grant('projects.credentials', [a.id]));
    await expect(projects.addOrigin(a.id, { cidr: '10.0.0.0/8' }, requestOf(grant('projects.credentials', [a.id])))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(projects.issue(b.id, { scopes: ['read'], confirmation }, onlyCredentialsOnA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await projects.addOrigin(a.id, { cidr: '10.0.0.0/8' }, requestOf(grant('projects.origins', [a.id])))).toMatchObject({ cidr: '10.0.0.0/8' });
    const endpoint = await projects.setEndpoint(a.id, { url: 'https://hooks.example.com/pp' }, requestOf(grant('projects.notifications', [a.id])));
    expect(endpoint.url).toBe('https://hooks.example.com/pp');
    await expect(projects.setEndpoint(a.id, { url: 'https://hooks.example.com/pp' }, onlyCredentialsOnA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the notification address', () => {
  const refusal = { code: 'FIELD_INVALID', message: 'That address is not reachable from the internet.', options: { field: 'url' } };

  it.each(['http://127.0.0.1:8080/hook', 'https://169.254.169.254/latest', 'https://10.0.0.5/hook', 'https://100.64.1.1/', 'https://[fd12::1]/', 'https://localhost/hook', 'https://intranet/hook', 'https://vault.internal/hook', 'https://nas.local/hook', 'https://198.18.0.1/', 'https://224.0.0.1/', 'https://255.255.255.255/', 'https://[ff02::1]/', 'https://[64:ff9b::a00:1]/', 'https://[2002:a00:1::]/', 'https://[::ffff:10.0.0.1]/'])('is refused when it points inside a network, to platform staff as well: %s', async (url) => {
    const a = await t.project('proj-a');
    await expect(projects.setEndpoint(a.id, { url }, requestOf(grant('projects.notifications', [a.id])))).rejects.toMatchObject(refusal);
    expect(await t.db.selectFrom('project_notification_endpoint').select('id').where('project_id', '=', a.id).execute()).toEqual([]);
  });

  it('is refused when its name does not resolve', async () => {
    const a = await t.project('proj-a');
    vi.spyOn(addressResolver, 'lookup').mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    await expect(projects.setEndpoint(a.id, { url: 'https://hooks.example.com/pp' }, requestOf(grant('projects.notifications', [a.id])))).rejects.toMatchObject(refusal);
  });

  it('is refused when its name resolves to an internal address', async () => {
    const a = await t.project('proj-a');
    vi.spyOn(addressResolver, 'lookup').mockResolvedValue(['93.184.215.14', '192.168.0.10']);
    await expect(projects.setEndpoint(a.id, { url: 'https://hooks.example.com/pp' }, requestOf(grant('projects.notifications', [a.id])))).rejects.toMatchObject(refusal);
  });
});

describe('child ids are bound to the project in the URL', () => {
  it('refuses to revoke project B\'s credential through project A\'s URL', async () => {
    const a = await t.project('proj-a');
    const b = await t.project('proj-b');
    const cred = await credentialOf(b.id);
    const req = requestOf(grant('projects.credentials', [a.id]));
    await expect(projects.revoke(a.id, cred.id, { confirmation }, req)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'No such credential.' });
    await expect(projects.promote(a.id, cred.id, { confirmation }, req)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'No such credential.' });
    await expect(projects.remove(a.id, cred.id, { confirmation }, req)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'No such credential.' });
    expect((await credentialOf(b.id)).status).toBe('active');
  });

  it('still revokes a credential of the project itself', async () => {
    const a = await t.project('proj-a');
    const cred = await credentialOf(a.id);
    await projects.revoke(a.id, cred.id, { confirmation }, requestOf(grant('projects.credentials', [a.id])));
    expect((await credentialOf(a.id)).status).toBe('revoked');
  });

  it('refuses to remove project B\'s origin through project A\'s URL', async () => {
    const a = await t.project('proj-a');
    const b = await t.project('proj-b');
    const origin = await projects.addOrigin(b.id, { cidr: '10.0.0.0/8' }, requestOf(grant('projects.origins', [b.id])));
    await expect(projects.removeOrigin(a.id, origin.id, requestOf(grant('projects.origins', [a.id])))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses in-flight and deactivate for project B\'s entitlement through project A\'s URL', async () => {
    const a = await t.project('proj-a');
    const b = await t.project('proj-b');
    const ent = await t.db.selectFrom('entitlement').select('id').where('project_id', '=', b.id).limit(1).executeTakeFirstOrThrow();
    const req = requestOf(grant('projects.read', [a.id]), grant('projects.entitlements', [a.id]));
    await expect(projects.inFlight(a.id, ent.id, req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(projects.deactivate(a.id, ent.id, { note: 'x' }, req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await t.db.selectFrom('entitlement_version').select('id').where('entitlement_id', '=', ent.id).where('valid_to', 'is', null).where('active', '=', true).execute()).toHaveLength(1);
    // Its own entitlement still deactivates.
    const own = await t.db.selectFrom('entitlement').select('id').where('project_id', '=', a.id).limit(1).executeTakeFirstOrThrow();
    await expect(projects.deactivate(a.id, own.id, { note: 'x' }, req)).resolves.toEqual({ ok: true });
  });
});

describe('transactions recheck and replay reach the transaction\'s project', () => {
  async function seed(code: string) {
    const project = await t.project(code);
    const auth = t.app.get(ProjectAuthService);
    const principal = await auth.resolveToken((await auth.exchange(project.key, project.secret, '10.0.0.1')).access_token, '10.0.0.1');
    const p = await t.app.get(PreviewService).create(principal, { direction: 'collection', amount: 1000, currency: 'XAF', country: 'CM', payment_method: 'MOMO', counterparty: { msisdn: '+237670000001' }, reference: `${code}-1` });
    const { transactionId } = await t.app.get(TransactionService).confirm(principal, p.reference, 'collection');
    const txn = await t.db.selectFrom('transaction').select(['id', 'reference']).where('id', '=', transactionId).executeTakeFirstOrThrow();
    const endpoint = await t.db.insertInto('project_notification_endpoint').values({ project_id: project.id, url: 'https://hooks.example.com/pp', signing_secret_ciphertext: Buffer.alloc(0) }).returning('id').executeTakeFirstOrThrow();
    const delivery = await t.db.insertInto('notification_delivery').values({ event_id: `evt-${code}`, transaction_id: txn.id, endpoint_id: endpoint.id, event_type: 'transaction.succeeded', payload: JSON.stringify({}) }).returning('id').executeTakeFirstOrThrow();
    return { project, reference: txn.reference, deliveryId: delivery.id };
  }

  it('refuses to recheck a transaction outside the scope', async () => {
    const a = await seed('proj-a');
    const b = await seed('proj-b');
    const req = requestOf(grant('transactions.recheck', [a.project.id]));
    await expect(transactions.recheck(b.reference, req)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'No such transaction.' });
    await expect(transactions.recheck(a.reference, req)).resolves.toEqual({ queued: true });
  });

  it('refuses to replay a delivery of another project', async () => {
    const a = await seed('proj-a');
    const b = await seed('proj-b');
    const req = requestOf(grant('transactions.replay_notification', [a.project.id]));
    // B's delivery through B's own reference: outside the scope.
    await expect(transactions.replay(b.reference, b.deliveryId, req)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // B's delivery through A's reference: the delivery is not that transaction's.
    await expect(transactions.replay(a.reference, b.deliveryId, req)).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'No such delivery.' });
    expect(await t.db.selectFrom('notification_delivery').select('id').execute()).toHaveLength(2);
    await expect(transactions.replay(a.reference, a.deliveryId, req)).resolves.toHaveProperty('delivery_id');
  });
});

describe('the closed-handler answer', () => {
  it('is byte-identical to the answer for a route that does not exist', async () => {
    const answer = async (exception: unknown) => {
      let status = 0;
      let body: unknown;
      const res = { setHeader: () => undefined, status: (s: number) => { status = s; return { json: (b: unknown) => { body = b; } }; } };
      new PlatformExceptionFilter().catch(exception, { switchToHttp: () => ({ getResponse: () => res }) } as never);
      return JSON.stringify({ status, body });
    };
    const { PlatformError } = await import('../common/errors');
    expect(await answer(new PlatformError('NOT_FOUND', 'No such resource.'))).toBe(await answer(new NotFoundException()));
  });
});
