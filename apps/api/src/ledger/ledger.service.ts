import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { advisoryLock, DB_TOKEN, type Db, type Executor, type Tx } from '../db/database';
import { assertMinorUnits, ratio, subtract, sum, type Bearer } from '../money/money';

export type AccountType =
  | 'project_available' | 'project_reserved' | 'float' | 'processing_revenue' | 'platform_revenue'
  | 'fee_expense' | 'settlement' | 'business_capital' | 'suspense';

export type AccountKey =
  | { type: 'project_available' | 'project_reserved'; projectId: string; currency: string }
  | { type: 'float'; providerAccountId: string; countryCode: string; currency: string; direction: 'collection' | 'disbursement' }
  | { type: 'processing_revenue' | 'platform_revenue' | 'fee_expense' | 'business_capital' | 'suspense'; currency: string }
  | { type: 'settlement'; destination: string; currency: string };

export type Side = 'debit' | 'credit';
export interface Posting { accountId: string; side: Side; amount: number }

export type EntryType =
  | 'collection' | 'disbursement_reservation' | 'disbursement_settlement' | 'disbursement_release'
  | 'disbursement_suspension' | 'suspense_settlement' | 'suspense_release' | 'float_transfer' | 'cashout'
  | 'float_funding' | 'project_funding' | 'adjustment' | 'reversal' | 'refund';

export interface EntryInput {
  entryType: EntryType;
  postings: Posting[];
  occurredAt?: Date;
  transactionId?: string | null;
  authorId?: string | null;
  justification?: string | null;
  reversesEntryId?: string | null;
  discrepancyId?: string | null;
  reference?: string | null;
}

/** Which side increases an account's balance. Assets and expenses are debit-normal; liabilities, equity and revenue are credit-normal. */
export const NORMAL_SIDE: Record<AccountType, Side> = {
  project_available: 'credit',
  project_reserved: 'credit',
  suspense: 'credit',
  processing_revenue: 'credit',
  platform_revenue: 'credit',
  business_capital: 'credit',
  float: 'debit',
  fee_expense: 'debit',
  settlement: 'debit',
};

export interface FeeSplit {
  requested: number;
  processingFee: number;
  platformFee: number;
  processingBearer: Bearer;
  platformBearer: Bearer;
  actualProviderFee: number;
}

export class InsufficientBalanceError extends Error {
  constructor(readonly shortfall: number, readonly currency: string) {
    super(`balance short by ${shortfall} ${currency}`);
  }
}

/**
 * The double-entry ledger (spec 4). Every movement of money is an entry of balanced postings,
 * written once; balances derive from postings, read from the latest checkpoint forward. The
 * recipes below are the only shapes the platform writes, so the meaning of every entry type is
 * fixed here and reporting can rely on it.
 */
@Injectable()
export class LedgerService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /**
   * Accounts are created on first use. The insert names the partial unique index for the key's
   * type, so two transactions creating the same account at once both proceed: the second waits
   * for the first to commit and then reads it, and neither transaction is aborted.
   */
  async getOrCreateAccount(exec: Executor, key: AccountKey): Promise<string> {
    const found = await this.findAccount(exec, key);
    if (found) return found;
    const values = {
      type: key.type,
      currency_code: key.currency,
      project_id: 'projectId' in key ? key.projectId : null,
      provider_account_id: key.type === 'float' ? key.providerAccountId : null,
      country_code: key.type === 'float' ? key.countryCode : null,
      direction: key.type === 'float' ? key.direction : null,
      settlement_destination: key.type === 'settlement' ? key.destination : null,
    };
    const insert = exec.insertInto('ledger_account').values(values);
    const row = await (
      key.type === 'float'
        ? insert.onConflict((oc) => oc.columns(['provider_account_id', 'country_code', 'currency_code', 'direction']).where('type', '=', 'float').doNothing())
        : key.type === 'settlement'
          ? insert.onConflict((oc) => oc.columns(['settlement_destination', 'currency_code']).where('type', '=', 'settlement').doNothing())
          : 'projectId' in key
            ? insert.onConflict((oc) => oc.columns(['type', 'project_id', 'currency_code']).where('type', 'in', ['project_available', 'project_reserved']).doNothing())
            : insert.onConflict((oc) => oc.columns(['type', 'currency_code']).where('type', 'in', ['processing_revenue', 'platform_revenue', 'fee_expense', 'business_capital', 'suspense']).doNothing())
    ).returning('id').executeTakeFirst();
    if (row) return row.id;
    const again = await this.findAccount(exec, key);
    if (!again) throw new Error('ledger account vanished after conflict');
    return again;
  }

  async findAccount(exec: Executor, key: AccountKey): Promise<string | undefined> {
    let q = exec.selectFrom('ledger_account').select('id').where('type', '=', key.type).where('currency_code', '=', key.currency);
    if ('projectId' in key) q = q.where('project_id', '=', key.projectId);
    if (key.type === 'float') {
      q = q.where('provider_account_id', '=', key.providerAccountId).where('country_code', '=', key.countryCode).where('direction', '=', key.direction);
    }
    if (key.type === 'settlement') q = q.where('settlement_destination', '=', key.destination);
    const row = await q.executeTakeFirst();
    return row?.id;
  }

  /** Serialises check-and-post sequences on one account for the duration of the transaction. */
  async lockAccount(tx: Tx, accountId: string): Promise<void> {
    await advisoryLock(tx, 'ledger_account', accountId);
  }

  async balance(exec: Executor, accountId: string): Promise<number> {
    const acct = await exec.selectFrom('ledger_account').select(['type']).where('id', '=', accountId).executeTakeFirstOrThrow();
    const normal = NORMAL_SIDE[acct.type as AccountType];
    const cp = await exec
      .selectFrom('ledger_checkpoint')
      .select(['balance', 'through_posting_id'])
      .where('account_id', '=', accountId)
      .orderBy('through_posting_id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const since = cp?.through_posting_id ?? 0;
    const { rows } = await sql<{ debits: number; credits: number }>`
      select coalesce(sum(case when side = 'debit' then amount else 0 end), 0)::bigint as debits,
             coalesce(sum(case when side = 'credit' then amount else 0 end), 0)::bigint as credits
        from ledger_posting where account_id = ${accountId} and id > ${since}`.execute(exec);
    const { debits, credits } = rows[0]!;
    const delta = normal === 'debit' ? subtract(debits, credits) : subtract(credits, debits);
    return sum(cp?.balance ?? 0, delta);
  }

  async balanceByKey(exec: Executor, key: AccountKey): Promise<number> {
    const id = await this.findAccount(exec, key);
    return id ? this.balance(exec, id) : 0;
  }

  /** Records a checkpoint so later balance reads scan only the postings that follow it. */
  async checkpoint(tx: Tx, accountId: string): Promise<void> {
    await this.lockAccount(tx, accountId);
    const balance = await this.balance(tx, accountId);
    const last = await tx.selectFrom('ledger_posting').select(sql<number>`coalesce(max(id), 0)`.as('id')).where('account_id', '=', accountId).executeTakeFirstOrThrow();
    await tx.insertInto('ledger_checkpoint').values({ account_id: accountId, balance, through_posting_id: last.id }).execute();
  }

  /** Verifies that every checkpoint agrees with the postings it summarises (spec 9.4, checkpoint mismatch). */
  async verifyCheckpoints(exec: Executor): Promise<{ accountId: string; checkpoint: number; recomputed: number }[]> {
    const { rows } = await sql<{ account_id: string; type: string; balance: number; through_posting_id: number }>`
      select distinct on (account_id) c.account_id, a.type, c.balance, c.through_posting_id
        from ledger_checkpoint c join ledger_account a on a.id = c.account_id
       order by account_id, through_posting_id desc`.execute(exec);
    const mismatches: { accountId: string; checkpoint: number; recomputed: number }[] = [];
    for (const r of rows) {
      const normal = NORMAL_SIDE[r.type as AccountType];
      const { rows: s } = await sql<{ debits: number; credits: number }>`
        select coalesce(sum(case when side = 'debit' then amount else 0 end), 0)::bigint as debits,
               coalesce(sum(case when side = 'credit' then amount else 0 end), 0)::bigint as credits
          from ledger_posting where account_id = ${r.account_id} and id <= ${r.through_posting_id}`.execute(exec);
      const recomputed = normal === 'debit' ? subtract(s[0]!.debits, s[0]!.credits) : subtract(s[0]!.credits, s[0]!.debits);
      if (recomputed !== r.balance) mismatches.push({ accountId: r.account_id, checkpoint: r.balance, recomputed });
    }
    return mismatches;
  }

  /** Writes one entry with its postings. Zero-amount postings are dropped; the store rejects an unbalanced result at commit. */
  async post(tx: Tx, input: EntryInput): Promise<string> {
    const postings = input.postings.filter((p) => assertMinorUnits(p.amount) !== 0);
    for (const p of postings) if (p.amount < 0) throw new RangeError('posting amounts are positive; choose the side instead');
    const debits = sum(...postings.filter((p) => p.side === 'debit').map((p) => p.amount));
    const credits = sum(...postings.filter((p) => p.side === 'credit').map((p) => p.amount));
    if (debits !== credits) throw new RangeError(`entry ${input.entryType} is unbalanced: debits ${debits}, credits ${credits}`);
    if (postings.length < 2) throw new RangeError('an entry needs at least two postings');
    const entry = await tx
      .insertInto('ledger_entry')
      .values({
        entry_type: input.entryType,
        occurred_at: input.occurredAt ?? sql`now()`,
        transaction_id: input.transactionId ?? null,
        author_id: input.authorId ?? null,
        justification: input.justification ?? null,
        reverses_entry_id: input.reversesEntryId ?? null,
        discrepancy_id: input.discrepancyId ?? null,
        reference: input.reference ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx.insertInto('ledger_posting').values(postings.map((p) => ({ entry_id: entry.id, account_id: p.accountId, side: p.side, amount: p.amount }))).execute();
    return entry.id;
  }

  /** Reverses a prior entry by flipping each of its postings. */
  async reverse(tx: Tx, entryId: string, authorId: string, justification: string, discrepancyId?: string): Promise<string> {
    const postings = await tx.selectFrom('ledger_posting').select(['account_id', 'side', 'amount']).where('entry_id', '=', entryId).execute();
    if (postings.length === 0) throw new Error(`entry ${entryId} has no postings`);
    return this.post(tx, {
      entryType: 'reversal',
      reversesEntryId: entryId,
      authorId,
      justification,
      discrepancyId: discrepancyId ?? null,
      postings: postings.map((p) => ({ accountId: p.account_id, side: p.side === 'debit' ? 'credit' : 'debit', amount: p.amount })),
    });
  }

  // ------------------------------------------------------------------ recipes (spec 4.4, 6.1)

  private splits(f: FeeSplit) {
    const x = sum(f.processingBearer === 'counterparty' ? f.processingFee : 0, f.platformBearer === 'counterparty' ? f.platformFee : 0);
    const y = sum(f.processingBearer === 'project' ? f.processingFee : 0, f.platformBearer === 'project' ? f.platformFee : 0);
    return { x, y };
  }

  private async feeAccounts(exec: Executor, currency: string) {
    return {
      processing: await this.getOrCreateAccount(exec, { type: 'processing_revenue', currency }),
      platform: await this.getOrCreateAccount(exec, { type: 'platform_revenue', currency }),
      expense: await this.getOrCreateAccount(exec, { type: 'fee_expense', currency }),
    };
  }

  /** Collection: float rises by R + X − P, project credited R − Y, revenues booked, provider fee expensed. */
  async postCollection(tx: Tx, args: { transactionId: string; projectId: string; currency: string; floatAccountId: string; fees: FeeSplit; entryType?: 'collection' }): Promise<string> {
    const { x, y } = this.splits(args.fees);
    const f = args.fees;
    const floatDelta = subtract(sum(f.requested, x), f.actualProviderFee);
    if (floatDelta <= 0) throw new RangeError('provider fee consumes the whole collection; refusing to post');
    const available = await this.getOrCreateAccount(tx, { type: 'project_available', projectId: args.projectId, currency: args.currency });
    const fa = await this.feeAccounts(tx, args.currency);
    return this.post(tx, {
      entryType: 'collection',
      transactionId: args.transactionId,
      postings: [
        { accountId: args.floatAccountId, side: 'debit', amount: floatDelta },
        { accountId: fa.expense, side: 'debit', amount: f.actualProviderFee },
        { accountId: available, side: 'credit', amount: subtract(f.requested, y) },
        { accountId: fa.processing, side: 'credit', amount: f.processingFee },
        { accountId: fa.platform, side: 'credit', amount: f.platformFee },
      ],
    });
  }

  /** Moves R + Y from available to reserved under a lock on the available account; the move is the solvency check. */
  async reserve(tx: Tx, args: { transactionId: string; projectId: string; currency: string; amount: number }): Promise<{ entryId: string; reservedAccountId: string }> {
    const available = await this.getOrCreateAccount(tx, { type: 'project_available', projectId: args.projectId, currency: args.currency });
    const reserved = await this.getOrCreateAccount(tx, { type: 'project_reserved', projectId: args.projectId, currency: args.currency });
    await this.lockAccount(tx, available);
    const bal = await this.balance(tx, available);
    if (bal < args.amount) throw new InsufficientBalanceError(subtract(args.amount, bal), args.currency);
    const entryId = await this.post(tx, {
      entryType: 'disbursement_reservation',
      transactionId: args.transactionId,
      postings: [
        { accountId: available, side: 'debit', amount: args.amount },
        { accountId: reserved, side: 'credit', amount: args.amount },
      ],
    });
    return { entryId, reservedAccountId: reserved };
  }

  /** Settlement from reserved (or suspense): float falls by R − X + P, revenues booked, provider fee expensed. */
  async settleDisbursement(tx: Tx, args: { transactionId: string; projectId: string; currency: string; floatAccountId: string; fees: FeeSplit; from: 'reserved' | 'suspense' }): Promise<string> {
    const { x, y } = this.splits(args.fees);
    const f = args.fees;
    const source = args.from === 'reserved'
      ? await this.getOrCreateAccount(tx, { type: 'project_reserved', projectId: args.projectId, currency: args.currency })
      : await this.getOrCreateAccount(tx, { type: 'suspense', currency: args.currency });
    const fa = await this.feeAccounts(tx, args.currency);
    const floatDelta = sum(subtract(f.requested, x), f.actualProviderFee);
    return this.post(tx, {
      entryType: args.from === 'reserved' ? 'disbursement_settlement' : 'suspense_settlement',
      transactionId: args.transactionId,
      postings: [
        { accountId: source, side: 'debit', amount: sum(f.requested, y) },
        { accountId: fa.expense, side: 'debit', amount: f.actualProviderFee },
        { accountId: args.floatAccountId, side: 'credit', amount: floatDelta },
        { accountId: fa.processing, side: 'credit', amount: f.processingFee },
        { accountId: fa.platform, side: 'credit', amount: f.platformFee },
      ],
    });
  }

  async releaseReservation(tx: Tx, args: { transactionId: string; projectId: string; currency: string; amount: number; from: 'reserved' | 'suspense' }): Promise<string> {
    const available = await this.getOrCreateAccount(tx, { type: 'project_available', projectId: args.projectId, currency: args.currency });
    const source = args.from === 'reserved'
      ? await this.getOrCreateAccount(tx, { type: 'project_reserved', projectId: args.projectId, currency: args.currency })
      : await this.getOrCreateAccount(tx, { type: 'suspense', currency: args.currency });
    return this.post(tx, {
      entryType: args.from === 'reserved' ? 'disbursement_release' : 'suspense_release',
      transactionId: args.transactionId,
      postings: [
        { accountId: source, side: 'debit', amount: args.amount },
        { accountId: available, side: 'credit', amount: args.amount },
      ],
    });
  }

  async suspendReservation(tx: Tx, args: { transactionId: string; projectId: string; currency: string; amount: number }): Promise<string> {
    const reserved = await this.getOrCreateAccount(tx, { type: 'project_reserved', projectId: args.projectId, currency: args.currency });
    const suspense = await this.getOrCreateAccount(tx, { type: 'suspense', currency: args.currency });
    return this.post(tx, {
      entryType: 'disbursement_suspension',
      transactionId: args.transactionId,
      postings: [
        { accountId: reserved, side: 'debit', amount: args.amount },
        { accountId: suspense, side: 'credit', amount: args.amount },
      ],
    });
  }

  async postFloatTransfer(tx: Tx, args: { sourceAccountId: string; destinationAccountId: string; currency: string; amount: number; providerFee: number; reference: string }): Promise<string> {
    const fa = await this.feeAccounts(tx, args.currency);
    return this.post(tx, {
      entryType: 'float_transfer',
      reference: args.reference,
      postings: [
        { accountId: args.sourceAccountId, side: 'credit', amount: args.amount },
        { accountId: args.destinationAccountId, side: 'debit', amount: subtract(args.amount, args.providerFee) },
        { accountId: fa.expense, side: 'debit', amount: args.providerFee },
      ],
    });
  }

  async postCashout(tx: Tx, args: { floatAccountId: string; settlementAccountId: string; amount: number; authorId: string; reference: string }): Promise<string> {
    return this.post(tx, {
      entryType: 'cashout',
      authorId: args.authorId,
      reference: args.reference,
      postings: [
        { accountId: args.floatAccountId, side: 'credit', amount: args.amount },
        { accountId: args.settlementAccountId, side: 'debit', amount: args.amount },
      ],
    });
  }

  async postFloatFunding(tx: Tx, args: { floatAccountId: string; currency: string; amount: number; authorId: string; justification: string; reference?: string }): Promise<string> {
    const capital = await this.getOrCreateAccount(tx, { type: 'business_capital', currency: args.currency });
    return this.post(tx, {
      entryType: 'float_funding',
      authorId: args.authorId,
      justification: args.justification,
      reference: args.reference ?? null,
      postings: [
        { accountId: args.floatAccountId, side: 'debit', amount: args.amount },
        { accountId: capital, side: 'credit', amount: args.amount },
      ],
    });
  }

  async postProjectFunding(tx: Tx, args: { projectId: string; currency: string; amount: number; authorId: string; justification: string; reference?: string }): Promise<string> {
    const capital = await this.getOrCreateAccount(tx, { type: 'business_capital', currency: args.currency });
    const available = await this.getOrCreateAccount(tx, { type: 'project_available', projectId: args.projectId, currency: args.currency });
    return this.post(tx, {
      entryType: 'project_funding',
      authorId: args.authorId,
      justification: args.justification,
      reference: args.reference ?? null,
      postings: [
        { accountId: capital, side: 'debit', amount: args.amount },
        { accountId: available, side: 'credit', amount: args.amount },
      ],
    });
  }

  async postAdjustment(tx: Tx, args: { postings: Posting[]; authorId: string; justification: string; discrepancyId?: string; reference?: string; transactionId?: string }): Promise<string> {
    return this.post(tx, {
      entryType: 'adjustment',
      authorId: args.authorId,
      justification: args.justification,
      discrepancyId: args.discrepancyId ?? null,
      reference: args.reference ?? null,
      transactionId: args.transactionId ?? null,
      postings: args.postings,
    });
  }

  // ------------------------------------------------------------------ reads

  async projectBalances(exec: Executor, projectId: string): Promise<{ currency: string; available: number; reserved: number }[]> {
    const accounts = await exec
      .selectFrom('ledger_account')
      .select(['id', 'type', 'currency_code'])
      .where('project_id', '=', projectId)
      .execute();
    const byCurrency = new Map<string, { currency: string; available: number; reserved: number }>();
    for (const a of accounts) {
      const entry = byCurrency.get(a.currency_code) ?? { currency: a.currency_code, available: 0, reserved: 0 };
      const bal = await this.balance(exec, a.id);
      if (a.type === 'project_available') entry.available = bal;
      if (a.type === 'project_reserved') entry.reserved = bal;
      byCurrency.set(a.currency_code, entry);
    }
    return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  }

  /** Total float per currency against project available + reserved + suspense (spec 4.8). */
  async coverage(exec: Executor, currency: string): Promise<{ float: number; encumbered: number; ratio: number | null }> {
    const accounts = await exec.selectFrom('ledger_account').select(['id', 'type']).where('currency_code', '=', currency).execute();
    let float = 0, encumbered = 0;
    for (const a of accounts) {
      if (a.type === 'float') float = sum(float, await this.balance(exec, a.id));
      if (a.type === 'project_available' || a.type === 'project_reserved' || a.type === 'suspense') encumbered = sum(encumbered, await this.balance(exec, a.id));
    }
    return { float, encumbered, ratio: ratio(float, encumbered) };
  }

  async entriesForTransaction(exec: Executor, transactionId: string) {
    const entries = await exec.selectFrom('ledger_entry').selectAll().where('transaction_id', '=', transactionId).orderBy('created_at').execute();
    const ids = entries.map((e) => e.id);
    const postings = ids.length
      ? await exec
          .selectFrom('ledger_posting as p')
          .innerJoin('ledger_account as a', 'a.id', 'p.account_id')
          .select(['p.entry_id', 'p.account_id', 'p.side', 'p.amount', 'a.type as account_type', 'a.currency_code'])
          .where('p.entry_id', 'in', ids)
          .orderBy('p.id')
          .execute()
      : [];
    return entries.map((e) => ({ ...e, postings: postings.filter((p) => p.entry_id === e.id) }));
  }

  async entriesForAccount(exec: Executor, accountId: string, limit = 50, before?: number) {
    let q = exec
      .selectFrom('ledger_posting as p')
      .innerJoin('ledger_entry as e', 'e.id', 'p.entry_id')
      .select(['p.id', 'p.entry_id', 'p.side', 'p.amount', 'e.entry_type', 'e.occurred_at', 'e.transaction_id', 'e.author_id', 'e.justification', 'e.reference', 'e.discrepancy_id'])
      .where('p.account_id', '=', accountId)
      .orderBy('p.id', 'desc')
      .limit(limit);
    if (before) q = q.where('p.id', '<', before);
    return q.execute();
  }
}
