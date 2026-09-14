import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db } from '../db/database';
import { nonEmpty, parseBody } from '../http/validation';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { ConfirmationService } from '../admin-auth/confirmation.service';
import { AlertService } from '../alerts/alert.service';
import { HealthService } from '../alerts/health.service';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../permissions/permissions';
import { confirmationSchema, withConfirmation } from './confirmed-operation';
import { ExportService } from './export.service';
import { RoleService } from './role.service';
import { RequirePermission, SessionGuard, type ConsoleRequest } from './session.guard';
import { subtract } from '../money/money';

const adminSchema = z.object({ name: nonEmpty(128), email: z.string().trim().email().max(254), password: z.string().min(12).max(256), language: z.enum(['en', 'fr']).optional(), confirmation: confirmationSchema.optional() });
const adminPatch = z.object({ name: nonEmpty(128).optional(), status: z.enum(['active', 'disabled']).optional(), confirmation: confirmationSchema.optional() });
const roleChangeSchema = z.object({
  kind: z.enum(['role_permissions', 'assignment_add', 'assignment_remove']), role_id: z.string().uuid().optional(), name: z.string().max(64).optional(), description: z.string().max(512).optional(),
  permissions: z.array(z.string()).optional(), administrator_id: z.string().uuid().optional(), assignment_id: z.string().uuid().optional(),
  scope_type: z.enum(['all', 'projects', 'provider_accounts']).optional(), project_ids: z.array(z.string().uuid()).optional(), provider_account_ids: z.array(z.string().uuid()).optional(),
  justification: z.string().max(1000).default(''), confirmation: confirmationSchema.optional(),
});
const policySchema = z.object({ minimum_severity: z.enum(['informational', 'warning', 'critical']), acknowledgement_required: z.boolean(), escalation_minutes: z.number().int().positive(), escalation_group_id: z.string().uuid().nullable(), group_ids: z.array(z.string().uuid()).min(1) });
const groupSchema = z.object({ name: nonEmpty(64), description: z.string().max(256).default(''), member_ids: z.array(z.string().uuid()).default([]), addresses: z.array(z.object({ channel: z.enum(['email', 'chat']), address: nonEmpty(256) })).default([]), active: z.boolean().default(true) });
const reportSchema = z.object({ rows: z.enum(['project', 'direction', 'country', 'payment_method', 'provider_account', 'currency', 'day', 'month']).default('country'), cols: z.enum(['direction', 'currency', 'none']).default('none'), from: z.string().datetime().optional(), to: z.string().datetime().optional() });

/** Oversight (console spec 10): alerts, health, reporting, exports, administrators, roles, audit and authentication history. */
@Controller('console/oversight')
@UseGuards(SessionGuard)
export class OversightController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly alerts: AlertService,
    private readonly health: HealthService,
    private readonly audit: AuditService,
    private readonly admins: AdminAuthService,
    private readonly roles: RoleService,
    private readonly exports: ExportService,
    private readonly confirmations: ConfirmationService,
  ) {}

  @Get('alerts')
  @RequirePermission('oversight.alerts.read')
  async alertList(@Query('status') status: string | undefined) {
    let q = this.db.selectFrom('alert').selectAll().orderBy('raised_at', 'desc').limit(200);
    q = status === 'cleared' ? q.where('status', '=', 'cleared') : q.where('status', 'in', ['open', 'acknowledged']);
    return { alerts: await q.execute() };
  }

  @Get('alerts/:id')
  @RequirePermission('oversight.alerts.read')
  async alert(@Param('id') id: string) {
    const alert = await this.db.selectFrom('alert').selectAll().where('id', '=', id).executeTakeFirst();
    if (!alert) throw new PlatformError('NOT_FOUND', 'No such alert.');
    return { alert, deliveries: await this.db.selectFrom('alert_delivery').selectAll().where('alert_id', '=', id).orderBy('id').execute() };
  }

  @Post('alerts/:id/acknowledge')
  @HttpCode(200)
  @RequirePermission('oversight.alerts.acknowledge')
  async acknowledge(@Param('id') id: string, @Req() req: ConsoleRequest) {
    await this.alerts.acknowledge(id, req.principal.administratorId);
    return { ok: true };
  }

  @Get('alerts/policies')
  @RequirePermission('oversight.alerts.read')
  async policies() {
    const policies = await this.db.selectFrom('alert_policy').selectAll().execute();
    const groups = await this.db.selectFrom('alert_policy_group').selectAll().execute();
    const allGroups = await this.db.selectFrom('alert_group').selectAll().execute();
    const members = await this.db.selectFrom('alert_group_member as m').innerJoin('administrator as a', 'a.id', 'm.administrator_id').select(['m.group_id', 'a.id', 'a.name']).execute();
    const addresses = await this.db.selectFrom('alert_group_address').selectAll().execute();
    return {
      policies: policies.map((p) => ({ ...p, group_ids: groups.filter((g) => g.category === p.category).map((g) => g.group_id), unrouted: groups.filter((g) => g.category === p.category).every((g) => { const grp = allGroups.find((x) => x.id === g.group_id); return !grp?.active || !addresses.some((a) => a.group_id === g.group_id && a.active); }) })),
      groups: allGroups.map((g) => ({ ...g, members: members.filter((m) => m.group_id === g.id), addresses: addresses.filter((a) => a.group_id === g.id) })),
    };
  }

  /** A change leaving a category unrouted is refused (spec 8.6). */
  @Put('alerts/policies/:category')
  @HttpCode(200)
  @RequirePermission('oversight.alerts.manage')
  async setPolicy(@Param('category') category: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const input = parseBody(policySchema, body);
    await this.db.transaction().execute(async (tx) => {
      const active = await tx.selectFrom('alert_group').select('id').where('id', 'in', input.group_ids).where('active', '=', true).execute();
      if (active.length === 0) throw new PlatformError('RULE_VIOLATION', 'A category keeps at least one active group.');
      const prior = await tx.selectFrom('alert_policy').selectAll().where('category', '=', category).executeTakeFirst();
      await tx.insertInto('alert_policy').values({ category, minimum_severity: input.minimum_severity, acknowledgement_required: input.acknowledgement_required, escalation_minutes: input.escalation_minutes, escalation_group_id: input.escalation_group_id })
        .onConflict((oc) => oc.column('category').doUpdateSet({ minimum_severity: input.minimum_severity, acknowledgement_required: input.acknowledgement_required, escalation_minutes: input.escalation_minutes, escalation_group_id: input.escalation_group_id, updated_at: sql`now()` })).execute();
      await tx.deleteFrom('alert_policy_group').where('category', '=', category).execute();
      await tx.insertInto('alert_policy_group').values(input.group_ids.map((g) => ({ category, group_id: g }))).execute();
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'alert_policy.set', subjectType: 'alert_policy', subjectId: category, prior, next: input });
    });
    return { ok: true };
  }

  @Put('alerts/groups/:id')
  @HttpCode(200)
  @RequirePermission('oversight.alerts.manage')
  async setGroup(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const input = parseBody(groupSchema, body);
    await this.db.transaction().execute(async (tx) => {
      const isNew = id === 'new';
      const groupId = isNew ? (await tx.insertInto('alert_group').values({ name: input.name, description: input.description, active: input.active }).returning('id').executeTakeFirstOrThrow()).id : id;
      if (!isNew) {
        if (!input.active) {
          const { rows } = await sql<{ category: string }>`select pg.category from alert_policy_group pg where pg.group_id = ${id} and not exists (select 1 from alert_policy_group o join alert_group g on g.id = o.group_id where o.category = pg.category and o.group_id <> ${id} and g.active)`.execute(tx);
          if (rows.length) throw new PlatformError('RULE_VIOLATION', `Deactivating this group would leave ${rows.map((r) => r.category).join(', ')} unrouted.`);
        }
        await tx.updateTable('alert_group').set({ name: input.name, description: input.description, active: input.active }).where('id', '=', id).execute();
      }
      await tx.deleteFrom('alert_group_member').where('group_id', '=', groupId).execute();
      if (input.member_ids.length) await tx.insertInto('alert_group_member').values(input.member_ids.map((m) => ({ group_id: groupId, administrator_id: m }))).execute();
      await tx.deleteFrom('alert_group_address').where('group_id', '=', groupId).execute();
      if (input.addresses.length) await tx.insertInto('alert_group_address').values(input.addresses.map((a) => ({ group_id: groupId, channel: a.channel, address: a.address }))).execute();
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'alert_group.set', subjectType: 'alert_group', subjectId: groupId, next: input });
    });
    return { ok: true };
  }

  @Get('health')
  @RequirePermission('oversight.reports')
  async healthView() {
    return { success_rates: { route: await this.health.successRates('route'), provider_account: await this.health.successRates('provider_account'), project: await this.health.successRates('project') }, failure_reasons: await this.health.failureReasons(), counters: await this.health.counters() };
  }

  /** Reporting (console spec 10.3), read from the terms recorded on each transaction. */
  @Get('reports')
  @RequirePermission('oversight.reports')
  async reports(@Query() query: Record<string, string>, @Req() req: ConsoleRequest) {
    const q = parseBody(reportSchema, query);
    const rowExpr = { project: sql`p.name`, direction: sql`t.direction`, country: sql`r.country_code`, payment_method: sql`r.payment_method_code`, provider_account: sql`coalesce(pa.name, '—')`, currency: sql`t.currency_code`, day: sql`to_char(t.created_at, 'YYYY-MM-DD')`, month: sql`to_char(t.created_at, 'YYYY-MM')` }[q.rows];
    const colExpr = q.cols === 'none' ? sql`''` : q.cols === 'direction' ? sql`t.direction` : sql`t.currency_code`;
    const scope = req.auth.projectScope('oversight.reports');
    const scopeFilter = scope ? sql`and t.project_id in (${sql.join(scope.length ? scope : ['00000000-0000-0000-0000-000000000000'])})` : sql``;
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 24 * 3600_000);
    const to = q.to ? new Date(q.to) : new Date();
    const { rows } = await sql<Record<string, unknown>>`
      select ${rowExpr}::text as row_key, ${colExpr}::text as col_key, t.currency_code as currency,
             count(*)::int as volume, coalesce(sum(t.requested_amount), 0)::bigint as value,
             count(*) filter (where t.state = 'succeeded')::int as succeeded, count(*) filter (where t.terminal_at is not null)::int as terminal,
             coalesce(sum(t.processing_fee) filter (where t.state = 'succeeded'), 0)::bigint as processing_fees,
             coalesce(sum(t.platform_fee) filter (where t.state = 'succeeded'), 0)::bigint as platform_revenue,
             coalesce(sum(t.actual_provider_fee) filter (where t.state = 'succeeded'), 0)::bigint as provider_fees,
             count(*) filter (where t.original_transaction_id is not null)::int as refunds
        from transaction t join route r on r.id = t.route_id join project p on p.id = t.project_id
        left join transaction_attempt a on a.id = t.current_attempt_id left join provider_account pa on pa.id = a.provider_account_id
       where t.created_at >= ${from} and t.created_at < ${to} ${scopeFilter}
       group by 1, 2, 3 order by 1, 2, 3`.execute(this.db);
    const data = rows.map((r) => ({ ...r, margin: subtract(r.processing_fees as number, r.provider_fees as number), success_rate: (r.terminal as number) ? (r.succeeded as number) / (r.terminal as number) : null, negative_margin: subtract(r.processing_fees as number, r.provider_fees as number) < 0 }));
    return { rows: q.rows, cols: q.cols, from, to, scoped: scope !== null, data };
  }

  @Get('reports/export')
  @RequirePermission('oversight.export')
  async reportExport(@Query() query: Record<string, string>, @Req() req: ConsoleRequest) {
    req.auth.require('oversight.reports');
    const r = await this.reports(query, req);
    return this.exports.produce(req.principal.administratorId, 'report', query, ['row_key', 'col_key', 'currency', 'volume', 'value', 'succeeded', 'terminal', 'success_rate', 'processing_fees', 'platform_revenue', 'provider_fees', 'margin', 'refunds'], r.data as Record<string, unknown>[]);
  }

  @Post('exports/verify')
  @HttpCode(200)
  @RequirePermission('oversight.verify_export')
  async verifyExport(@Body() body: unknown) {
    const input = parseBody(z.object({ export_id: z.string().optional(), content: z.string().max(50_000_000).optional() }), body);
    return this.exports.verify(input);
  }

  @Get('exports')
  @RequirePermission('oversight.verify_export')
  async exportHistory() {
    return { exports: await this.exports.history() };
  }

  @Get('audit')
  @RequirePermission('oversight.audit')
  async auditLog(@Query() q: Record<string, string>) {
    let query = this.db.selectFrom('audit_record as r').leftJoin('administrator as a', 'a.id', 'r.actor_id').leftJoin('administrator as ap', 'ap.id', 'r.approved_by').selectAll('r').select(['a.name as actor_name', 'ap.name as approver_name']).orderBy('r.id', 'desc').limit(200);
    if (q.actor) query = query.where('r.actor_id', '=', q.actor);
    if (q.subject_type) query = query.where('r.subject_type', '=', q.subject_type);
    if (q.subject_id) query = query.where('r.subject_id', '=', q.subject_id);
    if (q.after) query = query.where('r.occurred_at', '>', new Date(q.after));
    if (q.before) query = query.where('r.occurred_at', '<', new Date(q.before));
    if (q.cursor) query = query.where('r.id', '<', Number(q.cursor));
    const records = await query.execute();
    return { records, next_cursor: records.length === 200 ? records[records.length - 1]!.id : null };
  }

  @Get('authentication-history')
  @RequirePermission('oversight.auth_history')
  async authHistory(@Query('cursor') cursor: string | undefined) {
    let q = this.db.selectFrom('authentication_event').selectAll().orderBy('id', 'desc').limit(200);
    if (cursor) q = q.where('id', '<', Number(cursor));
    return { events: await q.execute() };
  }

  @Get('administrators')
  @RequirePermission('admin.administrators')
  async administrators() {
    const admins = await this.db.selectFrom('administrator').select(['id', 'name', 'email', 'status', 'language', 'timezone', 'last_sign_in_at', 'totp_enrolled_at', 'locked_until', 'created_at']).orderBy('name').execute();
    const assignments = await this.db.selectFrom('role_assignment as ra').innerJoin('role as r', 'r.id', 'ra.role_id').select(['ra.id', 'ra.administrator_id', 'ra.role_id', 'r.name as role_name', 'ra.scope_type']).execute();
    const scopes = await this.db.selectFrom('role_assignment_scope').selectAll().execute();
    return { administrators: admins.map((a) => ({ ...a, assignments: assignments.filter((x) => x.administrator_id === a.id).map((x) => ({ ...x, scopes: scopes.filter((s) => s.assignment_id === x.id) })) })) };
  }

  @Get('administrators/:id')
  @RequirePermission('admin.administrators')
  async administrator(@Param('id') id: string) {
    const { administrators } = await this.administrators();
    const admin = administrators.find((a) => a.id === id);
    if (!admin) throw new PlatformError('NOT_FOUND', 'No such administrator.');
    return { administrator: admin, sessions: await this.admins.listSessions(id), recent_actions: await this.db.selectFrom('audit_record').selectAll().where('actor_id', '=', id).orderBy('id', 'desc').limit(50).execute() };
  }

  @Post('administrators')
  @HttpCode(201)
  @RequirePermission('admin.administrators')
  async createAdministrator(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, password, ...input } = parseBody(adminSchema, body);
    return withConfirmation(this.db, this.confirmations, req.principal, 'administrator.create', input, confirmation, (tx) => this.admins.createAdministrator(tx, { ...input, password, createdBy: req.principal.administratorId }));
  }

  @Patch('administrators/:id')
  @RequirePermission('admin.administrators')
  async patchAdministrator(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, ...patch } = parseBody(adminPatch, body);
    if (id === req.principal.administratorId && patch.status) throw new PlatformError('PERMISSION_DENIED', 'An administrator cannot alter their own status.');
    await withConfirmation(this.db, this.confirmations, req.principal, 'administrator.amend', { id, ...patch }, confirmation, async (tx, c) => {
      const prior = await tx.selectFrom('administrator').select(['name', 'status']).where('id', '=', id).executeTakeFirstOrThrow();
      await tx.updateTable('administrator').set(patch).where('id', '=', id).execute();
      if (patch.status === 'disabled') await this.admins.revokeAllSessions(id, req.principal.administratorId);
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'administrator.amend', subjectType: 'administrator', subjectId: id, prior, next: patch, confirmationId: c });
    });
    return { ok: true };
  }

  @Post('sessions/:id/revoke')
  @HttpCode(200)
  @RequirePermission('admin.sessions')
  async revokeSession(@Param('id') id: string, @Req() req: ConsoleRequest) {
    await this.admins.revokeSession(id, req.principal.administratorId);
    await this.audit.record(this.db, { actorId: req.principal.administratorId, action: 'session.revoke', subjectType: 'admin_session', subjectId: id });
    return { ok: true };
  }

  @Get('roles')
  @RequirePermission('admin.roles')
  async roleList() {
    return { roles: await this.roles.list(), permissions: PERMISSIONS };
  }

  @Post('roles/impact')
  @HttpCode(200)
  @RequirePermission('admin.roles')
  async roleImpact(@Body() body: unknown) {
    const { confirmation, justification, ...change } = parseBody(roleChangeSchema, body);
    void confirmation; void justification;
    return this.roles.impact(change as never);
  }

  /** Role and assignment changes require a code, and a second approver where treasury or administration permissions are involved. */
  @Post('roles/changes')
  @HttpCode(200)
  @RequirePermission('admin.roles')
  async roleChange(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { confirmation, justification, ...change } = parseBody(roleChangeSchema, body);
    return withConfirmation(this.db, this.confirmations, req.principal, 'role.change', change, confirmation, async (_tx, c) => this.roles.propose(change as never, { id: req.principal.administratorId, permissions: req.auth.permissions() }, justification, c));
  }
}
