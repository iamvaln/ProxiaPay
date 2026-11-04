import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { fieldInvalid, PlatformError } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { DB_TOKEN, type Db } from '../db/database';
import { parseBody } from '../http/validation';
import { LedgerService } from '../ledger/ledger.service';
import { margin } from '../money/money';
import { NotificationService } from '../notifications/notification.service';
import { TransactionReader } from '../transactions/transaction-reader';
import { TransactionService } from '../transactions/transaction.service';
import { AuditService } from '../audit/audit.service';
import { RequirePermission, SessionGuard, type ConsoleRequest } from './session.guard';
import { ExportService } from './export.service';
import { pageQuerySchema, paginate, prefixPattern } from './pagination';

const searchSchema = pageQuerySchema.extend({
  state: z.string().optional(), reconciliation_status: z.string().optional(), direction: z.enum(['collection', 'disbursement']).optional(),
  project: z.string().uuid().optional(), route: z.string().uuid().optional(), country: z.string().max(2).optional(), payment_method: z.string().max(16).optional(),
  provider_account: z.string().uuid().optional(), currency: z.string().max(3).optional(), failure_reason: z.string().max(64).optional(),
  created_after: z.string().datetime().optional(), created_before: z.string().datetime().optional(),
  amount_min: z.coerce.number().int().optional(), amount_max: z.coerce.number().int().optional(),
});

const previewsSchema = pageQuerySchema.extend({
  status: z.string().optional(), project: z.string().uuid().optional(), msisdn: z.string().max(32).optional(),
  created_after: z.string().datetime().optional(), created_before: z.string().datetime().optional(),
});

/** Transaction search, detail, previews and global search (console spec 3.2, 5). Scope is applied in the query, never after. */
@Controller('console')
@UseGuards(SessionGuard)
export class ConsoleTransactionsController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly reader: TransactionReader,
    private readonly transactions: TransactionService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly exports: ExportService,
  ) {}

  private scopeIds(req: ConsoleRequest): string[] | null {
    const scope = req.auth.projectScope('transactions.read');
    return scope === null ? null : scope.length ? scope : ['00000000-0000-0000-0000-000000000000'];
  }

  private baseQuery(req: ConsoleRequest, q: z.infer<typeof searchSchema>) {
    let query = this.db
      .selectFrom('transaction as t')
      .innerJoin('route as r', 'r.id', 't.route_id')
      .innerJoin('project as p', 'p.id', 't.project_id')
      .leftJoin('transaction_attempt as a', 'a.id', 't.current_attempt_id')
      .select(['t.id', 't.reference', 't.project_reference', 't.direction', 't.state', 't.reconciliation_status', 't.currency_code', 't.requested_amount', 't.charged_amount', 't.settled_amount', 't.failure_reason', 't.created_at', 't.terminal_at', 't.msisdn_masked', 't.processing_fee', 't.platform_fee', 't.processing_fee_bearer', 't.platform_fee_bearer',
        'p.name as project_name', 'p.id as project_id', 'r.country_code', 'r.payment_method_code', 'a.provider_reference', 'a.operator_reference', 'a.provider_account_id']);
    const scope = this.scopeIds(req);
    if (scope) query = query.where('t.project_id', 'in', scope);
    if (q.state) query = query.where('t.state', 'in', q.state.split(','));
    if (q.reconciliation_status) query = query.where('t.reconciliation_status', '=', q.reconciliation_status);
    if (q.direction) query = query.where('t.direction', '=', q.direction);
    if (q.project) query = query.where('t.project_id', '=', q.project);
    if (q.route) query = query.where('t.route_id', '=', q.route);
    if (q.country) query = query.where('r.country_code', '=', q.country);
    if (q.payment_method) query = query.where('r.payment_method_code', '=', q.payment_method);
    if (q.provider_account) query = query.where('a.provider_account_id', '=', q.provider_account);
    if (q.currency) query = query.where('t.currency_code', '=', q.currency);
    if (q.q) {
      const prefix = prefixPattern(q.q);
      query = query.where((eb) => eb.or([eb('t.reference', 'like', prefix), eb('t.project_reference', 'like', prefix), eb('a.provider_reference', 'like', prefix), eb('a.operator_reference', 'like', prefix)]));
    }
    if (q.failure_reason) query = query.where('t.failure_reason', '=', q.failure_reason);
    if (q.created_after) query = query.where('t.created_at', '>', new Date(q.created_after));
    if (q.created_before) query = query.where('t.created_at', '<', new Date(q.created_before));
    if (q.amount_min != null) query = query.where('t.requested_amount', '>=', q.amount_min);
    if (q.amount_max != null) query = query.where('t.requested_amount', '<=', q.amount_max);
    return query;
  }

  @Get('transactions')
  @RequirePermission('transactions.read')
  async search(@Query() query: Record<string, string>, @Req() req: ConsoleRequest) {
    const q = parseBody(searchSchema, query);
    if (q.sort === 'amount' && !q.currency) throw fieldInvalid('sort', 'sort: amount sorts only within one currency; set a currency filter');
    const page = await paginate(this.baseQuery(req, q), q, { sorts: { created: 't.created_at', amount: 't.requested_amount' }, defaultSort: 'created', id: 't.id' });
    return { ...page, scoped: this.scopeIds(req) !== null };
  }

  @Get('transactions/export')
  @RequirePermission('oversight.export')
  async export(@Query() query: Record<string, string>, @Req() req: ConsoleRequest) {
    req.auth.require('transactions.read');
    const q = parseBody(searchSchema, query);
    const { page: _p, page_size: _s, sort: _o, order: _d, ...filters } = query;
    const rows = await this.baseQuery(req, q).orderBy('t.created_at', 'desc').orderBy('t.id', 'desc').limit(10_000).execute();
    const columns = ['reference', 'project_reference', 'project_name', 'direction', 'country_code', 'payment_method_code', 'currency_code', 'requested_amount', 'charged_amount', 'settled_amount', 'state', 'reconciliation_status', 'failure_reason', 'provider_reference', 'operator_reference', 'created_at', 'terminal_at'];
    return this.exports.produce(req.principal.administratorId, 'transactions', filters, columns, rows as Record<string, unknown>[]);
  }

  /**
   * Global search (console spec 3.2): any reference the platform knows, or a telephone number under its own permission.
   * Not paged: it stops at its caps (50 transactions, 20 previews by reference, 50 of each by number) and says so with `capped`.
   */
  @Get('search')
  @RequirePermission('transactions.read')
  async globalSearch(@Query('q') raw: string | undefined, @Req() req: ConsoleRequest) {
    const q = (raw ?? '').trim();
    if (!q) return { transactions: [], previews: [], capped: false };
    const scope = this.scopeIds(req);
    const txnBase = this.db.selectFrom('transaction as t').leftJoin('transaction_attempt as a', 'a.id', 't.current_attempt_id').select(['t.id', 't.reference', 't.project_id', 't.state']);
    const previewBase = this.db.selectFrom('preview').select(['id', 'reference', 'project_id', 'status as state']);
    // One row past the cap is fetched, so that hitting the cap exactly is told apart from stopping at it.
    const cut = <R>(rows: R[], cap: number) => ({ rows: rows.slice(0, cap), capped: rows.length > cap });
    const looksLikeNumber = /^\+?\d{6,15}$/.test(q.replace(/[\s().-]/g, ''));
    if (looksLikeNumber) {
      req.auth.require('transactions.read_identifiers');
      const digits = q.replace(/[\s().-]/g, '');
      const candidates = [digits.startsWith('+') ? digits : `+${digits}`];
      for (const c of await this.db.selectFrom('country').select('dialling_prefix').execute()) {
        if (!digits.startsWith('+')) candidates.push(`${c.dialling_prefix}${digits.replace(/^0/, '')}`);
      }
      const indexes = candidates.map((m) => this.crypto.blindIndex(m));
      let qb = txnBase.where('t.msisdn_index', 'in', indexes).orderBy('t.created_at', 'desc').limit(51);
      if (scope) qb = qb.where('t.project_id', 'in', scope);
      let pb = previewBase.where('msisdn_index', 'in', indexes).orderBy('created_at', 'desc').limit(51);
      if (scope) pb = pb.where('project_id', 'in', scope);
      const transactions = cut(await qb.execute(), 50);
      const previews = cut(await pb.execute(), 50);
      await this.audit.record(this.db, { actorId: req.principal.administratorId, action: 'search.by_identifier', subjectType: 'payer', subjectId: `…${digits.slice(-4)}`, next: { matches: transactions.rows.length + previews.rows.length } });
      return { transactions: transactions.rows, previews: previews.rows, capped: transactions.capped || previews.capped };
    }
    let qb = txnBase.where((eb) => eb.or([eb('t.reference', '=', q), eb('t.project_reference', '=', q), eb('a.provider_reference', '=', q), eb('a.operator_reference', '=', q)])).limit(51);
    if (scope) qb = qb.where('t.project_id', 'in', scope);
    let pb = previewBase.where((eb) => eb.or([eb('reference', '=', q), eb('project_reference', '=', q)])).limit(21);
    if (scope) pb = pb.where('project_id', 'in', scope);
    const transactions = cut(await qb.execute(), 50);
    const previews = cut(await pb.execute(), 20);
    return { transactions: transactions.rows, previews: previews.rows, capped: transactions.capped || previews.capped };
  }

  @Get('transactions/:reference')
  @RequirePermission('transactions.read')
  async detail(@Param('reference') reference: string, @Req() req: ConsoleRequest) {
    const found = await this.db.selectFrom('transaction').select(['id', 'project_id']).where('reference', '=', reference).executeTakeFirst();
    if (!found || !req.auth.canReachProject('transactions.read', found.project_id)) throw new PlatformError('NOT_FOUND', 'No such transaction.');
    const { txn, attempt, route } = await this.reader.load(this.db, found.id);
    const api = this.reader.toApi(txn, attempt, route, { revealMsisdn: false, revealAction: false });
    const project = await this.db.selectFrom('project').select(['id', 'name', 'code']).where('id', '=', txn.project_id).executeTakeFirstOrThrow();
    const attempts = await this.db.selectFrom('transaction_attempt as a').innerJoin('provider_account as pa', 'pa.id', 'a.provider_account_id').selectAll('a').select('pa.name as provider_account_name').where('a.transaction_id', '=', txn.id).orderBy('a.sequence').execute();
    const events = await this.db.selectFrom('transaction_event as e').leftJoin('administrator as ad', 'ad.id', 'e.actor_id').selectAll('e').select('ad.name as actor_name').where('e.transaction_id', '=', txn.id).orderBy('e.id').execute();
    const routeVersion = await this.db.selectFrom('route_version').selectAll().where('id', '=', txn.route_version_id).executeTakeFirstOrThrow();
    const entitlementVersion = await this.db.selectFrom('entitlement_version').selectAll().where('id', '=', txn.entitlement_version_id).executeTakeFirstOrThrow();
    const entries = await this.ledger.entriesForTransaction(this.db, txn.id);
    const deliveries = await this.notifications.deliveriesForTransaction(txn.id);
    const discrepancies = await this.db.selectFrom('discrepancy').select(['id', 'type', 'status', 'difference', 'currency_code']).where('transaction_id', '=', txn.id).execute();
    const original = txn.original_transaction_id ? await this.db.selectFrom('transaction').select('reference').where('id', '=', txn.original_transaction_id).executeTakeFirst() : null;
    return {
      transaction: api,
      project,
      amounts: {
        requested: txn.requested_amount, charged: txn.charged_amount, settled: txn.settled_amount, expected_settled: txn.expected_settled_amount,
        processing_fee: txn.processing_fee, platform_fee: txn.platform_fee, processing_fee_bearer: txn.processing_fee_bearer, platform_fee_bearer: txn.platform_fee_bearer,
        expected_provider_fee: txn.expected_provider_fee, actual_provider_fee: txn.actual_provider_fee, margin: margin(txn.processing_fee, txn.actual_provider_fee),
        provider_fee_differs: txn.actual_provider_fee != null && txn.actual_provider_fee !== txn.expected_provider_fee, currency: txn.currency_code, reserved_amount: txn.reserved_amount,
      },
      timeline: events.map((e) => ({ id: e.id, prior_state: e.prior_state, new_state: e.new_state, source: e.source, actor: e.actor_name, occurred_at: e.occurred_at, detail: e.detail })),
      attempts: attempts.map((a) => ({ id: a.id, sequence: a.sequence, provider_account: a.provider_account_name, provider_account_id: a.provider_account_id, provider_reference: a.provider_reference, operator_reference: a.operator_reference, terms: a.binding_snapshot, state: a.state, actual_provider_fee: a.actual_provider_fee, failure_reason: a.failure_reason, provider_error_code: a.provider_error_code, started_at: a.started_at, ended_at: a.ended_at, duration_ms: a.ended_at ? a.ended_at.getTime() - a.started_at.getTime() : null, fees_recorded: a.id === txn.current_attempt_id && txn.state === 'succeeded' })),
      configuration: { route_version: routeVersion, entitlement_version: entitlementVersion, terms_snapshot: txn.terms_snapshot, limits_snapshot: txn.limits_snapshot },
      payer: { masked: txn.msisdn_masked, name: txn.counterparty_name, can_reveal: req.auth.has('transactions.read_identifiers') },
      ledger_entries: entries,
      notifications: deliveries,
      discrepancies,
      refund_of: original?.reference ?? null,
      exchanges_available: req.auth.has('transactions.read_exchanges'),
      correlation_id: txn.correlation_id,
    };
  }

  @Post('transactions/:reference/reveal-identifier')
  @HttpCode(200)
  @RequirePermission('transactions.read_identifiers')
  async reveal(@Param('reference') reference: string, @Req() req: ConsoleRequest) {
    const txn = await this.db.selectFrom('transaction').select(['id', 'project_id', 'msisdn_ciphertext', 'counterparty_email']).where('reference', '=', reference).executeTakeFirst();
    if (!txn || !req.auth.canReachProject('transactions.read_identifiers', txn.project_id)) throw new PlatformError('NOT_FOUND', 'No such transaction.');
    await this.audit.record(this.db, { actorId: req.principal.administratorId, action: 'transaction.reveal_identifier', subjectType: 'transaction', subjectId: reference });
    return { msisdn: this.crypto.openString(txn.msisdn_ciphertext, 'msisdn'), email: txn.counterparty_email };
  }

  @Get('transactions/:reference/exchanges')
  @RequirePermission('transactions.read_exchanges')
  async exchanges(@Param('reference') reference: string, @Req() req: ConsoleRequest) {
    const txn = await this.db.selectFrom('transaction').select(['id', 'project_id']).where('reference', '=', reference).executeTakeFirst();
    if (!txn || !req.auth.canReachProject('transactions.read_exchanges', txn.project_id)) throw new PlatformError('NOT_FOUND', 'No such transaction.');
    await this.audit.record(this.db, { actorId: req.principal.administratorId, action: 'transaction.read_exchanges', subjectType: 'transaction', subjectId: reference });
    const payloads = await this.db.selectFrom('provider_payload').selectAll().where('transaction_id', '=', txn.id).orderBy('created_at').execute();
    return { exchanges: payloads };
  }

  @Post('transactions/:reference/recheck')
  @HttpCode(202)
  @RequirePermission('transactions.recheck')
  async recheck(@Param('reference') reference: string, @Req() req: ConsoleRequest) {
    await this.transactions.forceRecheck(reference, req.principal.administratorId);
    return { queued: true };
  }

  @Post('transactions/:reference/notifications/:deliveryId/replay')
  @HttpCode(202)
  @RequirePermission('transactions.replay_notification')
  async replay(@Param('deliveryId') deliveryId: string, @Req() req: ConsoleRequest) {
    return { delivery_id: await this.notifications.replay(deliveryId, req.principal.administratorId) };
  }

  @Get('previews')
  @RequirePermission('transactions.read')
  async previews(@Query() query: Record<string, string>, @Req() req: ConsoleRequest) {
    const q = parseBody(previewsSchema, query);
    const scope = this.scopeIds(req);
    let qb = this.db.selectFrom('preview as p').innerJoin('project as pr', 'pr.id', 'p.project_id').innerJoin('route as r', 'r.id', 'p.route_id').leftJoin('transaction as t', 't.id', 'p.transaction_id')
      .select(['p.id', 'p.reference', 'p.direction', 'p.status', 'p.requested_amount', 'p.charged_amount', 'p.currency_code', 'p.msisdn_masked', 'p.project_reference', 'p.payer_action', 'p.created_at', 'p.expires_at', 'pr.name as project_name', 'r.country_code', 'r.payment_method_code', 't.reference as transaction_reference']);
    if (scope) qb = qb.where('p.project_id', 'in', scope);
    if (q.status) qb = qb.where('p.status', '=', q.status);
    if (q.project) qb = qb.where('p.project_id', '=', q.project);
    if (q.msisdn) qb = qb.where('p.msisdn_masked', '=', q.msisdn);
    if (q.q) qb = qb.where('p.reference', 'like', prefixPattern(q.q));
    if (q.created_after) qb = qb.where('p.created_at', '>', new Date(q.created_after));
    if (q.created_before) qb = qb.where('p.created_at', '<', new Date(q.created_before));
    // Payers who previewed and let it lapse: within the administrator's projects, 21 fetched so a stop at 20 can be told.
    const inScope = scope ? sql`and project_id in (${sql.join(scope)})` : sql``;
    const { rows: repeatRows } = await sql<{ msisdn_masked: string; n: number }>`select msisdn_masked, count(*)::int as n from preview where status = 'expired' and created_at > now() - interval '24 hours' ${inScope} group by 1 having count(*) >= 3 order by 2 desc, 1 limit 21`.execute(this.db);
    return { ...(await paginate(qb, q, { sorts: { created: 'p.created_at' }, defaultSort: 'created', id: 'p.id' })), repeat_unconfirmed: repeatRows.slice(0, 20), repeat_capped: repeatRows.length > 20, scoped: scope !== null };
  }
}
