import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { consoleRequest } from '../test/console-request';
import { ProjectAuthService } from '../project-auth/project-auth.service';
import { PreviewService } from '../transactions/preview.service';
import { TransactionService } from '../transactions/transaction.service';
import { TransactionReader } from '../transactions/transaction-reader';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notifications/notification.service';
import { CryptoService } from '../crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import { ConsoleTransactionsController } from './transactions.controller';

let t: TestContext;
let controller: ConsoleTransactionsController;

beforeAll(async () => {
  t = await createTestContext();
  // CoreModule carries the services, not the console controllers, so the controller is assembled from them.
  const get = <T>(token: new (...a: never[]) => T | string) => t.app.get(token as never) as T;
  controller = new ConsoleTransactionsController(t.db, get(TransactionReader), get(TransactionService), get(LedgerService), get(NotificationService), get(CryptoService), get(AuditService), null as never);
});
afterAll(() => t.close());
beforeEach(() => t.reset());

/** Creates n confirmed collections on a fresh project, amounts 1000 + 10*i, and returns the project and references. */
async function seed(code: string, n: number) {
  const project = await t.project(code);
  const principal = await t.app.get(ProjectAuthService).resolveToken((await t.app.get(ProjectAuthService).exchange(project.key, project.secret, '10.0.0.1')).access_token, '10.0.0.1');
  const refs: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = await t.app.get(PreviewService).create(principal, { direction: 'collection', amount: 1000 + 10 * i, currency: 'XAF', country: 'CM', payment_method: 'MOMO', counterparty: { msisdn: `+2376700${String(i).padStart(5, '0')}` }, reference: `${code}-${i}` });
    const { transactionId } = await t.app.get(TransactionService).confirm(principal, p.reference, 'collection');
    refs.push((await t.db.selectFrom('transaction').select('reference').where('id', '=', transactionId).executeTakeFirstOrThrow()).reference);
  }
  return { project, refs };
}

describe('GET /console/transactions on the page contract', () => {
  it('pages transactions with a total and no cursor', async () => {
    await seed('shop', 30);
    const res = (await controller.search({ page_size: '25' }, consoleRequest(t))) as unknown as Record<string, unknown>;
    expect((res.data as unknown[]).length).toBe(25);
    expect(res.total).toBe(30);
    expect(res.page).toBe(1);
    expect(res.page_size).toBe(25);
    expect(res).not.toHaveProperty('next_cursor');
    const second = await controller.search({ page: '2' }, consoleRequest(t));
    expect(second.data.length).toBe(5);
  });

  it('sorts by amount only within one currency', async () => {
    await seed('shop', 5);
    await expect(controller.search({ sort: 'amount' }, consoleRequest(t))).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    const res = await controller.search({ sort: 'amount', order: 'asc', currency: 'XAF' }, consoleRequest(t));
    const amounts = res.data.map((r) => Number(r.requested_amount));
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    expect(amounts.length).toBe(5);
  });

  it('finds a transaction by the start of its reference', async () => {
    const { refs } = await seed('shop', 3);
    const res = await controller.search({ q: refs[1]!.slice(0, 8) + refs[1]!.slice(8) }, consoleRequest(t));
    expect(res.data.map((r) => r.reference)).toEqual([refs[1]]);
    const prefix = await controller.search({ q: refs[1]!.slice(0, 8) }, consoleRequest(t));
    expect(prefix.data.map((r) => r.reference)).toContain(refs[1]);
    expect((await controller.search({ q: '%' }, consoleRequest(t))).total).toBe(0);
  });

  it('scoped total counts only the scoped projects', async () => {
    const a = await seed('alpha', 3);
    await seed('beta', 4);
    const res = await controller.search({}, consoleRequest(t, { scope: [a.project.id] }));
    expect(res.total).toBe(3);
    expect(res.data.length).toBe(3);
    expect(res.scoped).toBe(true);
    expect((await controller.search({}, consoleRequest(t))).total).toBe(7);
  });

  it('refuses a page size outside 25, 50, 100', async () => {
    await expect(controller.search({ page_size: '7' }, consoleRequest(t))).rejects.toMatchObject({ code: 'FIELD_INVALID' });
  });
});
