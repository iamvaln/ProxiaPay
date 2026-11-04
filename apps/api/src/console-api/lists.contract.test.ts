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
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { DiscrepancyService } from '../reconciliation/discrepancy.service';
import { TreasuryService } from '../treasury/treasury.service';
import { ConsoleTransactionsController } from './transactions.controller';
import { ReconciliationController } from './reconciliation.controller';
import { TreasuryController } from './treasury.controller';
import { OversightController } from './oversight.controller';
import { ConsoleProjectsController } from './projects.controller';
import { EntitlementService } from './entitlement.service';
import { CredentialService } from '../project-auth/credential.service';
import { ExportService } from './export.service';

let t: TestContext;
// CoreModule carries the services, not the console controllers, so each controller is assembled from them;
// what a tested method never touches is passed as null.
const get = <T>(token: new (...a: never[]) => T) => t.app.get(token as never) as T;
const nul = null as never;
const controllers = {
  transactions: () => new ConsoleTransactionsController(t.db, get(TransactionReader), get(TransactionService), get(LedgerService), get(NotificationService), get(CryptoService), get(AuditService), nul),
  reconciliation: () => new ReconciliationController(t.db, get(ReconciliationService), nul, get(DiscrepancyService), nul, nul),
  treasury: () => new TreasuryController(t.db, get(LedgerService), get(TreasuryService), nul, nul, nul, nul, nul),
  oversight: () => new OversightController(t.db, nul, nul, nul, nul, nul, nul, nul),
  projects: () => new ConsoleProjectsController(t.db, get(LedgerService), nul, get(NotificationService), nul, nul, nul),
  projectDetail: () => new ConsoleProjectsController(t.db, get(LedgerService), get(CredentialService), get(NotificationService), nul, new EntitlementService(t.db, get(AuditService)), nul),
};

beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(() => t.reset());

const N = 30;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const req = () => consoleRequest(t);
type Seeded = Record<string, string>;

/** A confirmed collection on a fresh project, with the project's credentials for creating more. */
async function oneTransaction(code = 'shop') {
  const project = await t.project(code);
  const auth = t.app.get(ProjectAuthService);
  const principal = await auth.resolveToken((await auth.exchange(project.key, project.secret, '10.0.0.1')).access_token, '10.0.0.1');
  const previews = t.app.get(PreviewService);
  const p = await previews.create(principal, { direction: 'collection', amount: 1000, currency: 'XAF', country: 'CM', payment_method: 'MOMO', counterparty: { msisdn: '+237670000001' }, reference: `${code}-0` });
  const { transactionId } = await t.app.get(TransactionService).confirm(principal, p.reference, 'collection');
  return { project, principal, previewReference: p.reference, transactionId };
}

/** Clones a preview row n times under new references, which is how a list gets many previews without driving a flow each. */
async function clonePreviews(previewReference: string, n: number, projectReference?: string) {
  const row = await t.db.selectFrom('preview').selectAll().where('reference', '=', previewReference).executeTakeFirstOrThrow();
  const { id: _id, ...rest } = row;
  for (const i of range(n)) await t.db.insertInto('preview').values({ ...rest, reference: `${previewReference}-c${i}`, project_reference: projectReference ?? rest.project_reference }).execute();
}

async function provider() {
  return t.db.selectFrom('provider_account').select('id').orderBy('id').executeTakeFirstOrThrow();
}
/** Two XAF ledger accounts that can sit on either side of an entry: a float account and a suspense account. */
async function twoAccounts() {
  const pa = await provider();
  const float = (await t.db.selectFrom('ledger_account').select('id').where('type', '=', 'float').where('currency_code', '=', 'XAF').where('provider_account_id', '=', pa.id).executeTakeFirst())
    ?? await t.db.insertInto('ledger_account').values({ type: 'float', currency_code: 'XAF', provider_account_id: pa.id, country_code: 'CM', direction: 'collection' }).returning('id').executeTakeFirstOrThrow();
  const other = (await t.db.selectFrom('ledger_account').select('id').where('type', '=', 'suspense').where('currency_code', '=', 'XAF').executeTakeFirst())
    ?? await t.db.insertInto('ledger_account').values({ type: 'suspense', currency_code: 'XAF' }).returning('id').executeTakeFirstOrThrow();
  return { pa: pa.id, float: float.id, other: other.id };
}

interface LongList { name: string; seed: () => Promise<Seeded>; call: (query: Record<string, string>, s: Seeded) => Promise<unknown>; sorts: string[] }

const LONG_LISTS: LongList[] = [
  {
    name: 'previews', sorts: ['created'],
    seed: async () => { const o = await oneTransaction(); await clonePreviews(o.previewReference, N - 1); return {}; },
    call: (q) => controllers.transactions().previews(q, req()),
  },
  {
    name: 'reconciliation/discrepancies', sorts: ['detected', 'type'],
    seed: async () => {
      const { id: pa } = await provider();
      const run = await t.db.insertInto('reconciliation_run').values({ provider_account_id: pa, mode: 'automated', period_start: new Date('2026-01-01'), period_end: new Date('2026-01-08') }).returning('id').executeTakeFirstOrThrow();
      for (const i of range(N)) await t.db.insertInto('discrepancy').values({ run_id: run.id, provider_account_id: pa, type: 'fee_variance', subject_type: 'transaction', subject_reference: `txn_${i}`, fingerprint: `fp-${i}`, expected: '{}', observed: '{}', difference: i, recurrences_after_resolution: i % 2 }).execute();
      return {};
    },
    call: (q) => controllers.reconciliation().discrepancyList(q, req()),
  },
  {
    name: 'reconciliation/runs', sorts: ['started'],
    seed: async () => {
      const { id: pa } = await provider();
      for (const i of range(N)) await t.db.insertInto('reconciliation_run').values({ provider_account_id: pa, mode: 'automated', period_start: new Date('2026-01-01'), period_end: new Date('2026-01-08'), status: 'completed', started_at: new Date(Date.UTC(2026, 1, 1, 0, i)) }).execute();
      return {};
    },
    call: (q) => controllers.reconciliation().list(q, req()),
  },
  {
    name: 'treasury/transfers', sorts: ['created', 'amount'],
    seed: async () => {
      const a = await twoAccounts();
      const admin = await t.admin();
      for (const i of range(N)) await t.db.insertInto('float_transfer').values({ provider_account_id: a.pa, source_account_id: a.other, destination_account_id: a.float, currency_code: 'XAF', amount: 100 + i, execution_path: 'registered', initiated_by: admin.id }).execute();
      return {};
    },
    call: (q) => controllers.treasury().transfers(q),
  },
  {
    name: 'treasury/cashouts', sorts: ['created', 'amount'],
    seed: async () => {
      const a = await twoAccounts();
      const admin = await t.admin();
      for (const i of range(N)) await t.db.insertInto('cashout').values({ float_account_id: a.float, settlement_account_id: a.other, currency_code: 'XAF', amount: 100 + i, destination_reference: 'bank', initiated_by: admin.id, solvency_remainder: 0, liquidity_remainder: 0 }).execute();
      return {};
    },
    call: (q) => controllers.treasury().cashouts(q),
  },
  {
    name: 'treasury/float/:id entries', sorts: ['when'],
    seed: async () => {
      const a = await twoAccounts();
      const admin = await t.admin();
      await t.db.transaction().execute(async (tx) => {
        for (const i of range(N)) {
          const e = await tx.insertInto('ledger_entry').values({ entry_type: 'float_funding', author_id: admin.id, justification: 'test', occurred_at: new Date(Date.UTC(2026, 1, 1, 0, i)) }).returning('id').executeTakeFirstOrThrow();
          await tx.insertInto('ledger_posting').values([{ entry_id: e.id, account_id: a.float, side: 'debit', amount: 100 }, { entry_id: e.id, account_id: a.other, side: 'credit', amount: 100 }]).execute();
        }
      });
      return { id: a.float };
    },
    call: (q, s) => controllers.treasury().floatEntries(s.id!, q, req()),
  },
  {
    name: 'oversight/alerts', sorts: ['raised', 'severity'],
    seed: async () => {
      for (const i of range(N)) await t.db.insertInto('alert').values({ category: 'treasury', severity: ['informational', 'warning', 'critical'][i % 3] as 'warning', subject_type: 'float_account', subject_reference: `f${i}`, fingerprint: `fp-${i}`, title: `Alert ${i}`, action_reference: '/treasury' }).execute();
      return {};
    },
    call: (q) => controllers.oversight().alertList(q),
  },
  {
    name: 'oversight/alerts/:id deliveries', sorts: ['sent'],
    seed: async () => {
      const alert = await t.db.insertInto('alert').values({ category: 'treasury', severity: 'warning', subject_type: 'float_account', subject_reference: 'f', fingerprint: 'fp', title: 'Alert', action_reference: '/treasury' }).returning('id').executeTakeFirstOrThrow();
      for (const i of range(N)) await t.db.insertInto('alert_delivery').values({ alert_id: alert.id, channel: 'email', address: `ops${i}@proxia.test`, kind: 'raised', status: 'sent' }).execute();
      return { id: alert.id };
    },
    call: (q, s) => controllers.oversight().alertDeliveries(s.id!, q),
  },
  {
    name: 'oversight/exports', sorts: ['created'],
    seed: async () => {
      const admin = await t.admin();
      for (const i of range(N)) await t.db.insertInto('export_record').values({ administrator_id: admin.id, subject: 'transactions', filters: '{}', row_count: i, environment: 'sandbox', signature: 'sig' }).execute();
      return {};
    },
    call: (q) => controllers.oversight().exportHistory(q),
  },
  {
    name: 'oversight/audit', sorts: ['when'],
    seed: async () => {
      for (const i of range(N)) await t.db.insertInto('audit_record').values({ action: 'test.action', subject_type: 'thing', subject_id: `s${i}` }).execute();
      return {};
    },
    call: (q) => controllers.oversight().auditLog(q),
  },
  {
    name: 'oversight/authentication-history', sorts: ['when'],
    seed: async () => {
      for (const i of range(N)) await t.db.insertInto('authentication_event').values({ email_presented: `a${i}@proxia.test`, outcome: 'failure', origin_address: '10.0.0.1' }).execute();
      return {};
    },
    call: (q) => controllers.oversight().authHistory(q),
  },
  {
    name: 'projects/:id/origin-refusals', sorts: ['when'],
    seed: async () => {
      const project = await t.project('shop');
      for (const i of range(N)) await t.db.insertInto('origin_refusal').values({ project_id: project.id, credential_key: `key${i}`, origin_address: '10.0.0.9' }).execute();
      return { id: project.id };
    },
    call: (q, s) => controllers.projects().originRefusals(s.id!, q, req()),
  },
  {
    name: 'projects/:id/deliveries', sorts: ['attempted'],
    seed: async () => {
      const o = await oneTransaction();
      const endpoint = await t.db.insertInto('project_notification_endpoint').values({ project_id: o.project.id, url: 'https://shop.test/hook', signing_secret_ciphertext: Buffer.from('x') }).returning('id').executeTakeFirstOrThrow();
      for (const i of range(N)) await t.db.insertInto('notification_delivery').values({ event_id: `evt_${i}`, transaction_id: o.transactionId, endpoint_id: endpoint.id, event_type: 'transaction.succeeded', payload: '{}' }).execute();
      return { id: o.project.id };
    },
    call: (q, s) => controllers.projects().deliveries(s.id!, q, req()),
  },
];

type PageResult = { data: Record<string, unknown>[]; total: number; page: number; page_size: number };

describe('every long console list is a page with its total', () => {
  for (const e of LONG_LISTS) {
    it(`${e.name} returns a page with its total`, async () => {
      const s = await e.seed();
      const res = (await e.call({ page_size: '25' }, s)) as PageResult;
      expect(res.data.length).toBe(25);
      expect(res.total).toBe(N);
      expect(res.page).toBe(1);
      expect(res.page_size).toBe(25);
      const last = (await e.call({ page: '2' }, s)) as PageResult;
      expect(last.data.length).toBe(5);
      expect(((await e.call({ page: '9' }, s)) as PageResult)).toMatchObject({ data: [], total: N });
    });

    it(`${e.name} refuses an unknown sort`, async () => {
      const s = await e.seed();
      await expect(e.call({ sort: 'nope' }, s)).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    });

    it(`${e.name} accepts each of its sorts`, async () => {
      const s = await e.seed();
      for (const sort of e.sorts) {
        // Amount sorts only inside one currency, and the money lists are all in XAF.
        const res = (await e.call({ sort, order: 'asc', currency: 'XAF' }, s)) as PageResult;
        expect(res.total, sort).toBe(N);
      }
    });
  }
});

describe('what is particular to each list', () => {
  it('treasury amount sorts only within one currency', async () => {
    const s = await LONG_LISTS.find((l) => l.name === 'treasury/transfers')!.seed();
    void s;
    await expect(controllers.treasury().transfers({ sort: 'amount' })).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    await expect(controllers.treasury().cashouts({ sort: 'amount' })).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    const res = await controllers.treasury().transfers({ sort: 'amount', order: 'asc', currency: 'XAF' });
    const amounts = res.data.map((r) => Number(r.amount));
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
  });

  it('alerts sort severity by weight, and filter by severity and category', async () => {
    await LONG_LISTS.find((l) => l.name === 'oversight/alerts')!.seed();
    const worst = await controllers.oversight().alertList({ sort: 'severity', order: 'desc', page_size: '25' });
    expect(worst.data[0]!.severity).toBe('critical');
    expect((await controllers.oversight().alertList({ severity: 'warning' })).total).toBe(10);
    expect((await controllers.oversight().alertList({ category: 'security' })).total).toBe(0);
  });

  it('discrepancy rows carry the difference and the recurrences', async () => {
    await LONG_LISTS.find((l) => l.name === 'reconciliation/discrepancies')!.seed();
    const res = await controllers.reconciliation().discrepancyList({ sort: 'detected' }, req());
    expect(res.data[0]).toHaveProperty('difference');
    expect(res.data[0]).toHaveProperty('recurrences');
    expect((await controllers.reconciliation().discrepancyList({ recurred: 'true' }, req())).total).toBe(15);
  });

  it('delivery rows carry the transaction reference', async () => {
    const s = await LONG_LISTS.find((l) => l.name === 'projects/:id/deliveries')!.seed();
    const res = await controllers.projects().deliveries(s.id!, {}, req());
    expect(res.data[0]!.transaction_reference).toMatch(/\S/);
  });

  it('float entries filter by side and carry no cursor', async () => {
    const s = await LONG_LISTS.find((l) => l.name === 'treasury/float/:id entries')!.seed();
    const res = await controllers.treasury().floatEntries(s.id!, { side: 'credit' }, req());
    expect(res.total).toBe(0);
    expect(await controllers.treasury().floatEntries(s.id!, { side: 'debit' }, req())).not.toHaveProperty('next_cursor');
  });

  it('audit pages by period and no longer returns a cursor', async () => {
    await LONG_LISTS.find((l) => l.name === 'oversight/audit')!.seed();
    const res = await controllers.oversight().auditLog({ after: '2999-01-01T00:00:00Z' });
    expect(res).toMatchObject({ data: [], total: 0 });
    expect(await controllers.oversight().auditLog({})).not.toHaveProperty('next_cursor');
  });

  it('a project list holds only that project\'s rows, and a project the administrator cannot reach is not found', async () => {
    const a = await LONG_LISTS.find((l) => l.name === 'projects/:id/origin-refusals')!.seed();
    const other = await t.project('other');
    expect((await controllers.projects().originRefusals(other.id, {}, req())).total).toBe(0);
    expect((await controllers.projects().originRefusals(a.id!, {}, req())).total).toBe(N);
    await expect(controllers.projects().originRefusals('00000000-0000-0000-0000-000000000000', {}, consoleRequest(t, { permissions: [] }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('previews match a reference by prefix and say whether the list is scoped', async () => {
    const o = await oneTransaction();
    const res = await controllers.transactions().previews({ q: o.previewReference.slice(0, 6) }, req());
    expect(res.total).toBe(1);
    expect(res.scoped).toBe(false);
    expect((await controllers.transactions().previews({ q: '%' }, req())).total).toBe(0);
  });
});

describe('the project list carries its 30-day activity', () => {
  it('counts the last 30 days per project and sums their value per currency, from one grouped query', async () => {
    const a = await oneTransaction('busy');
    const old = await oneTransaction('old');
    const idle = await t.project('idle');
    await t.db.updateTable('transaction').set({ created_at: new Date(Date.now() - 40 * 86_400_000) }).where('id', '=', old.transactionId).execute();
    const rows = (await controllers.projects().list(req())).projects;
    const by = (id: string) => rows.find((p) => p.id === id)!;
    expect(by(a.project.id)).toMatchObject({ volume_30d: 1, value_30d: [{ currency: 'XAF', value: 1000 }] });
    expect(by(old.project.id)).toMatchObject({ volume_30d: 0, value_30d: [] });
    expect(by(idle.id)).toMatchObject({ volume_30d: 0, value_30d: [] });
    expect(by(a.project.id).credentials_active).toBeGreaterThan(0);
  });
});

describe('detail endpoints no longer embed capped sub-lists', () => {
  it('project detail no longer embeds capped sub-lists', async () => {
    const p = await LONG_LISTS.find((l) => l.name === 'projects/:id/origin-refusals')!.seed();
    const project = await controllers.projectDetail().detail(p.id!, req());
    for (const k of ['origin_refusals', 'deliveries', 'activity']) expect(project, k).not.toHaveProperty(k);

    const f = await LONG_LISTS.find((l) => l.name === 'treasury/float/:id entries')!.seed();
    expect(await controllers.treasury().floatDetail(f.id!, req())).not.toHaveProperty('entries');

    const a = await LONG_LISTS.find((l) => l.name === 'oversight/alerts/:id deliveries')!.seed();
    expect(await controllers.oversight().alert(a.id!)).not.toHaveProperty('deliveries');

    await LONG_LISTS.find((l) => l.name === 'reconciliation/discrepancies')!.seed();
    const run = await t.db.selectFrom('reconciliation_run').select('id').executeTakeFirstOrThrow();
    expect(await controllers.reconciliation().run(run.id, req())).not.toHaveProperty('discrepancies');
  });
});

describe('previews: payers previewing repeatedly', () => {
  /** n expired previews per payer number on the project, cloned from its one real preview. */
  async function repeaters(o: Awaited<ReturnType<typeof oneTransaction>>, numbers: string[]) {
    await clonePreviews(o.previewReference, numbers.length * 3);
    const rows = await t.db.selectFrom('preview').select('reference').where('project_id', '=', o.project.id).where('reference', 'like', `${o.previewReference}-c%`).orderBy('reference').execute();
    for (const [i, r] of rows.entries()) await t.db.updateTable('preview').set({ status: 'expired', msisdn_masked: numbers[i % numbers.length]! }).where('reference', '=', r.reference).execute();
  }

  it('a scoped administrator sees only their own projects\' repeat payers', async () => {
    const mine = await oneTransaction('mine');
    const theirs = await oneTransaction('theirs');
    await repeaters(mine, ['+237•••0001']);
    await repeaters(theirs, ['+237•••0002']);
    const res = await controllers.transactions().previews({}, consoleRequest(t, { scope: [mine.project.id] }));
    expect(res.repeat_unconfirmed.map((r) => r.msisdn_masked)).toEqual(['+237•••0001']);
    const all = await controllers.transactions().previews({}, req());
    expect(all.repeat_unconfirmed.map((r) => r.msisdn_masked).sort()).toEqual(['+237•••0001', '+237•••0002']);
  });

  it('says when the panel stopped at 20', async () => {
    const o = await oneTransaction();
    await repeaters(o, range(21).map((i) => `+237•••${String(i).padStart(4, '0')}`));
    const res = await controllers.transactions().previews({}, req());
    expect(res.repeat_unconfirmed).toHaveLength(20);
    expect(res.repeat_capped).toBe(true);
    const few = await controllers.transactions().previews({}, consoleRequest(t, { scope: [] }));
    expect(few.repeat_capped).toBe(false);
  });
});

describe('GET /console/search', () => {
  it('says when it stopped at its cap', async () => {
    const o = await oneTransaction();
    await clonePreviews(o.previewReference, 60, 'dup');
    const res = await controllers.transactions().globalSearch('dup', req());
    expect(res.previews.length).toBe(20);
    expect(res.capped).toBe(true);
  });

  it('does not say capped when everything fit', async () => {
    const o = await oneTransaction();
    const res = await controllers.transactions().globalSearch(o.previewReference, req());
    expect(res.capped).toBe(false);
    expect(res.previews.map((p) => p.reference)).toEqual([o.previewReference]);
    expect(await controllers.transactions().globalSearch('', req())).toEqual({ transactions: [], previews: [], capped: false });
  });
});

describe('final review hardening', () => {
  const ids = (rows: { id: unknown }[]) => rows.map((r) => Number(r.id));

  it('sorts audit and authentication history by id, which is their time order and is indexed', async () => {
    for (const i of range(3)) await t.db.insertInto('audit_record').values({ action: 'test.action', subject_type: 'thing', subject_id: `s${i}`, occurred_at: new Date(Date.UTC(2026, 1, 3 - i)) }).execute();
    for (const i of range(3)) await t.db.insertInto('authentication_event').values({ email_presented: `a${i}@proxia.test`, outcome: 'failure', origin_address: '10.0.0.1', occurred_at: new Date(Date.UTC(2026, 1, 3 - i)) }).execute();
    const audit = ids((await controllers.oversight().auditLog({ sort: 'when', order: 'asc' })).data);
    expect(audit).toEqual([...audit].sort((a, b) => a - b));
    const auth = ids((await controllers.oversight().authHistory({ sort: 'when', order: 'asc' })).data);
    expect(auth).toEqual([...auth].sort((a, b) => a - b));
  });

  it('lists float entries in recording order, a backdated entry where it was recorded', async () => {
    const s = await LONG_LISTS.find((l) => l.name === 'treasury/float/:id entries')!.seed();
    const admin = await t.admin();
    const other = await t.db.selectFrom('ledger_posting').select('account_id').where('account_id', '<>', s.id!).executeTakeFirstOrThrow();
    await t.db.transaction().execute(async (tx) => {
      const e = await tx.insertInto('ledger_entry').values({ entry_type: 'float_funding', author_id: admin.id, justification: 'backdated', occurred_at: new Date(Date.UTC(2020, 1, 1)) }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('ledger_posting').values([{ entry_id: e.id, account_id: s.id!, side: 'debit', amount: 5 }, { entry_id: e.id, account_id: other.account_id, side: 'credit', amount: 5 }]).execute();
    });
    const res = await controllers.treasury().floatEntries(s.id!, { sort: 'when', order: 'asc', page_size: '100' }, req());
    const got = ids(res.data);
    expect(got).toEqual([...got].sort((x, y) => x - y));
    expect(res.data[res.data.length - 1]).toMatchObject({ justification: 'backdated' });
  });

  it('records an export without its paging and sorting', async () => {
    const ctl = new ConsoleTransactionsController(t.db, get(TransactionReader), get(TransactionService), get(LedgerService), get(NotificationService), get(CryptoService), get(AuditService), new ExportService(t.db, { MASTER_KEY_BASE64: Buffer.alloc(32, 1), PROXIAPAY_ENV: 'sandbox' }));
    const admin = await t.admin();
    const r = req();
    r.principal.administratorId = admin.id;
    await ctl.export({ currency: 'XAF', page: '3', page_size: '50', sort: 'created', order: 'asc' }, r);
    const rec = await t.db.selectFrom('export_record').select('filters').where('administrator_id', '=', admin.id).executeTakeFirstOrThrow();
    expect(rec.filters).toEqual({ currency: 'XAF' });
  });
});
