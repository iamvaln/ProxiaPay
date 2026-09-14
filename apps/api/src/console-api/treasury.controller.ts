import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db } from '../db/database';
import { nonEmpty, parseBody } from '../http/validation';
import { LedgerService } from '../ledger/ledger.service';
import { TreasuryService } from '../treasury/treasury.service';
import { SettingsService } from '../settings/settings.service';
import { ConfirmationService } from '../admin-auth/confirmation.service';
import { AuditService } from '../audit/audit.service';
import { AlertService } from '../alerts/alert.service';
import { confirmationSchema, withConfirmation } from './confirmed-operation';
import { RequirePermission, SessionGuard, type ConsoleRequest } from './session.guard';

const transferSchema = z.object({ source_account_id: z.string().uuid(), destination_account_id: z.string().uuid(), amount: z.number().int().positive(), provider_fee: z.number().int().min(0).default(0), provider_reference: z.string().max(128).optional(), note: z.string().max(512).optional(), confirmation: confirmationSchema.optional() });
const cashoutSchema = z.object({ float_account_id: z.string().uuid(), destination: nonEmpty(128), amount: z.number().int().positive(), supporting_document: nonEmpty(512), justification: nonEmpty(1000), confirmation: confirmationSchema.optional() });
const fundingSchema = z.object({ target: z.enum(['float', 'project']), float_account_id: z.string().uuid().optional(), project_id: z.string().uuid().optional(), currency: z.string().length(3), amount: z.number().int().positive(), justification: nonEmpty(1000), reference: z.string().max(128).optional(), confirmation: confirmationSchema.optional() });
const adjustmentSchema = z.object({ postings: z.array(z.object({ account_id: z.string().uuid(), side: z.enum(['debit', 'credit']), amount: z.number().int().positive() })).min(2), justification: nonEmpty(1000), discrepancy_id: z.string().uuid().optional(), reference: z.string().max(128).optional(), confirmation: confirmationSchema.optional() });
const thresholdSchema = z.object({ target_hours: z.number().int().positive(), minimum_hours: z.number().int().positive(), override_amount: z.number().int().min(0).nullable().default(null) });

/** Treasury (console spec 8): balances, float, transfers, cashouts, funding and adjustments. Every action that moves money requires a code. */
@Controller('console/treasury')
@UseGuards(SessionGuard)
export class TreasuryController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly treasury: TreasuryService,
    private readonly settings: SettingsService,
    private readonly confirmations: ConfirmationService,
    private readonly audit: AuditService,
    private readonly alerts: AlertService,
  ) {}

  @Get('balances')
  @RequirePermission('treasury.read_balances')
  async balances(@Req() req: ConsoleRequest) {
    const scope = req.auth.projectScope('treasury.read_balances');
    let q = this.db.selectFrom('project').select(['id', 'name', 'code']).orderBy('name');
    if (scope) q = q.where('id', 'in', scope.length ? scope : ['00000000-0000-0000-0000-000000000000']);
    const projects = await q.execute();
    const out = [];
    for (const p of projects) out.push({ project: p, balances: await this.ledger.projectBalances(this.db, p.id) });
    return { projects: out, scoped: scope !== null, coverage: req.auth.has('treasury.read_float') ? await this.treasury.coverageByCurrency() : undefined };
  }

  @Get('accounts/:id/entries')
  @RequirePermission('treasury.read_balances')
  async entries(@Param('id') id: string, @Query('before') before: string | undefined, @Req() req: ConsoleRequest) {
    const acct = await this.db.selectFrom('ledger_account').selectAll().where('id', '=', id).executeTakeFirst();
    if (!acct) throw new PlatformError('NOT_FOUND', 'No such account.');
    if (acct.project_id && !req.auth.canReachProject('treasury.read_balances', acct.project_id)) throw new PlatformError('NOT_FOUND', 'No such account.');
    if (acct.provider_account_id && !req.auth.canReachProvider('treasury.read_float', acct.provider_account_id)) throw new PlatformError('NOT_FOUND', 'No such account.');
    const entries = await this.ledger.entriesForAccount(this.db, id, 50, before ? Number(before) : undefined);
    const refs = entries.filter((e) => e.transaction_id).map((e) => e.transaction_id!);
    const txns = refs.length ? await this.db.selectFrom('transaction').select(['id', 'reference']).where('id', 'in', refs).execute() : [];
    return { account: acct, balance: await this.ledger.balance(this.db, id), entries: entries.map((e) => ({ ...e, transaction_reference: txns.find((t) => t.id === e.transaction_id)?.reference ?? null })) };
  }

  @Get('project/:projectId/accounts')
  @RequirePermission('treasury.read_balances')
  async projectAccounts(@Param('projectId') projectId: string, @Req() req: ConsoleRequest) {
    if (!req.auth.canReachProject('treasury.read_balances', projectId)) throw new PlatformError('NOT_FOUND', 'No such project.');
    return { accounts: await this.db.selectFrom('ledger_account').select(['id', 'type', 'currency_code']).where('project_id', '=', projectId).execute() };
  }

  @Get('float')
  @RequirePermission('treasury.read_float')
  async float(@Req() req: ConsoleRequest) {
    const scope = req.auth.providerScope('treasury.read_float');
    return { accounts: await this.treasury.floatAccounts(this.db, scope), coverage: await this.treasury.coverageByCurrency(), scoped: scope !== null, other_accounts: await this.db.selectFrom('ledger_account').select(['id', 'type', 'currency_code', 'settlement_destination']).where('type', 'in', ['processing_revenue', 'platform_revenue', 'fee_expense', 'settlement', 'business_capital', 'suspense']).execute() };
  }

  @Get('float/:id')
  @RequirePermission('treasury.read_float')
  async floatDetail(@Param('id') id: string, @Req() req: ConsoleRequest) {
    const all = await this.treasury.floatAccounts(this.db, req.auth.providerScope('treasury.read_float'));
    const acct = all.find((a) => a.id === id);
    if (!acct) throw new PlatformError('NOT_FOUND', 'No such float account.');
    const entries = await this.ledger.entriesForAccount(this.db, id, 50);
    const withdrawable = req.auth.has('treasury.cashout.initiate') ? await this.treasury.withdrawable(this.db, id) : null;
    return { account: acct, entries, withdrawable, paired_collection: all.find((a) => a.providerAccountId === acct.providerAccountId && a.countryCode === acct.countryCode && a.currency === acct.currency && a.direction !== acct.direction) ?? null };
  }

  @Put('float/:id/thresholds')
  @HttpCode(200)
  @RequirePermission('treasury.read_float')
  async thresholds(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const input = parseBody(thresholdSchema, body);
    if (input.minimum_hours >= input.target_hours) throw new PlatformError('FIELD_INVALID', 'The minimum period sits below the target.', { field: 'minimum_hours' });
    await this.db.transaction().execute((tx) => this.treasury.setThreshold(tx, id, { targetHours: input.target_hours, minimumHours: input.minimum_hours, overrideAmount: input.override_amount }, req.principal.administratorId));
    return { ok: true };
  }

  @Get('transfers')
  @RequirePermission('treasury.read_float')
  async transfers() {
    return { transfers: await this.db.selectFrom('float_transfer as t').innerJoin('administrator as a', 'a.id', 't.initiated_by').selectAll('t').select('a.name as initiator').orderBy('t.created_at', 'desc').limit(100).execute() };
  }

  @Post('transfers')
  @HttpCode(201)
  @RequirePermission('treasury.transfer')
  async registerTransfer(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, ...input } = parseBody(transferSchema, body);
    const id = await withConfirmation(this.db, this.confirmations, req.principal, 'float_transfer.register', input, confirmation, (tx, c) =>
      this.treasury.registerTransfer(tx, { sourceAccountId: input.source_account_id, destinationAccountId: input.destination_account_id, amount: input.amount, providerFee: input.provider_fee, providerReference: input.provider_reference, note: input.note, actorId: req.principal.administratorId, confirmationId: c }));
    return { transfer_id: id, status: 'pending' };
  }

  @Get('cashouts')
  @RequirePermission('treasury.read_float')
  async cashouts() {
    return { cashouts: await this.db.selectFrom('cashout as c').innerJoin('administrator as i', 'i.id', 'c.initiated_by').leftJoin('administrator as ap', 'ap.id', 'c.approved_by').selectAll('c').select(['i.name as initiator', 'ap.name as approver']).orderBy('c.created_at', 'desc').limit(100).execute() };
  }

  @Get('cashouts/withdrawable/:floatAccountId')
  @RequirePermission('treasury.cashout.initiate')
  async withdrawable(@Param('floatAccountId') id: string) {
    return this.treasury.withdrawable(this.db, id);
  }

  @Post('cashouts')
  @HttpCode(201)
  @RequirePermission('treasury.cashout.initiate')
  async initiateCashout(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, ...input } = parseBody(cashoutSchema, body);
    return withConfirmation(this.db, this.confirmations, req.principal, 'cashout.initiate', input, confirmation, (tx, c) =>
      this.treasury.initiateCashout(tx, { floatAccountId: input.float_account_id, destination: input.destination, amount: input.amount, supportingDocument: input.supporting_document, justification: input.justification, actorId: req.principal.administratorId, confirmationId: c }));
  }

  @Post('funding')
  @HttpCode(201)
  @RequirePermission('treasury.funding')
  async funding(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, ...input } = parseBody(fundingSchema, body);
    const entryId = await withConfirmation(this.db, this.confirmations, req.principal, 'funding.post', input, confirmation, async (tx, c) => {
      let id: string;
      if (input.target === 'float') {
        if (!input.float_account_id) throw new PlatformError('FIELD_INVALID', 'Name the float account.', { field: 'float_account_id' });
        id = await this.ledger.postFloatFunding(tx, { floatAccountId: input.float_account_id, currency: input.currency, amount: input.amount, authorId: req.principal.administratorId, justification: input.justification, reference: input.reference });
      } else {
        if (!input.project_id) throw new PlatformError('FIELD_INVALID', 'Name the project.', { field: 'project_id' });
        id = await this.ledger.postProjectFunding(tx, { projectId: input.project_id, currency: input.currency, amount: input.amount, authorId: req.principal.administratorId, justification: input.justification, reference: input.reference });
      }
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: `funding.${input.target}`, subjectType: 'ledger_entry', subjectId: id, next: input, confirmationId: c });
      return id;
    });
    const coverage = await this.treasury.coverageByCurrency();
    return { entry_id: entryId, coverage };
  }

  @Post('adjustments')
  @HttpCode(201)
  @RequirePermission('treasury.adjustment.post')
  async adjustment(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, ...input } = parseBody(adjustmentSchema, body);
    const threshold = await this.settings.number('adjustment.second_approval_above');
    const magnitude = Math.max(...input.postings.map((p) => p.amount));
    const postings = input.postings.map((p) => ({ accountId: p.account_id, side: p.side, amount: p.amount }));
    return withConfirmation(this.db, this.confirmations, req.principal, 'adjustment.post', input, confirmation, async (tx, c) => {
      if (magnitude > threshold) {
        const r = await tx.insertInto('approval_request').values({ type: 'adjustment', subject: JSON.stringify({ postings, justification: input.justification, discrepancy_id: input.discrepancy_id ?? null, reference: input.reference ?? null }), summary: `Adjustment of ${magnitude}`, amount: magnitude, initiated_by: req.principal.administratorId, justification: input.justification }).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'adjustment.queued', subjectType: 'approval_request', subjectId: r.id, next: input, confirmationId: c });
        await this.alerts.raise({ category: 'security', severity: 'informational', subjectType: 'adjustment', subjectReference: r.id, fingerprint: `approval:adjustment:${r.id}`, title: 'Adjustment awaiting a second approver', detail: { amount: magnitude }, actionReference: '/approvals' }, tx);
        return { status: 'pending_approval', approval_request_id: r.id };
      }
      const entryId = await this.ledger.postAdjustment(tx, { postings, authorId: req.principal.administratorId, justification: input.justification, discrepancyId: input.discrepancy_id, reference: input.reference });
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'adjustment.post', subjectType: 'ledger_entry', subjectId: entryId, next: input, confirmationId: c });
      return { status: 'posted', entry_id: entryId };
    });
  }
}
