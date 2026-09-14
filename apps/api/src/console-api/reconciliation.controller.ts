import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db } from '../db/database';
import { nonEmpty, parseBody } from '../http/validation';
import { JobQueue } from '../jobs/job-queue';
import { DiscrepancyService } from '../reconciliation/discrepancy.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { StatementService } from '../reconciliation/statement.service';
import { ConfirmationService } from '../admin-auth/confirmation.service';
import { confirmationSchema, withConfirmation } from './confirmed-operation';
import { RequirePermission, SessionGuard, type ConsoleRequest } from './session.guard';

const uploadSchema = z.object({ provider_account_id: z.string().uuid(), filename: nonEmpty(256), content_base64: z.string().min(1), period_start: z.string().datetime(), period_end: z.string().datetime() });
const runSchema = z.object({ provider_account_id: z.string().uuid(), period_start: z.string().datetime(), period_end: z.string().datetime() });
const decisionSchema = z.object({ decision: z.enum(['accepted', 'rejected']), comment: nonEmpty(2000), follow: z.enum(['none', 'correct_transaction', 'post_adjustment']).default('none'), adjustment: z.object({ postings: z.array(z.object({ account_id: z.string().uuid(), side: z.enum(['debit', 'credit']), amount: z.number().int().positive() })).min(2), justification: nonEmpty(1000) }).optional(), confirmation: confirmationSchema.optional() });

/** Reconciliation (console spec 9): runs, statement upload, the discrepancy queue and detail with its decision. */
@Controller('console/reconciliation')
@UseGuards(SessionGuard)
export class ReconciliationController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly runs: ReconciliationService,
    private readonly statements: StatementService,
    private readonly discrepancies: DiscrepancyService,
    private readonly queue: JobQueue,
    private readonly confirmations: ConfirmationService,
  ) {}

  private scope(req: ConsoleRequest) {
    return req.auth.providerScope('reconciliation.read');
  }

  @Get('runs')
  @RequirePermission('reconciliation.read')
  async list(@Req() req: ConsoleRequest) {
    return { runs: await this.runs.runsFor(this.scope(req)), scoped: this.scope(req) !== null };
  }

  @Get('runs/:id')
  @RequirePermission('reconciliation.read')
  async run(@Param('id') id: string, @Req() req: ConsoleRequest) {
    const run = await this.db.selectFrom('reconciliation_run').selectAll().where('id', '=', id).executeTakeFirst();
    if (!run || !req.auth.canReachProvider('reconciliation.read', run.provider_account_id)) throw new PlatformError('NOT_FOUND', 'No such run.');
    return { run, discrepancies: await this.discrepancies.list({ run: id }, null, 500) };
  }

  @Post('runs')
  @HttpCode(202)
  @RequirePermission('reconciliation.run')
  async startRun(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const input = parseBody(runSchema, body);
    if (!req.auth.canReachProvider('reconciliation.run', input.provider_account_id)) throw new PlatformError('NOT_FOUND', 'No such provider account.');
    const id = await this.runs.start({ providerAccountId: input.provider_account_id, mode: 'automated', periodStart: new Date(input.period_start), periodEnd: new Date(input.period_end), startedBy: req.principal.administratorId });
    await this.queue.enqueue(this.db, 'reconciliation.run', { runId: id }, { maxAttempts: 1 });
    return { run_id: id };
  }

  @Get('statements')
  @RequirePermission('reconciliation.read')
  async statementList(@Req() req: ConsoleRequest) {
    return { statements: await this.statements.list(this.scope(req)) };
  }

  @Post('statements')
  @HttpCode(201)
  @RequirePermission('reconciliation.upload')
  async upload(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const input = parseBody(uploadSchema, body);
    if (!req.auth.canReachProvider('reconciliation.upload', input.provider_account_id)) throw new PlatformError('NOT_FOUND', 'No such provider account.');
    return this.statements.upload({ providerAccountId: input.provider_account_id, filename: input.filename, content: Buffer.from(input.content_base64, 'base64'), periodStart: new Date(input.period_start), periodEnd: new Date(input.period_end), uploadedBy: req.principal.administratorId });
  }

  /** Confirms an upload and runs the comparison from it. */
  @Post('statements/:id/run')
  @HttpCode(202)
  @RequirePermission('reconciliation.run')
  async runStatement(@Param('id') id: string, @Req() req: ConsoleRequest) {
    const imp = await this.statements.get(id);
    if (!imp || !req.auth.canReachProvider('reconciliation.run', imp.provider_account_id)) throw new PlatformError('NOT_FOUND', 'No such statement.');
    if (imp.run_id) throw new PlatformError('CONFLICT', 'This statement was already run.', { details: { run: imp.run_id } });
    const runId = await this.runs.start({ providerAccountId: imp.provider_account_id, mode: 'manual', statementImportId: imp.id, periodStart: imp.declared_period_start, periodEnd: imp.declared_period_end, startedBy: req.principal.administratorId });
    await this.queue.enqueue(this.db, 'reconciliation.run', { runId }, { maxAttempts: 1 });
    return { run_id: runId };
  }

  @Get('discrepancies')
  @RequirePermission('reconciliation.read')
  async discrepancyList(@Query() q: Record<string, string>, @Req() req: ConsoleRequest) {
    return { discrepancies: await this.discrepancies.list({ run: q.run, type: q.type, status: q.status, assignee: q.assignee, providerAccountId: q.provider_account, recurred: q.recurred === 'true' }, this.scope(req)), scoped: this.scope(req) !== null };
  }

  @Get('discrepancies/:id')
  @RequirePermission('reconciliation.read')
  async discrepancy(@Param('id') id: string, @Req() req: ConsoleRequest) {
    const d = await this.discrepancies.detail(id);
    if (!req.auth.canReachProvider('reconciliation.read', d.provider_account_id)) throw new PlatformError('NOT_FOUND', 'No such discrepancy.');
    return d;
  }

  @Post('discrepancies/:id/assign')
  @HttpCode(200)
  @RequirePermission('reconciliation.decide')
  async assign(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { assignee_id } = parseBody(z.object({ assignee_id: z.string().uuid().nullable() }), body);
    await this.discrepancies.assign(id, assignee_id, req.principal.administratorId);
    return { ok: true };
  }

  @Post('discrepancies/:id/comments')
  @HttpCode(201)
  @RequirePermission('reconciliation.read')
  async comment(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { body: text } = parseBody(z.object({ body: nonEmpty(2000) }), body);
    await this.discrepancies.comment(id, req.principal.administratorId, text);
    return { ok: true };
  }

  @Get('discrepancies/:id/preview')
  @RequirePermission('reconciliation.decide')
  async previewDecision(@Param('id') id: string, @Query('follow') follow: string | undefined) {
    return this.discrepancies.preview(id, (follow as 'none' | 'correct_transaction' | 'post_adjustment') ?? 'none');
  }

  @Post('discrepancies/:id/decision')
  @HttpCode(200)
  @RequirePermission('reconciliation.decide')
  async decide(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, ...input } = parseBody(decisionSchema, body);
    const decision = { decision: input.decision, comment: input.comment, follow: input.follow, adjustment: input.adjustment ? { postings: input.adjustment.postings.map((p) => ({ accountId: p.account_id, side: p.side, amount: p.amount })), justification: input.adjustment.justification } : undefined };
    if (input.follow === 'none') return this.discrepancies.decide(id, req.principal.administratorId, decision);
    // A decision that posts money or corrects a transaction is confirmed with a code.
    return withConfirmation(this.db, this.confirmations, req.principal, 'discrepancy.decide', { id, ...input }, confirmation, async (_tx, c) => this.discrepancies.decide(id, req.principal.administratorId, { ...decision, confirmationId: c }));
  }
}
