import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { DB_TOKEN, type Db } from '../db/database';
import { parseBody } from '../http/validation';
import { LedgerService } from '../ledger/ledger.service';
import { TreasuryService } from '../treasury/treasury.service';
import { ApprovalService } from './approval.service';
import { SessionGuard, type ConsoleRequest } from './session.guard';
import { confirmationSchema, withConfirmation } from './confirmed-operation';
import { ConfirmationService } from '../admin-auth/confirmation.service';
import { subtract } from '../money/money';

const decisionSchema = z.object({ decision: z.enum(['approve', 'decline']), reason: z.string().max(2000).default(''), confirmation: confirmationSchema.optional() });

/** Home cards (console spec 4.2) and the approval queue (4.3). Each card appears only where the administrator holds its permission. */
@Controller('console')
@UseGuards(SessionGuard)
export class HomeController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly treasury: TreasuryService,
    private readonly approvals: ApprovalService,
    private readonly confirmations: ConfirmationService,
  ) {}

  @Get('home')
  async home(@Req() req: ConsoleRequest) {
    const auth = req.auth;
    const cards: Record<string, unknown> = {};
    const approvals = await this.approvals.pending(req.principal.administratorId, auth.permissions());
    cards.awaiting_your_approval = approvals.filter((a) => a.can_act).map((a) => ({ id: a.id, type: a.type, summary: a.summary, amount: a.amount, currency: a.currency_code, initiator: a.initiator_name, created_at: a.created_at }));
    if (auth.has('oversight.alerts.read')) {
      const { rows } = await sql<{ severity: string; n: number }>`select severity, count(*)::int as n from alert where status in ('open', 'acknowledged') group by 1`.execute(this.db);
      const recent = await this.db.selectFrom('alert').select(['id', 'title', 'severity', 'raised_at', 'action_reference']).where('status', 'in', ['open', 'acknowledged']).where('severity', '=', 'critical').orderBy('raised_at', 'desc').limit(5).execute();
      cards.open_alerts = { by_severity: Object.fromEntries(rows.map((r) => [r.severity, r.n])), recent_critical: recent };
    }
    if (auth.has('treasury.read_float')) {
      const scope = auth.providerScope('treasury.read_float');
      const floats = await this.treasury.floatAccounts(this.db, scope);
      cards.float_cover = { scoped: scope !== null, accounts: floats.filter((f) => f.band !== 'healthy').map((f) => ({ id: f.id, provider: f.providerAccountName, country: f.countryCode, currency: f.currency, direction: f.direction, cover_hours: f.coverHours, band: f.band, free_liquidity: f.freeLiquidity })) };
      cards.coverage_ratio = await this.treasury.coverageByCurrency(this.db);
    }
    if (auth.has('reconciliation.read')) {
      const { rows } = await sql<{ type: string; n: number }>`select type, count(*)::int as n from discrepancy where status <> 'resolved' group by 1`.execute(this.db);
      const mine = await this.db.selectFrom('discrepancy').select(['id', 'type', 'subject_reference', 'difference', 'currency_code']).where('assignee_id', '=', req.principal.administratorId).where('status', '<>', 'resolved').limit(10).execute();
      cards.open_discrepancies = { by_type: Object.fromEntries(rows.map((r) => [r.type, r.n])), assigned_to_me: mine };
    }
    if (auth.has('oversight.reports')) {
      const scope = auth.projectScope('oversight.reports');
      const scopeFilter = scope ? sql`and project_id in (${sql.join(scope.length ? scope : ['00000000-0000-0000-0000-000000000000'])})` : sql``;
      const { rows } = await sql<{ direction: string; currency_code: string; n: number; value: number; succeeded: number; terminal: number }>`
        select direction, currency_code, count(*)::int as n, coalesce(sum(requested_amount), 0)::bigint as value,
               count(*) filter (where state = 'succeeded')::int as succeeded, count(*) filter (where terminal_at is not null)::int as terminal
          from transaction where created_at > date_trunc('day', now()) ${scopeFilter} group by 1, 2`.execute(this.db);
      const { rows: base } = await sql<{ direction: string; rate: number | null }>`
        select direction, (count(*) filter (where state = 'succeeded'))::float / nullif(count(*) filter (where terminal_at is not null), 0) as rate
          from transaction where created_at > now() - interval '7 days' and created_at < date_trunc('day', now()) ${scopeFilter} group by 1`.execute(this.db);
      cards.todays_activity = { scoped: scope !== null, rows: rows.map((r) => ({ ...r, success_rate: r.terminal ? r.succeeded / r.terminal : null, baseline_success_rate: base.find((b) => b.direction === r.direction)?.rate ?? null })) };
      const { rows: earn } = await sql<{ currency_code: string; platform: number; processing: number; provider: number }>`
        select currency_code, coalesce(sum(platform_fee), 0)::bigint as platform, coalesce(sum(processing_fee), 0)::bigint as processing, coalesce(sum(actual_provider_fee), 0)::bigint as provider
          from transaction where state = 'succeeded' and terminal_at > date_trunc('month', now()) ${scopeFilter} group by 1`.execute(this.db);
      cards.earnings = { period: 'month_to_date', scoped: scope !== null, rows: earn.map((e) => ({ currency: e.currency_code, platform_revenue: e.platform, margin: subtract(e.processing, e.provider) })) };
    }
    if (auth.has('providers.read')) {
      cards.provider_status = await this.db.selectFrom('provider_account').select(['id', 'name', 'status']).orderBy('name').execute();
    }
    return { cards };
  }

  @Get('approvals')
  async approvalQueue(@Req() req: ConsoleRequest) {
    return { requests: await this.approvals.pending(req.principal.administratorId, req.auth.permissions()) };
  }

  @Get('approvals/:id')
  async approval(@Param('id') id: string) {
    return this.db.selectFrom('approval_request as r').innerJoin('administrator as a', 'a.id', 'r.initiated_by').selectAll('r').select('a.name as initiator_name').where('r.id', '=', id).executeTakeFirstOrThrow();
  }

  @Post('approvals/:id/decision')
  @HttpCode(200)
  async decide(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { decision, reason, confirmation } = parseBody(decisionSchema, body);
    const values = { id, decision, reason };
    if (decision === 'approve') {
      await withConfirmation(this.db, this.confirmations, req.principal, 'approval.approve', values, confirmation, async (_tx, confirmationId) => {
        await this.approvals.decide(id, req.principal.administratorId, decision, reason, req.auth.permissions(), confirmationId);
      });
    } else {
      await this.approvals.decide(id, req.principal.administratorId, decision, reason, req.auth.permissions());
    }
    return { ok: true };
  }
}
