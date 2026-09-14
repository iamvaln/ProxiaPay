import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db } from '../db/database';
import { nonEmpty, parseBody } from '../http/validation';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notifications/notification.service';
import { CredentialService, CREDENTIAL_SCOPES } from '../project-auth/credential.service';
import { ConfirmationService } from '../admin-auth/confirmation.service';
import { AuditService } from '../audit/audit.service';
import { EntitlementService, entitlementInputSchema } from './entitlement.service';
import { confirmationSchema, withConfirmation } from './confirmed-operation';
import { RequirePermission, SessionGuard, type ConsoleRequest } from './session.guard';

const projectSchema = z.object({ code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/), name: nonEmpty(128) });
const credentialSchema = z.object({ scopes: z.array(z.enum(CREDENTIAL_SCOPES)).min(1), confirmation: confirmationSchema.optional() });
const confirmOnly = z.object({ confirmation: confirmationSchema.optional(), reason: z.string().max(512).optional() });
const originSchema = z.object({ cidr: z.string().regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/), description: z.string().max(256).default('') });
const endpointSchema = z.object({ url: z.string().url().max(2048).refine((u) => u.startsWith('https://') || process.env.NODE_ENV !== 'production', 'must be https in production') });

/** Projects (console spec 6): records, credential rotation, declared origins, entitlements, notification endpoint, activity. */
@Controller('console/projects')
@UseGuards(SessionGuard)
export class ConsoleProjectsController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly credentials: CredentialService,
    private readonly notifications: NotificationService,
    private readonly confirmations: ConfirmationService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
  ) {}

  private reach(req: ConsoleRequest, projectId: string, permission: 'projects.read' | 'projects.manage' = 'projects.read') {
    if (!req.auth.canReachProject(permission, projectId)) throw new PlatformError('NOT_FOUND', 'No such project.');
  }

  @Get()
  @RequirePermission('projects.read')
  async list(@Req() req: ConsoleRequest) {
    const scope = req.auth.projectScope('projects.read');
    let q = this.db.selectFrom('project').selectAll().orderBy('name');
    if (scope) q = q.where('id', 'in', scope.length ? scope : ['00000000-0000-0000-0000-000000000000']);
    const projects = await q.execute();
    const out = [];
    for (const p of projects) {
      const { rows } = await sql<{ n: number; value: number }>`select count(*)::int as n, coalesce(sum(requested_amount), 0)::bigint as value from transaction where project_id = ${p.id} and created_at > now() - interval '30 days'`.execute(this.db);
      const { rows: routes } = await sql<{ n: number }>`select count(*)::int as n from entitlement e join entitlement_version v on v.entitlement_id = e.id and v.valid_to is null and v.active where e.project_id = ${p.id}`.execute(this.db);
      out.push({ ...p, volume_30d: rows[0]!.n, value_30d: rows[0]!.value, balances: await this.ledger.projectBalances(this.db, p.id), routes_granted: routes[0]!.n });
    }
    return { projects: out, scoped: scope !== null };
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('projects.manage')
  async create(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const input = parseBody(projectSchema, body);
    return this.db.transaction().execute(async (tx) => {
      const p = await tx.insertInto('project').values({ ...input, created_by: req.principal.administratorId }).returning(['id', 'code', 'name', 'status']).executeTakeFirstOrThrow().catch((e) => {
        if ((e as { code?: string }).code === '23505') throw new PlatformError('CONFLICT', 'A project with that code exists.');
        throw e;
      });
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'project.create', subjectType: 'project', subjectId: p.id, next: input });
      return p;
    });
  }

  @Get(':id')
  @RequirePermission('projects.read')
  async detail(@Param('id') id: string, @Req() req: ConsoleRequest) {
    this.reach(req, id);
    const project = await this.db.selectFrom('project').selectAll().where('id', '=', id).executeTakeFirst();
    if (!project) throw new PlatformError('NOT_FOUND', 'No such project.');
    const credentials = await this.credentials.listForProject(id);
    const origins = await this.db.selectFrom('project_origin').selectAll().where('project_id', '=', id).where('active', '=', true).orderBy('created_at').execute();
    const refusals = await this.db.selectFrom('origin_refusal').selectAll().where('project_id', '=', id).orderBy('occurred_at', 'desc').limit(20).execute();
    const endpoint = await this.db.selectFrom('project_notification_endpoint').select(['id', 'url', 'active', 'verified_at', 'created_at']).where('project_id', '=', id).where('active', '=', true).executeTakeFirst();
    return {
      project, balances: await this.ledger.projectBalances(this.db, id), credentials, origins, origin_refusals: refusals,
      entitlements: await this.entitlements.listForProject(id), notification_endpoint: endpoint ? { ...endpoint, secret_set: true } : null,
      deliveries: await this.notifications.recentDeliveries(id, 25),
      activity: await this.db.selectFrom('transaction as t').innerJoin('route as r', 'r.id', 't.route_id').select(['t.reference', 't.direction', 't.state', 't.requested_amount', 't.currency_code', 't.created_at', 'r.country_code', 'r.payment_method_code']).where('t.project_id', '=', id).orderBy('t.created_at', 'desc').limit(25).execute(),
    };
  }

  @Post(':id/credentials')
  @HttpCode(201)
  @RequirePermission('projects.credentials')
  async issue(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.manage');
    const { scopes, confirmation } = parseBody(credentialSchema, body);
    return withConfirmation(this.db, this.confirmations, req.principal, 'credential.issue', { project_id: id, scopes }, confirmation, (tx, cid) => this.credentials.issue(tx, id, scopes, req.principal.administratorId, cid));
  }

  @Post(':id/credentials/:cid/promote')
  @HttpCode(200)
  @RequirePermission('projects.credentials')
  async promote(@Param('id') id: string, @Param('cid') cid: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.manage');
    const { confirmation } = parseBody(confirmOnly, body);
    await withConfirmation(this.db, this.confirmations, req.principal, 'credential.promote', { credential_id: cid }, confirmation, (tx, c) => this.credentials.promote(tx, cid, req.principal.administratorId, c));
    return { ok: true };
  }

  @Delete(':id/credentials/:cid')
  @HttpCode(200)
  @RequirePermission('projects.credentials')
  async remove(@Param('id') id: string, @Param('cid') cid: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.manage');
    const { confirmation } = parseBody(confirmOnly, body);
    await withConfirmation(this.db, this.confirmations, req.principal, 'credential.delete', { credential_id: cid }, confirmation, (tx, c) => this.credentials.delete(tx, cid, req.principal.administratorId, c));
    return { ok: true };
  }

  @Post(':id/credentials/:cid/revoke')
  @HttpCode(200)
  @RequirePermission('projects.credentials')
  async revoke(@Param('id') id: string, @Param('cid') cid: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.manage');
    const { confirmation, reason } = parseBody(confirmOnly, body);
    await withConfirmation(this.db, this.confirmations, req.principal, 'credential.revoke', { credential_id: cid, reason: reason ?? '' }, confirmation, (tx, c) => this.credentials.revoke(tx, cid, req.principal.administratorId, reason ?? 'revoked', c));
    return { ok: true };
  }

  @Post(':id/origins')
  @HttpCode(201)
  @RequirePermission('projects.origins')
  async addOrigin(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.manage');
    const input = parseBody(originSchema, body);
    return this.db.transaction().execute(async (tx) => {
      const row = await tx.insertInto('project_origin').values({ project_id: id, cidr: input.cidr, description: input.description, created_by: req.principal.administratorId }).returning(['id', 'cidr', 'description']).executeTakeFirstOrThrow();
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'origin.add', subjectType: 'project', subjectId: id, next: input });
      return row;
    });
  }

  @Delete(':id/origins/:oid')
  @HttpCode(200)
  @RequirePermission('projects.origins')
  async removeOrigin(@Param('id') id: string, @Param('oid') oid: string, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.manage');
    await this.db.transaction().execute(async (tx) => {
      const prior = await tx.selectFrom('project_origin').selectAll().where('id', '=', oid).where('project_id', '=', id).executeTakeFirst();
      if (!prior) throw new PlatformError('NOT_FOUND', 'No such origin.');
      await tx.updateTable('project_origin').set({ active: false }).where('id', '=', oid).execute();
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'origin.remove', subjectType: 'project', subjectId: id, prior: { cidr: prior.cidr, description: prior.description } });
    });
    return { ok: true };
  }

  @Post(':id/entitlements')
  @HttpCode(201)
  @RequirePermission('projects.entitlements')
  async grant(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.manage');
    const input = parseBody(entitlementInputSchema, body);
    return this.entitlements.grantOrAmend(id, input, req.principal.administratorId);
  }

  @Get(':id/entitlements/:eid/in-flight')
  @RequirePermission('projects.read')
  async inFlight(@Param('id') id: string, @Param('eid') eid: string, @Req() req: ConsoleRequest) {
    this.reach(req, id);
    return { transactions: await this.entitlements.inFlight(eid) };
  }

  @Post(':id/entitlements/:eid/deactivate')
  @HttpCode(200)
  @RequirePermission('projects.entitlements')
  async deactivate(@Param('id') id: string, @Param('eid') eid: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.manage');
    const { note } = parseBody(z.object({ note: nonEmpty(512) }), body);
    await this.entitlements.deactivate(eid, note, req.principal.administratorId);
    return { ok: true };
  }

  @Put(':id/notification-endpoint')
  @HttpCode(200)
  @RequirePermission('projects.notifications')
  async setEndpoint(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.manage');
    const { url } = parseBody(endpointSchema, body);
    const { secret } = await this.db.transaction().execute((tx) => this.notifications.setEndpoint(tx, id, url, req.principal.administratorId));
    return { url, signing_secret: secret, note: 'The secret is shown once; store it now.' };
  }

  @Post(':id/notification-endpoint/regenerate-secret')
  @HttpCode(200)
  @RequirePermission('projects.notifications')
  async regenerate(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.manage');
    const { confirmation } = parseBody(confirmOnly, body);
    const { secret } = await withConfirmation(this.db, this.confirmations, req.principal, 'notification_endpoint.regenerate', { project_id: id }, confirmation, (tx, c) => this.notifications.regenerateSecret(tx, id, req.principal.administratorId, c));
    return { signing_secret: secret, note: 'Signature checks fail until the project deploys this value.' };
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('projects.manage')
  async setStatus(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    this.reach(req, id, 'projects.manage');
    const { status } = parseBody(z.object({ status: z.enum(['active', 'suspended']) }), body);
    await this.db.transaction().execute(async (tx) => {
      const prior = await tx.selectFrom('project').select('status').where('id', '=', id).executeTakeFirstOrThrow();
      await tx.updateTable('project').set({ status }).where('id', '=', id).execute();
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'project.set_status', subjectType: 'project', subjectId: id, prior, next: { status } });
    });
    return { ok: true };
  }
}
