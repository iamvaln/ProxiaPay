import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db, type Tx } from '../db/database';
import { LedgerService } from '../ledger/ledger.service';
import { log } from '../logging/logger';
import { subtract } from '../money/money';
import { ProviderAccountService } from '../providers/provider-account.service';
import { SettingsService } from '../settings/settings.service';
import { TreasuryService } from '../treasury/treasury.service';
import { AlertService } from '../alerts/alert.service';
import { canonical } from '../admin-auth/confirmation.service';
import { normaliseStatementStatus } from './statement-format';
import type { ProviderTransactionRecord, WalletBalance } from '../providers/adapter';
import { newCorrelationId } from '../crypto/references';

export type DiscrepancyType = 'float_drift' | 'fee_variance' | 'orphan_transaction' | 'missing_transaction' | 'state_divergence' | 'stale_undetermined' | 'unconfirmed_transfer' | 'checkpoint_mismatch';

export interface Finding {
  type: DiscrepancyType;
  subjectType: string;
  subjectReference: string;
  transactionId?: string | null;
  floatAccountId?: string | null;
  floatTransferId?: string | null;
  expected: unknown;
  observed: unknown;
  difference?: number | null;
  currency?: string | null;
}

/**
 * Reconciliation runs (spec 9): the platform's records against a provider's, line by line,
 * with float balances, stale undetermined transactions, unconfirmed transfers and checkpoint
 * integrity, each difference raised once per fingerprint and recognised when seen again.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = log('reconciliation');
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly accounts: ProviderAccountService,
    private readonly treasury: TreasuryService,
    private readonly settings: SettingsService,
    private readonly alerts: AlertService,
  ) {}

  static fingerprint(f: Finding): string {
    return createHash('sha256').update(`${f.type}|${f.subjectType}|${f.subjectReference}|${canonical(f.difference ?? f.observed)}`).digest('hex');
  }

  /** Starts a run; one per provider account at a time (enforced by the store). */
  async start(args: { providerAccountId: string; mode: 'automated' | 'manual'; statementImportId?: string; periodStart: Date; periodEnd: Date; startedBy: string | null }): Promise<string> {
    try {
      const row = await this.db.transaction().execute(async (tx) => {
        const run = await tx
          .insertInto('reconciliation_run')
          .values({ provider_account_id: args.providerAccountId, mode: args.mode, statement_import_id: args.statementImportId ?? null, period_start: args.periodStart, period_end: args.periodEnd, started_by: args.startedBy })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (args.statementImportId) await tx.updateTable('statement_import').set({ run_id: run.id, status: 'confirmed' }).where('id', '=', args.statementImportId).execute();
        return run;
      });
      return row.id;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new PlatformError('CONFLICT', 'A run is already in progress for this provider account.');
      throw e;
    }
  }

  async execute(runId: string): Promise<{ compared: number; raised: number }> {
    const run = await this.db.selectFrom('reconciliation_run').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    if (run.status !== 'running') return { compared: run.records_compared, raised: run.discrepancies_raised };
    try {
      const records = run.mode === 'manual' ? await this.statementRecords(run.statement_import_id!) : await this.listedRecords(run.provider_account_id, run.period_start, run.period_end);
      const findings: Finding[] = [];
      const compared = await this.compareTransactions(run, records, findings);
      await this.compareWallets(run.provider_account_id, findings);
      await this.staleUndetermined(run.provider_account_id, findings);
      await this.unconfirmedTransfers(run.provider_account_id, findings);
      for (const m of await this.ledger.verifyCheckpoints(this.db)) {
        findings.push({ type: 'checkpoint_mismatch', subjectType: 'ledger_account', subjectReference: m.accountId, floatAccountId: m.accountId, expected: { checkpoint: m.checkpoint }, observed: { recomputed: m.recomputed }, difference: subtract(m.recomputed, m.checkpoint) });
      }
      const raised = await this.record(run.id, run.provider_account_id, findings);
      await this.db.updateTable('reconciliation_run').set({ status: 'completed', finished_at: sql`now()`, records_compared: compared, discrepancies_raised: raised, summary: JSON.stringify(summarise(findings)) }).where('id', '=', run.id).execute();
      if (raised > 0) {
        await this.alerts.raise({ category: 'reconciliation', severity: 'warning', subjectType: 'reconciliation_run', subjectReference: run.id, fingerprint: `run_findings:${run.id}`, title: `Reconciliation run raised ${raised} discrepancies`, detail: summarise(findings), actionReference: `/reconciliation/discrepancies?run=${run.id}` });
      } else {
        await this.alerts.raise({ category: 'reconciliation', severity: 'informational', subjectType: 'reconciliation_run', subjectReference: run.id, fingerprint: `run_clean:${run.id}`, title: 'Reconciliation run completed cleanly', detail: { compared }, actionReference: `/reconciliation/runs/${run.id}` });
      }
      return { compared, raised };
    } catch (e) {
      this.logger.error({ run_id: runId, err: e }, 'reconciliation run failed');
      await this.db.updateTable('reconciliation_run').set({ status: 'failed', finished_at: sql`now()`, error: (e as Error).message.slice(0, 2000) }).where('id', '=', run.id).execute();
      throw e;
    }
  }

  private async statementRecords(importId: string): Promise<ProviderTransactionRecord[]> {
    const rows = await this.db.selectFrom('statement_row').selectAll().where('import_id', '=', importId).execute();
    return rows.map((r) => ({
      providerReference: r.provider_reference, externalReference: r.external_reference ?? undefined, direction: (r.direction ?? 'collection') as 'collection' | 'disbursement',
      amount: r.amount ?? 0, fee: r.fee ?? 0, currency: r.currency_code ?? '', state: normaliseStatementStatus(r.status), occurredAt: r.occurred_at ?? new Date(0),
    }));
  }

  private async listedRecords(providerAccountId: string, start: Date, end: Date): Promise<ProviderTransactionRecord[]> {
    const { ctx, adapterKey } = await this.accounts.context(this.db, providerAccountId, newCorrelationId());
    const adapter = this.accounts.adapter(adapterKey);
    if (!adapter.listTransactions) throw new PlatformError('RULE_VIOLATION', 'This provider exposes no transaction listing; upload a statement.');
    return adapter.listTransactions(ctx, { start, end });
  }

  /** Scope of spec 9.1: every open transaction whatever its age, and every terminal one since the preceding run. */
  private async compareTransactions(run: { id: string; provider_account_id: string; period_start: Date; period_end: Date }, records: ProviderTransactionRecord[], findings: Finding[]): Promise<number> {
    const previous = await this.db.selectFrom('reconciliation_run').select('period_end').where('provider_account_id', '=', run.provider_account_id).where('status', '=', 'completed').where('id', '<>', run.id).orderBy('period_end', 'desc').executeTakeFirst();
    const since = previous?.period_end ?? new Date(0);
    const ours = await this.db
      .selectFrom('transaction as t')
      .leftJoin('transaction_attempt as a', 'a.id', 't.current_attempt_id')
      .leftJoin('route_binding as b', 'b.id', 'a.binding_id')
      .select(['t.id', 't.reference', 't.state', 't.direction', 't.currency_code', 't.requested_amount', 't.charged_amount', 't.expected_settled_amount', 't.actual_provider_fee', 't.expected_provider_fee', 't.reconciliation_status', 't.terminal_at', 't.created_at', 'a.provider_reference', 'a.provider_account_id', 'b.terms_status'])
      .where((eb) => eb.or([eb('a.provider_account_id', '=', run.provider_account_id), eb.and([eb('a.provider_account_id', 'is', null), eb('t.selected_provider_account_id', '=', run.provider_account_id)])]))
      // Open transactions whatever their age, terminal ones since the preceding run, and any still under an open discrepancy.
      .where((eb) => eb.or([eb('t.state', 'in', ['created', 'submitted', 'processing', 'action_required', 'undetermined']), eb('t.terminal_at', '>', since), eb('t.reconciliation_status', '=', 'disputed')]))
      .execute();
    const byProviderRef = new Map(records.filter((r) => r.providerReference).map((r) => [r.providerReference, r]));
    const byExternal = new Map(records.filter((r) => r.externalReference).map((r) => [r.externalReference!, r]));
    const matchedProviderRefs = new Set<string>();
    const matchedIds: string[] = [];
    for (const t of ours) {
      const theirs = (t.provider_reference && byProviderRef.get(t.provider_reference)) || byExternal.get(t.reference);
      if (!theirs) {
        if (t.state === 'succeeded' || t.state === 'undetermined' || (t.state !== 'failed' && t.state !== 'expired' && t.created_at < run.period_end)) {
          findings.push({ type: 'missing_transaction', subjectType: 'transaction', subjectReference: t.reference, transactionId: t.id, expected: { state: t.state, amount: t.requested_amount }, observed: { state: 'absent' }, currency: t.currency_code });
        }
        continue;
      }
      matchedProviderRefs.add(theirs.providerReference);
      const oursFinal = t.state === 'succeeded' ? 'succeeded' : t.state === 'failed' || t.state === 'expired' ? 'failed' : t.state;
      if ((theirs.state === 'succeeded' || theirs.state === 'failed') && theirs.state !== oursFinal) {
        findings.push({ type: 'state_divergence', subjectType: 'transaction', subjectReference: t.reference, transactionId: t.id, expected: { state: t.state }, observed: { state: theirs.state, provider_fee: theirs.fee, amount: theirs.amount, provider_reference: theirs.providerReference }, currency: t.currency_code });
        continue;
      }
      if (theirs.state === 'succeeded' && t.state === 'succeeded' && t.terms_status === 'contracted' && theirs.fee !== (t.actual_provider_fee ?? t.expected_provider_fee)) {
        findings.push({ type: 'fee_variance', subjectType: 'transaction', subjectReference: t.reference, transactionId: t.id, expected: { provider_fee: t.actual_provider_fee ?? t.expected_provider_fee }, observed: { provider_fee: theirs.fee }, difference: subtract(theirs.fee, t.actual_provider_fee ?? t.expected_provider_fee), currency: t.currency_code });
        continue;
      }
      if (t.reconciliation_status === 'unreviewed' && (theirs.state === oursFinal)) matchedIds.push(t.id);
    }
    for (const r of records) {
      if (matchedProviderRefs.has(r.providerReference)) continue;
      if (r.externalReference && ours.some((t) => t.reference === r.externalReference)) continue;
      const known = await this.db.selectFrom('transaction_attempt').select('transaction_id').where('provider_account_id', '=', run.provider_account_id).where('provider_reference', '=', r.providerReference).executeTakeFirst();
      if (known) continue; // matched to a transaction outside this run's window
      if (r.state === 'failed') continue; // a provider-side failure with no counterpart moved no money
      findings.push({ type: 'orphan_transaction', subjectType: 'provider_transaction', subjectReference: r.providerReference, expected: { state: 'absent' }, observed: { state: r.state, amount: r.amount, fee: r.fee, currency: r.currency, direction: r.direction, external_reference: r.externalReference ?? null }, currency: r.currency || null });
    }
    if (matchedIds.length) await this.db.updateTable('transaction').set({ reconciliation_status: 'matched' }).where('id', 'in', matchedIds).where('reconciliation_status', '=', 'unreviewed').execute();
    return ours.length + records.length;
  }

  private async compareWallets(providerAccountId: string, findings: Finding[]): Promise<void> {
    let wallets: WalletBalance[];
    try {
      const { ctx, adapterKey } = await this.accounts.context(this.db, providerAccountId, newCorrelationId());
      wallets = await this.accounts.adapter(adapterKey).wallets(ctx);
    } catch (e) {
      this.logger.warn({ provider_account: providerAccountId, err: (e as Error).message }, 'wallet balances unavailable; float drift not compared');
      return;
    }
    for (const w of wallets) {
      const accountId = await this.ledger.findAccount(this.db, { type: 'float', providerAccountId, countryCode: w.country, currency: w.currency, direction: w.direction });
      const ledgerBalance = accountId ? await this.ledger.balance(this.db, accountId) : 0;
      if (ledgerBalance !== w.balance) {
        findings.push({ type: 'float_drift', subjectType: 'float_account', subjectReference: `${w.country}/${w.currency}/${w.direction}`, floatAccountId: accountId ?? null, expected: { balance: ledgerBalance }, observed: { balance: w.balance, wallet: w.providerWalletId ?? null }, difference: subtract(w.balance, ledgerBalance), currency: w.currency });
      }
    }
  }

  private async staleUndetermined(providerAccountId: string, findings: Finding[]): Promise<void> {
    const hours = await this.settings.number('undetermined.stale_after_hours');
    const rows = await this.db.selectFrom('transaction').select(['id', 'reference', 'currency_code', 'requested_amount', 'updated_at']).where('state', '=', 'undetermined').where('selected_provider_account_id', '=', providerAccountId).where('updated_at', '<', sql<Date>`now() - make_interval(hours => ${hours})`).execute();
    for (const t of rows) {
      findings.push({ type: 'stale_undetermined', subjectType: 'transaction', subjectReference: t.reference, transactionId: t.id, expected: { resolved_within_hours: hours }, observed: { state: 'undetermined', since: t.updated_at }, currency: t.currency_code });
    }
  }

  private async unconfirmedTransfers(providerAccountId: string, findings: Finding[]): Promise<void> {
    const pending = await this.db.selectFrom('float_transfer').selectAll().where('provider_account_id', '=', providerAccountId).where('status', '=', 'pending').execute();
    for (const t of pending) {
      const drift = findings.filter((f) => f.type === 'float_drift' && (f.floatAccountId === t.source_account_id || f.floatAccountId === t.destination_account_id));
      if (drift.length === 0 && findings.some((f) => f.type !== 'float_drift') === false && Date.now() - t.created_at.getTime() > 60_000) {
        // Wallet balances reflect the transfer on both sides: confirm it.
        continue;
      }
      if (Date.now() - t.created_at.getTime() > 24 * 3600_000) {
        findings.push({ type: 'unconfirmed_transfer', subjectType: 'float_transfer', subjectReference: t.id, floatTransferId: t.id, floatAccountId: t.destination_account_id, expected: { status: 'confirmed' }, observed: { status: 'pending', registered_at: t.created_at }, difference: t.amount, currency: t.currency_code });
      }
    }
  }

  /** Records findings, recognising ones already raised (spec 9.6). Returns the count newly raised. */
  private async record(runId: string, providerAccountId: string, findings: Finding[]): Promise<number> {
    let raised = 0;
    for (const f of findings) {
      const fp = ReconciliationService.fingerprint(f);
      await this.db.transaction().execute(async (tx) => {
        const existing = await tx.selectFrom('discrepancy').select(['id', 'status', 'runs_seen', 'recurrences_after_resolution']).where('fingerprint', '=', fp).forUpdate().executeTakeFirst();
        if (existing) {
          if (existing.status === 'resolved') {
            await tx.updateTable('discrepancy').set({ last_detected_at: sql`now()`, recurrences_after_resolution: existing.recurrences_after_resolution + 1 }).where('id', '=', existing.id).execute();
            if (existing.recurrences_after_resolution + 1 >= 2) {
              await this.alerts.raise({ category: 'reconciliation', severity: 'warning', subjectType: 'discrepancy', subjectReference: existing.id, fingerprint: `recurring:${existing.id}`, title: 'Resolved discrepancy keeps recurring', detail: { type: f.type, subject: f.subjectReference, recurrences: existing.recurrences_after_resolution + 1 }, actionReference: `/reconciliation/discrepancies/${existing.id}` }, tx);
            }
          } else {
            await tx.updateTable('discrepancy').set({ last_detected_at: sql`now()`, runs_seen: existing.runs_seen + 1 }).where('id', '=', existing.id).execute();
          }
          return;
        }
        await tx.insertInto('discrepancy').values({
          run_id: runId, provider_account_id: providerAccountId, type: f.type, subject_type: f.subjectType, subject_reference: f.subjectReference, transaction_id: f.transactionId ?? null,
          float_account_id: f.floatAccountId ?? null, float_transfer_id: f.floatTransferId ?? null, fingerprint: fp, expected: JSON.stringify(f.expected), observed: JSON.stringify(f.observed),
          difference: f.difference ?? null, currency_code: f.currency ?? null,
        }).execute();
        if (f.transactionId) await tx.updateTable('transaction').set({ reconciliation_status: 'disputed' }).where('id', '=', f.transactionId).execute();
        raised++;
      });
    }
    return raised;
  }

  /** Weekly cadence (spec 9.1): a run per provider account that reconciles automatically; manual ones wait for a statement. */
  async scheduleWeekly(): Promise<number> {
    const accounts = await this.db.selectFrom('provider_account').select(['id', 'supports_listing']).where('status', '<>', 'suspended').execute();
    let started = 0;
    for (const a of accounts) {
      if (!a.supports_listing) continue;
      const last = await this.db.selectFrom('reconciliation_run').select('started_at').where('provider_account_id', '=', a.id).orderBy('started_at', 'desc').executeTakeFirst();
      if (last && Date.now() - last.started_at.getTime() < 7 * 24 * 3600_000) continue;
      const end = new Date();
      const start = last?.started_at ?? new Date(end.getTime() - 7 * 24 * 3600_000);
      try {
        const id = await this.start({ providerAccountId: a.id, mode: 'automated', periodStart: start, periodEnd: end, startedBy: null });
        await this.execute(id);
        started++;
      } catch (e) {
        this.logger.warn({ provider_account: a.id, err: (e as Error).message }, 'weekly run not started');
      }
    }
    return started;
  }

  async runsFor(providerScope: string[] | null, limit = 50) {
    let q = this.db.selectFrom('reconciliation_run as r').innerJoin('provider_account as pa', 'pa.id', 'r.provider_account_id').selectAll('r').select('pa.name as provider_account_name').orderBy('r.started_at', 'desc').limit(limit);
    if (providerScope) q = q.where('r.provider_account_id', 'in', providerScope.length ? providerScope : ['00000000-0000-0000-0000-000000000000']);
    return q.execute();
  }

  lockRun(tx: Tx, runId: string) {
    return tx.selectFrom('reconciliation_run').selectAll().where('id', '=', runId).forUpdate().executeTakeFirstOrThrow();
  }
}

function summarise(findings: Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.type] = (out[f.type] ?? 0) + 1;
  return out;
}
