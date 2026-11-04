import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { DB_TOKEN, type Db } from '../db/database';
import { parseBody } from '../http/validation';
import { TreasuryService, type FloatAccountView } from '../treasury/treasury.service';
import { HomeService } from './home.service';
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
    private readonly treasury: TreasuryService,
    private readonly approvals: ApprovalService,
    private readonly confirmations: ConfirmationService,
    private readonly homeService: HomeService,
  ) {}

  @Get('home')
  async home(@Req() req: ConsoleRequest) {
    const auth = req.auth;
    const cards: Record<string, unknown> = {};
    const approvals = await this.approvals.pending(req.principal.administratorId, auth.permissions());
    cards.awaiting_your_approval = approvals.filter((a) => a.can_act).map((a) => ({ id: a.id, type: a.type, summary: a.summary, amount: a.amount, currency: a.currency_code, initiator: a.initiator_name, created_at: a.created_at }));
    const alerts = auth.has('oversight.alerts.read');
    const providers = auth.has('providers.read');
    if (alerts || providers) cards.verdict = { problems: await this.homeService.problems({ alerts, providers }) };
    if (auth.has('oversight.reports')) {
      const scope = auth.projectScope('oversight.reports');
      cards.success_rate = await this.homeService.overallSuccess(scope);
      cards.collected_today = await this.homeService.collectedToday(scope);
      cards.undetermined = await this.homeService.undetermined(scope);
      cards.routes = { scoped: scope !== null, series: await this.homeService.routeSeries(scope, alerts) };
      const scopeFilter = scope ? sql`and project_id in (${sql.join(scope.length ? scope : ['00000000-0000-0000-0000-000000000000'])})` : sql``;
      const { rows: earn } = await sql<{ currency_code: string; platform: number; processing: number; provider: number }>`
        select currency_code, coalesce(sum(platform_fee), 0)::bigint as platform, coalesce(sum(processing_fee), 0)::bigint as processing, coalesce(sum(actual_provider_fee), 0)::bigint as provider
          from transaction where state = 'succeeded' and terminal_at > date_trunc('month', now()) ${scopeFilter} group by 1`.execute(this.db);
      cards.earnings = { period: 'month_to_date', scoped: scope !== null, rows: earn.map((e) => ({ currency: e.currency_code, platform_revenue: e.platform, margin: subtract(e.processing, e.provider) })) };
    }
    if (auth.has('treasury.read_float')) {
      const views = await this.treasury.floatAccounts(this.db, auth.providerScope('treasury.read_float'));
      let lowest: FloatAccountView | null = null;
      for (const f of views) if (f.coverHours !== null && (lowest === null || f.coverHours < (lowest.coverHours as number))) lowest = f;
      cards.lowest_float = lowest && { scoped: auth.providerScope('treasury.read_float') !== null, id: lowest.id, provider: lowest.providerAccountName, country: lowest.countryCode, currency: lowest.currency, direction: lowest.direction, cover_hours: lowest.coverHours, band: lowest.band, proposed_transfer: lowest.proposedTransfer };
    }
    if (auth.has('reconciliation.read')) {
      cards.assigned_discrepancies = await this.db.selectFrom('discrepancy').select(['id', 'type', 'subject_reference', 'difference', 'currency_code']).where('assignee_id', '=', req.principal.administratorId).where('status', '<>', 'resolved').limit(10).execute();
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
