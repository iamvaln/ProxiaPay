import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db, type Executor, type Tx } from '../db/database';
import { LedgerService } from '../ledger/ledger.service';
import { divideCeil, subtract, sum, times, unitsOfCover } from '../money/money';
import { SettingsService } from '../settings/settings.service';
import { AlertService } from '../alerts/alert.service';
import { AuditService } from '../audit/audit.service';

export class FloatInsufficientError extends Error {
  constructor(readonly floatAccountId: string) {
    super('float insufficient');
  }
}

export interface FloatAccountView {
  id: string;
  providerAccountId: string;
  providerAccountName: string;
  countryCode: string;
  currency: string;
  direction: 'collection' | 'disbursement';
  balance: number;
  openDisbursements: number;
  freeLiquidity: number;
  outflowPerHour: number;
  coverHours: number | null;
  band: 'healthy' | 'watch' | 'critical';
  targetHours: number;
  minimumHours: number;
  overrideAmount: number | null;
  proposedTransfer: number | null;
}

/**
 * Treasury (spec 4.6–4.8): free liquidity, the check-and-reserve under a float lock, cover
 * bands with proposed transfers, registered float transfers, and the two constraints on a cashout.
 */
@Injectable()
export class TreasuryService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly alerts: AlertService,
    private readonly audit: AuditService,
  ) {}

  /** Disbursements submitted against this float account and still open: what the wallet balance overstates by. */
  async openDisbursements(exec: Executor, floatAccountId: string, excludeTransactionId?: string): Promise<number> {
    const acct = await exec.selectFrom('ledger_account').selectAll().where('id', '=', floatAccountId).executeTakeFirstOrThrow();
    const exclude = excludeTransactionId ? sql`and t.id <> ${excludeTransactionId}` : sql``;
    const { rows } = await sql<{ total: number }>`
      select coalesce(sum(t.expected_settled_amount + t.expected_provider_fee), 0)::bigint as total
        from transaction t
       where t.direction = 'disbursement' ${exclude}
         and t.state in ('created', 'submitted', 'processing', 'action_required', 'undetermined')
         and t.currency_code = ${acct.currency_code}
         and t.selected_provider_account_id = ${acct.provider_account_id}
         and t.route_id in (select id from route where country_code = ${acct.country_code})`.execute(exec);
    return rows[0]!.total;
  }

  async freeLiquidity(exec: Executor, floatAccountId: string, excludeTransactionId?: string): Promise<{ balance: number; open: number; free: number }> {
    const balance = await this.ledger.balance(exec, floatAccountId);
    const open = await this.openDisbursements(exec, floatAccountId, excludeTransactionId);
    return { balance, open, free: subtract(balance, open) };
  }

  /**
   * The liquidity check of spec 4.6, under an advisory lock on the float account for the rest of
   * the transaction, so concurrent disbursements on one route cannot jointly exceed it. The
   * caller has already reserved against the project (solvency), which is a separate condition.
   */
  async checkLiquidity(tx: Tx, floatAccountId: string, required: number, excludeTransactionId?: string): Promise<void> {
    await this.ledger.lockAccount(tx, floatAccountId);
    // The transaction being confirmed is already inserted in this transaction and must not count against itself.
    const { free } = await this.freeLiquidity(tx, floatAccountId, excludeTransactionId);
    if (free < required) {
      throw new FloatInsufficientError(floatAccountId);
    }
  }

  async raiseFloatInsufficient(floatAccountId: string, shortfall: number): Promise<void> {
    await this.alerts.raise({
      category: 'treasury', severity: 'critical', subjectType: 'float_account', subjectReference: floatAccountId, fingerprint: `float_insufficient:${floatAccountId}`,
      title: 'Disbursement refused: float insufficient', detail: { shortfall }, actionReference: `/treasury/float/${floatAccountId}`,
    });
  }

  /** Outflow over the last seven days at the 95th percentile of daily volume, expressed per hour (spec 4.6.1). */
  async outflowPerHour(exec: Executor, floatAccountId: string): Promise<number> {
    const acct = await exec.selectFrom('ledger_account').selectAll().where('id', '=', floatAccountId).executeTakeFirstOrThrow();
    const { rows } = await sql<{ p95: number | null }>`
      with daily as (
        select date_trunc('day', e.occurred_at) as day, sum(p.amount)::bigint as out
          from ledger_posting p join ledger_entry e on e.id = p.entry_id
         where p.account_id = ${acct.id} and p.side = 'credit' and e.entry_type in ('disbursement_settlement', 'suspense_settlement')
           and e.occurred_at > now() - interval '7 days'
         group by 1)
      select percentile_cont(0.95) within group (order by out) as p95 from daily`.execute(exec);
    const p95 = rows[0]?.p95;
    return p95 ? divideCeil(Math.round(Number(p95)), 24) : 0;
  }

  async floatAccounts(exec: Executor = this.db, providerScope: string[] | null = null): Promise<FloatAccountView[]> {
    let q = exec
      .selectFrom('ledger_account as a')
      .innerJoin('provider_account as pa', 'pa.id', 'a.provider_account_id')
      .leftJoin('float_threshold as ft', 'ft.account_id', 'a.id')
      .select(['a.id', 'a.provider_account_id', 'pa.name as provider_account_name', 'a.country_code', 'a.currency_code', 'a.direction', 'ft.target_hours', 'ft.minimum_hours', 'ft.override_amount'])
      .where('a.type', '=', 'float');
    if (providerScope) q = q.where('a.provider_account_id', 'in', providerScope.length ? providerScope : ['00000000-0000-0000-0000-000000000000']);
    const rows = await q.execute();
    const targetDefault = await this.settings.number('float.cover_target_hours');
    const minimumDefault = await this.settings.number('float.cover_minimum_hours');
    const views: FloatAccountView[] = [];
    for (const r of rows) {
      const { balance, open, free } = await this.freeLiquidity(exec, r.id);
      const outflow = r.direction === 'disbursement' ? await this.outflowPerHour(exec, r.id) : 0;
      const targetHours = r.target_hours ?? targetDefault;
      const minimumHours = r.minimum_hours ?? minimumDefault;
      const coverHours = r.direction !== 'disbursement' ? null : unitsOfCover(free, outflow);
      let band: FloatAccountView['band'] = 'healthy';
      if (r.override_amount != null) {
        band = free < r.override_amount ? 'critical' : 'healthy';
      } else if (coverHours !== null) {
        band = coverHours < minimumHours ? 'critical' : coverHours < targetHours ? 'watch' : 'healthy';
      }
      const proposedTransfer = band === 'healthy' || outflow === 0 ? null : Math.max(0, subtract(times(outflow, targetHours), free));
      views.push({
        id: r.id, providerAccountId: r.provider_account_id!, providerAccountName: r.provider_account_name, countryCode: r.country_code!, currency: r.currency_code,
        direction: r.direction as 'collection' | 'disbursement', balance, openDisbursements: open, freeLiquidity: free, outflowPerHour: outflow, coverHours, band,
        targetHours, minimumHours, overrideAmount: r.override_amount, proposedTransfer,
      });
    }
    return views.sort((a, b) => (a.coverHours ?? Infinity) - (b.coverHours ?? Infinity));
  }

  /** Evaluates cover bands and raises, escalates or clears the corresponding alerts; run from the worker. */
  async evaluateCover(): Promise<void> {
    for (const f of await this.floatAccounts()) {
      const fp = `float_cover:${f.id}`;
      if (f.band === 'healthy') {
        await this.alerts.clear(fp);
        continue;
      }
      let detail: Record<string, unknown> = { cover_hours: f.coverHours, free_liquidity: f.freeLiquidity, currency: f.currency, proposed_transfer: f.proposedTransfer };
      const paired = await this.ledger.findAccount(this.db, { type: 'float', providerAccountId: f.providerAccountId, countryCode: f.countryCode, currency: f.currency, direction: 'collection' });
      const pairedBalance = paired ? (await this.freeLiquidity(this.db, paired)).free : 0;
      if (f.proposedTransfer != null && pairedBalance < f.proposedTransfer) detail = { ...detail, funding_required: subtract(f.proposedTransfer, pairedBalance), paired_collection_free: pairedBalance };
      await this.alerts.raise({
        category: 'treasury', severity: f.band === 'critical' ? 'critical' : 'warning', subjectType: 'float_account', subjectReference: f.id, fingerprint: fp,
        title: `Float cover ${f.band}: ${f.providerAccountName} ${f.countryCode} ${f.currency} ${f.direction}`, detail, actionReference: `/treasury/float/${f.id}`,
      });
    }
    for (const c of await this.db.selectFrom('currency').select('code').execute()) {
      const cov = await this.ledger.coverage(this.db, c.code);
      const fp = `coverage_ratio:${c.code}`;
      if (cov.ratio !== null && cov.ratio < 1) {
        await this.alerts.raise({ category: 'treasury', severity: 'critical', subjectType: 'currency', subjectReference: c.code, fingerprint: fp, title: `Coverage below one in ${c.code}`, detail: cov, actionReference: '/treasury/float' });
      } else {
        await this.alerts.clear(fp);
      }
    }
  }

  /** An administrator registers a transfer performed in the provider's console; it stays pending until reconciliation confirms it. */
  async registerTransfer(tx: Tx, args: { sourceAccountId: string; destinationAccountId: string; amount: number; providerFee: number; providerReference?: string; note?: string; actorId: string; confirmationId?: string }): Promise<string> {
    const src = await tx.selectFrom('ledger_account').selectAll().where('id', '=', args.sourceAccountId).executeTakeFirstOrThrow();
    const dst = await tx.selectFrom('ledger_account').selectAll().where('id', '=', args.destinationAccountId).executeTakeFirstOrThrow();
    if (src.type !== 'float' || dst.type !== 'float') throw new PlatformError('RULE_VIOLATION', 'Both sides of a transfer are float accounts.');
    if (src.provider_account_id !== dst.provider_account_id) throw new PlatformError('RULE_VIOLATION', 'A transfer moves value between wallets at one provider.');
    if (src.currency_code !== dst.currency_code) throw new PlatformError('RULE_VIOLATION', 'A transfer stays within one currency.');
    await this.ledger.lockAccount(tx, src.id);
    const { free } = await this.freeLiquidity(tx, src.id);
    if (free < args.amount) throw new PlatformError('RULE_VIOLATION', 'The source wallet lacks the free liquidity for this transfer.', { details: { free_liquidity: free, currency: src.currency_code } });
    const row = await tx
      .insertInto('float_transfer')
      .values({
        provider_account_id: src.provider_account_id!, source_account_id: src.id, destination_account_id: dst.id, currency_code: src.currency_code, amount: args.amount, provider_fee: args.providerFee,
        execution_path: 'registered', provider_reference: args.providerReference ?? null, initiated_by: args.actorId, note: args.note ?? '',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const entryId = await this.ledger.postFloatTransfer(tx, { sourceAccountId: src.id, destinationAccountId: dst.id, currency: src.currency_code, amount: args.amount, providerFee: args.providerFee, reference: `float_transfer:${row.id}` });
    await tx.updateTable('float_transfer').set({ ledger_entry_id: entryId }).where('id', '=', row.id).execute();
    await this.audit.record(tx, { actorId: args.actorId, action: 'float_transfer.register', subjectType: 'float_transfer', subjectId: row.id, next: { source: src.id, destination: dst.id, amount: args.amount, provider_fee: args.providerFee, currency: src.currency_code }, confirmationId: args.confirmationId });
    return row.id;
  }

  async confirmTransfer(tx: Tx, transferId: string, runId: string): Promise<void> {
    await tx.updateTable('float_transfer').set({ status: 'confirmed', confirmed_at: sql`now()`, confirming_run_id: runId }).where('id', '=', transferId).where('status', '=', 'pending').execute();
    await this.alerts.clear(`unconfirmed_transfer:${transferId}`, tx);
  }

  /**
   * Cashout constraints (spec 4.8). Solvency: total float in the currency at this provider
   * beyond the project balances it backs. Liquidity: what leaves the wallet above its reserve,
   * with a collection wallet also keeping enough to restore its paired disbursement wallet.
   */
  async withdrawable(exec: Executor, floatAccountId: string): Promise<{ solvency: number; liquidity: number; withdrawable: number; binding: 'solvency' | 'liquidity' }> {
    const acct = await exec.selectFrom('ledger_account').selectAll().where('id', '=', floatAccountId).executeTakeFirstOrThrow();
    const cov = await this.ledger.coverage(exec, acct.currency_code);
    const solvency = Math.max(0, subtract(cov.float, cov.encumbered));
    const views = await this.floatAccounts(exec);
    const me = views.find((v) => v.id === floatAccountId)!;
    const reserveOf = (v: FloatAccountView) => v.overrideAmount ?? times(v.outflowPerHour, v.targetHours);
    let liquidity = Math.max(0, subtract(me.freeLiquidity, reserveOf(me)));
    if (me.direction === 'collection') {
      const paired = views.find((v) => v.providerAccountId === me.providerAccountId && v.countryCode === me.countryCode && v.currency === me.currency && v.direction === 'disbursement');
      if (paired) {
        const restore = Math.max(0, subtract(reserveOf(paired), paired.freeLiquidity));
        liquidity = Math.max(0, subtract(liquidity, restore));
      }
    }
    const withdrawable = Math.min(solvency, liquidity);
    return { solvency, liquidity, withdrawable, binding: solvency <= liquidity ? 'solvency' : 'liquidity' };
  }

  async initiateCashout(tx: Tx, args: { floatAccountId: string; destination: string; amount: number; supportingDocument: string; actorId: string; confirmationId?: string; justification: string }): Promise<{ id: string; requiresApproval: boolean }> {
    const acct = await tx.selectFrom('ledger_account').selectAll().where('id', '=', args.floatAccountId).executeTakeFirstOrThrow();
    await this.ledger.lockAccount(tx, acct.id);
    const w = await this.withdrawable(tx, acct.id);
    if (args.amount > w.withdrawable) {
      throw new PlatformError('RULE_VIOLATION', `The amount exceeds the withdrawable remainder; ${w.binding} binds.`, { details: { solvency_remainder: w.solvency, liquidity_remainder: w.liquidity, withdrawable: w.withdrawable, binding: w.binding, currency: acct.currency_code } });
    }
    const threshold = await this.settings.number('cashout.second_approval_above');
    const requiresApproval = args.amount > threshold;
    const settlement = await this.ledger.getOrCreateAccount(tx, { type: 'settlement', destination: args.destination, currency: acct.currency_code });
    const row = await tx
      .insertInto('cashout')
      .values({
        float_account_id: acct.id, settlement_account_id: settlement, currency_code: acct.currency_code, amount: args.amount, destination_reference: args.destination,
        initiated_by: args.actorId, supporting_document: args.supportingDocument, solvency_remainder: w.solvency, liquidity_remainder: w.liquidity,
        status: requiresApproval ? 'pending_approval' : 'approved',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (requiresApproval) {
      await tx.insertInto('approval_request').values({
        type: 'cashout', subject: JSON.stringify({ cashout_id: row.id, float_account_id: acct.id, destination: args.destination, amount: args.amount, currency: acct.currency_code, solvency: w.solvency, liquidity: w.liquidity }),
        summary: `Cashout of ${args.amount} ${acct.currency_code} to ${args.destination}`, amount: args.amount, currency_code: acct.currency_code, initiated_by: args.actorId, justification: args.justification,
      }).execute();
      await this.alerts.raise({ category: 'security', severity: 'informational', subjectType: 'cashout', subjectReference: row.id, fingerprint: `approval:cashout:${row.id}`, title: 'Cashout awaiting a second approver', detail: { amount: args.amount, currency: acct.currency_code }, actionReference: '/approvals' }, tx);
    } else {
      await this.executeCashout(tx, row.id, null);
    }
    await this.audit.record(tx, { actorId: args.actorId, action: 'cashout.initiate', subjectType: 'cashout', subjectId: row.id, next: { amount: args.amount, currency: acct.currency_code, destination: args.destination, requires_approval: requiresApproval }, confirmationId: args.confirmationId });
    return { id: row.id, requiresApproval };
  }

  async executeCashout(tx: Tx, cashoutId: string, approvedBy: string | null): Promise<void> {
    const c = await tx.selectFrom('cashout').selectAll().where('id', '=', cashoutId).forUpdate().executeTakeFirstOrThrow();
    if (c.status === 'confirmed') return;
    if (approvedBy && approvedBy === c.initiated_by) throw new PlatformError('PERMISSION_DENIED', 'The approver of a cashout is a different person from its initiator.');
    const entryId = await this.ledger.postCashout(tx, { floatAccountId: c.float_account_id, settlementAccountId: c.settlement_account_id, amount: c.amount, authorId: approvedBy ?? c.initiated_by, reference: `cashout:${c.id}` });
    await tx.updateTable('cashout').set({ status: 'confirmed', approved_by: approvedBy, ledger_entry_id: entryId, confirmed_at: sql`now()` }).where('id', '=', c.id).execute();
    await this.alerts.clear(`approval:cashout:${c.id}`, tx);
  }

  async setThreshold(tx: Tx, floatAccountId: string, args: { targetHours: number; minimumHours: number; overrideAmount: number | null }, actorId: string): Promise<void> {
    const prior = await tx.selectFrom('float_threshold').selectAll().where('account_id', '=', floatAccountId).executeTakeFirst();
    await tx
      .insertInto('float_threshold')
      .values({ account_id: floatAccountId, target_hours: args.targetHours, minimum_hours: args.minimumHours, override_amount: args.overrideAmount, updated_by: actorId })
      .onConflict((oc) => oc.column('account_id').doUpdateSet({ target_hours: args.targetHours, minimum_hours: args.minimumHours, override_amount: args.overrideAmount, updated_by: actorId, updated_at: sql`now()` }))
      .execute();
    await this.audit.record(tx, { actorId, action: 'float_threshold.set', subjectType: 'float_account', subjectId: floatAccountId, prior: prior ?? null, next: args });
  }

  /** Sum of every float account and encumbered balance per currency, for the dashboard head. */
  async coverageByCurrency(exec: Executor = this.db) {
    const out: { currency: string; float: number; encumbered: number; ratio: number | null }[] = [];
    for (const c of await exec.selectFrom('currency').select('code').orderBy('code').execute()) {
      const cov = await this.ledger.coverage(exec, c.code);
      if (cov.float === 0 && cov.encumbered === 0) continue;
      out.push({ currency: c.code, ...cov });
    }
    return out;
  }

  totalOf(views: FloatAccountView[], currency: string): number {
    return sum(...views.filter((v) => v.currency === currency).map((v) => v.balance));
  }
}
