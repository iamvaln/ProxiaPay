import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { ProjectAuthService, type ProjectPrincipal } from '../project-auth/project-auth.service';
import { PreviewService } from '../transactions/preview.service';
import { TransactionService } from '../transactions/transaction.service';
import { SubmissionService } from '../providers/submission.service';
import { StatusService } from '../providers/status.service';
import { LedgerService } from '../ledger/ledger.service';
import { SimulatorAdapter } from '../providers/adapters/simulator.adapter';
import { StatementService } from './statement.service';
import { ReconciliationService } from './reconciliation.service';
import { DiscrepancyService } from './discrepancy.service';
import { NotificationService } from '../notifications/notification.service';
import { parseCsv } from './statement-format';

let t: TestContext;
let auth: ProjectAuthService, previews: PreviewService, transactions: TransactionService, submission: SubmissionService, status: StatusService, ledger: LedgerService;
let statements: StatementService, recon: ReconciliationService, discrepancies: DiscrepancyService, notifications: NotificationService;
let principal: ProjectPrincipal;
let project: { id: string; key: string; secret: string; adminId: string };
let providerAccountId: string;

beforeAll(async () => {
  t = await createTestContext();
  auth = t.app.get(ProjectAuthService); previews = t.app.get(PreviewService); transactions = t.app.get(TransactionService); submission = t.app.get(SubmissionService); status = t.app.get(StatusService);
  ledger = t.app.get(LedgerService); statements = t.app.get(StatementService); recon = t.app.get(ReconciliationService); discrepancies = t.app.get(DiscrepancyService); notifications = t.app.get(NotificationService);
  SimulatorAdapter.settleAfterMs = 0;
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  project = await t.project('shop', { fundXaf: 50_000 });
  const token = await auth.exchange(project.key, project.secret, '10.0.0.1');
  principal = await auth.resolveToken(token.access_token, '10.0.0.1');
  providerAccountId = (await t.db.selectFrom('provider_account').select('id').executeTakeFirstOrThrow()).id;
  await notifications.setEndpoint(t.db, project.id, 'http://127.0.0.1:1/hook', project.adminId);
  SimulatorAdapter.wallets = [];
});

async function collect(msisdn: string, reference: string) {
  const p = await previews.create(principal, { direction: 'collection', amount: 1000, currency: 'XAF', country: 'CM', payment_method: 'MOMO', counterparty: { msisdn }, reference });
  const { transactionId } = await transactions.confirm(principal, p.reference, 'collection');
  await submission.submit(transactionId);
  await t.db.updateTable('transaction').set({ next_status_check_at: new Date(0) }).where('id', '=', transactionId).execute();
  await status.sweep();
  return t.db.selectFrom('transaction as t').leftJoin('transaction_attempt as a', 'a.id', 't.current_attempt_id').select(['t.id', 't.reference', 't.state', 'a.provider_reference']).where('t.id', '=', transactionId).executeTakeFirstOrThrow();
}

const csv = (rows: { ref: string; ext: string; status: string; amount: number; fee: number }[]) =>
  ['paymentReference,externalReference,transactionType,amount,fees,currencyCode,status,createdAt', ...rows.map((r) => `${r.ref},${r.ext},payin,${r.amount},${r.fee},XAF,${r.status},${new Date().toISOString()}`)].join('\n');

describe('statement import', () => {
  it('parses CSV with quotes and rejects duplicates by checksum', async () => {
    expect(parseCsv('a,"b,c","d""e"\n1,2,3\n')).toEqual([['a', 'b,c', 'd"e'], ['1', '2', '3']]);
    const content = Buffer.from(csv([{ ref: 'X1', ext: 'txn_none', status: 'confirmed', amount: 1025, fee: 20 }]));
    const period = { periodStart: new Date(Date.now() - 86400_000), periodEnd: new Date(Date.now() + 86400_000) };
    const r = await statements.upload({ providerAccountId, filename: 's.csv', content, uploadedBy: project.adminId, ...period });
    expect(r.import.row_count).toBe(1);
    expect(r.period_disagrees).toBe(false);
    await expect(statements.upload({ providerAccountId, filename: 's2.csv', content, uploadedBy: project.adminId, ...period })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('a run against a statement', () => {
  it('matches, raises orphan, missing and state divergence, and recognises them on the next run', async () => {
    const ok = await collect('677123456', 'r-1');
    const declined = await collect('677123401', 'r-2');
    const missing = await collect('677123457', 'r-3');
    expect([ok.state, declined.state, missing.state]).toEqual(['succeeded', 'failed', 'succeeded']);
    const period = { periodStart: new Date(Date.now() - 86400_000), periodEnd: new Date(Date.now() + 86400_000) };
    const upload = (name: string, rows: Parameters<typeof csv>[0]) => statements.upload({ providerAccountId, filename: name, content: Buffer.from(csv(rows)), uploadedBy: project.adminId, ...period });
    const rows = [
      { ref: ok.provider_reference!, ext: ok.reference, status: 'confirmed', amount: 1025, fee: 20 },
      { ref: declined.provider_reference!, ext: declined.reference, status: 'confirmed', amount: 1025, fee: 20 }, // the payer in fact paid
      { ref: 'EJP-ORPHAN', ext: '', status: 'confirmed', amount: 500, fee: 10 },
    ];
    const s1 = await upload('week1.csv', rows);
    const runId = await recon.start({ providerAccountId, mode: 'manual', statementImportId: s1.import.id, startedBy: project.adminId, ...period });
    const result = await recon.execute(runId);
    expect(result.raised).toBe(3);
    const found = await t.db.selectFrom('discrepancy').select(['type', 'subject_reference', 'status', 'runs_seen']).orderBy('type').execute();
    expect(found.map((d) => d.type).sort()).toEqual(['missing_transaction', 'orphan_transaction', 'state_divergence']);
    expect((await t.db.selectFrom('transaction').select('reconciliation_status').where('id', '=', ok.id).executeTakeFirstOrThrow()).reconciliation_status).toBe('matched');
    expect((await t.db.selectFrom('transaction').select('reconciliation_status').where('id', '=', declined.id).executeTakeFirstOrThrow()).reconciliation_status).toBe('disputed');

    // The same statement content a week later (new file name, one changed byte) raises nothing new.
    const s2 = await upload('week2.csv', [...rows, { ref: 'EJP-FAILED', ext: '', status: 'rejected', amount: 1, fee: 0 }]);
    const run2 = await recon.start({ providerAccountId, mode: 'manual', statementImportId: s2.import.id, startedBy: project.adminId, ...period });
    expect((await recon.execute(run2)).raised).toBe(0);
    const again = await t.db.selectFrom('discrepancy').select(['type', 'runs_seen']).execute();
    expect(again.every((d) => d.runs_seen === 2)).toBe(true);
  });

  it('corrects a failed collection the payer completed: ledger posted, project notified with the prior outcome', async () => {
    const declined = await collect('677123401', 'c-1');
    const period = { periodStart: new Date(Date.now() - 86400_000), periodEnd: new Date(Date.now() + 86400_000) };
    const s = await statements.upload({ providerAccountId, filename: 'c.csv', content: Buffer.from(csv([{ ref: declined.provider_reference!, ext: declined.reference, status: 'confirmed', amount: 1025, fee: 20 }])), uploadedBy: project.adminId, ...period });
    const runId = await recon.start({ providerAccountId, mode: 'manual', statementImportId: s.import.id, startedBy: project.adminId, ...period });
    await recon.execute(runId);
    const d = await t.db.selectFrom('discrepancy').selectAll().where('type', '=', 'state_divergence').executeTakeFirstOrThrow();
    const preview = await discrepancies.preview(d.id, 'correct_transaction');
    expect(preview.correction).toMatchObject({ from: { state: 'failed', failure_reason: 'PAYER_DECLINED' }, to: { state: 'succeeded' }, notification: 'transaction.corrected' });
    const r = await discrepancies.decide(d.id, project.adminId, { decision: 'accepted', comment: 'Provider statement shows the payment confirmed.', follow: 'correct_transaction' });
    expect(r.status).toBe('resolved');
    const txn = await t.db.selectFrom('transaction').selectAll().where('id', '=', declined.id).executeTakeFirstOrThrow();
    expect(txn).toMatchObject({ state: 'succeeded', reconciliation_status: 'corrected', settled_amount: 1000, actual_provider_fee: 20 });
    expect(await ledger.projectBalances(t.db, project.id)).toEqual([{ currency: 'XAF', available: 51_000, reserved: 0 }]);
    const events = await t.db.selectFrom('transaction_event').select(['prior_state', 'new_state', 'source']).where('transaction_id', '=', declined.id).orderBy('id').execute();
    expect(events.at(-1)).toMatchObject({ new_state: 'succeeded', source: 'reconciliation' });
    expect(events.some((e) => e.prior_state === 'failed')).toBe(true);
    const deliveries = await t.db.selectFrom('notification_delivery').select(['event_type', 'payload']).orderBy('created_at').execute();
    const corrected = deliveries.find((x) => x.event_type === 'transaction.corrected')!;
    expect((corrected.payload as { data: Record<string, unknown> }).data).toMatchObject({ previous_state: 'failed', previous_failure_reason: 'PAYER_DECLINED' });
    const resolved = await t.db.selectFrom('discrepancy').select(['status', 'decision', 'adjustment_posted']).where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(resolved).toEqual({ status: 'resolved', decision: 'accepted', adjustment_posted: true });
    const comments = await t.db.selectFrom('discrepancy_comment').selectAll().execute();
    expect(comments).toHaveLength(1);
  });

  it('raises float drift from wallet balances and resolves it with an adjustment', async () => {
    await collect('677123456', 'f-1');
    SimulatorAdapter.wallets = [{ country: 'CM', currency: 'XAF', direction: 'collection', balance: 1000 }]; // ledger holds 1005
    const period = { periodStart: new Date(Date.now() - 86400_000), periodEnd: new Date(Date.now() + 86400_000) };
    const runId = await recon.start({ providerAccountId, mode: 'manual', statementImportId: (await statements.upload({ providerAccountId, filename: 'f.csv', content: Buffer.from(csv([])), uploadedBy: project.adminId, ...period })).import.id, startedBy: project.adminId, ...period });
    await recon.execute(runId);
    const d = await t.db.selectFrom('discrepancy').selectAll().where('type', '=', 'float_drift').executeTakeFirstOrThrow();
    expect(d.difference).toBe(-5);
    const preview = await discrepancies.preview(d.id, 'post_adjustment');
    expect(preview.suggested_postings).toHaveLength(2);
    await discrepancies.decide(d.id, project.adminId, { decision: 'accepted', comment: 'Provider balance is authoritative; timing.', follow: 'post_adjustment' });
    const float = (await ledger.findAccount(t.db, { type: 'float', providerAccountId, countryCode: 'CM', currency: 'XAF', direction: 'collection' }))!;
    expect(await ledger.balance(t.db, float)).toBe(1000);
    expect((await t.db.selectFrom('discrepancy').select('resolving_entry_id').where('id', '=', d.id).executeTakeFirstOrThrow()).resolving_entry_id).toBeTruthy();
  });
});
