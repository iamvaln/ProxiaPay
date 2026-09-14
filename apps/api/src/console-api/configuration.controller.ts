import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db } from '../db/database';
import { nonEmpty, parseBody } from '../http/validation';
import { AuditService } from '../audit/audit.service';
import { ProviderAccountService } from '../providers/provider-account.service';
import { ProviderRegistry } from '../providers/provider-registry';
import { ConfirmationService } from '../admin-auth/confirmation.service';
import { confirmationSchema, withConfirmation } from './confirmed-operation';
import { RequirePermission, SessionGuard, type ConsoleRequest } from './session.guard';
import { RouteService, routeVersionInputSchema } from './route.service';

const countrySchema = z.object({ code: z.string().regex(/^[A-Z]{2}$/), iso3: z.string().regex(/^[A-Z]{3}$/), name: nonEmpty(64), dialling_prefix: z.string().regex(/^\+\d{1,4}$/), currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1) });
const countryPatch = z.object({ name: nonEmpty(64).optional(), dialling_prefix: z.string().regex(/^\+\d{1,4}$/).optional(), active: z.boolean().optional() });
const methodSchema = z.object({ code: z.string().regex(/^[A-Z0-9_]{2,16}$/), name: nonEmpty(64) });
const providerAccountSchema = z.object({ provider_code: nonEmpty(32), name: nonEmpty(64), base_url: z.string().url(), statement_format: z.string().max(32).optional(), capabilities: z.array(z.object({ country: z.string().length(2), currency: z.string().length(3), payment_method: nonEmpty(16), direction: z.enum(['collection', 'disbursement']) })).default([]) });
const credentialsSchema = z.object({ credentials: z.record(z.string().max(64), z.string().max(4096)), confirmation: confirmationSchema.optional() });
const rateChangeSetSchema = z.object({ effective_at: z.string().datetime().optional(), note: nonEmpty(1000), agreement_reference: z.string().max(128).optional(), routes: z.array(z.object({ route_id: z.string().uuid(), version: routeVersionInputSchema })).min(1) });

/** Configuration (console spec 7): countries, methods, routes and versions, provider accounts, rate change sets. */
@Controller('console/configuration')
@UseGuards(SessionGuard)
export class ConfigurationController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly routes: RouteService,
    private readonly accounts: ProviderAccountService,
    private readonly registry: ProviderRegistry,
    private readonly confirmations: ConfirmationService,
  ) {}

  @Get('countries')
  @RequirePermission('reference.read')
  async countries() {
    const countries = await this.db.selectFrom('country').selectAll().orderBy('name').execute();
    const currencies = await this.db.selectFrom('country_currency').selectAll().execute();
    return { countries: countries.map((c) => ({ ...c, currencies: currencies.filter((x) => x.country_code === c.code).map((x) => x.currency_code) })), currencies: await this.db.selectFrom('currency').selectAll().orderBy('code').execute() };
  }

  @Post('countries')
  @HttpCode(201)
  @RequirePermission('reference.manage')
  async addCountry(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const input = parseBody(countrySchema, body);
    await this.db.transaction().execute(async (tx) => {
      await tx.insertInto('country').values({ code: input.code, iso3: input.iso3, name: input.name, dialling_prefix: input.dialling_prefix }).execute();
      await tx.insertInto('country_currency').values(input.currencies.map((c) => ({ country_code: input.code, currency_code: c }))).execute();
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'country.add', subjectType: 'country', subjectId: input.code, next: input });
    });
    return { ok: true };
  }

  /** Deactivating a country halts new transactions across every route within it; the response names what that touches. */
  @Patch('countries/:code')
  @RequirePermission('reference.manage')
  async patchCountry(@Param('code') code: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const patch = parseBody(countryPatch, body);
    return this.db.transaction().execute(async (tx) => {
      const prior = await tx.selectFrom('country').selectAll().where('code', '=', code).forUpdate().executeTakeFirst();
      if (!prior) throw new PlatformError('NOT_FOUND', 'No such country.');
      await tx.updateTable('country').set(patch).where('code', '=', code).execute();
      const { rows } = await sql<{ routes: number; projects: number; in_flight: number }>`
        select (select count(*)::int from route where country_code = ${code}) as routes,
               (select count(distinct e.project_id)::int from entitlement e join route r on r.id = e.route_id where r.country_code = ${code}) as projects,
               (select count(*)::int from transaction t join route r on r.id = t.route_id where r.country_code = ${code} and t.state in ('created','submitted','processing','action_required','undetermined')) as in_flight`.execute(tx);
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'country.amend', subjectType: 'country', subjectId: code, prior, next: patch });
      return { ok: true, affected: rows[0] };
    });
  }

  @Get('countries/:code/impact')
  @RequirePermission('reference.read')
  async countryImpact(@Param('code') code: string) {
    const { rows } = await sql<{ routes: number; projects: number; in_flight: number }>`
      select (select count(*)::int from route where country_code = ${code}) as routes,
             (select count(distinct e.project_id)::int from entitlement e join route r on r.id = e.route_id where r.country_code = ${code}) as projects,
             (select count(*)::int from transaction t join route r on r.id = t.route_id where r.country_code = ${code} and t.state in ('created','submitted','processing','action_required','undetermined')) as in_flight`.execute(this.db);
    return rows[0];
  }

  @Get('payment-methods')
  @RequirePermission('reference.read')
  async methods() {
    return { payment_methods: await this.db.selectFrom('payment_method').selectAll().orderBy('code').execute() };
  }

  @Post('payment-methods')
  @HttpCode(201)
  @RequirePermission('reference.manage')
  async addMethod(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const input = parseBody(methodSchema, body);
    await this.db.transaction().execute(async (tx) => {
      await tx.insertInto('payment_method').values(input).execute();
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'payment_method.add', subjectType: 'payment_method', subjectId: input.code, next: input });
    });
    return { ok: true };
  }

  @Get('routes')
  @RequirePermission('routes.read')
  async routesList(@Query() query: Record<string, string>) {
    return { routes: await this.routes.list(query) };
  }

  @Get('routes/:id')
  @RequirePermission('routes.read')
  async route(@Param('id') id: string) {
    return this.routes.detail(id);
  }

  @Post('routes/:id/versions/compare')
  @HttpCode(200)
  @RequirePermission('routes.open_version')
  async compare(@Param('id') id: string, @Body() body: unknown) {
    return this.routes.compare(id, parseBody(routeVersionInputSchema, body));
  }

  @Post('routes/:id/versions')
  @HttpCode(201)
  @RequirePermission('routes.open_version')
  async openVersion(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const input = parseBody(routeVersionInputSchema, body);
    return this.db.transaction().execute((tx) => this.routes.openVersion(tx, id, input, req.principal.administratorId, { requireFeePermission: true, hasFeePermission: req.auth.has('routes.set_fees') }));
  }

  @Post('routes')
  @HttpCode(201)
  @RequirePermission('routes.open_version')
  async createRoute(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const { country, currency, payment_method, direction, version } = parseBody(z.object({ country: z.string().length(2), currency: z.string().length(3), payment_method: nonEmpty(16), direction: z.enum(['collection', 'disbursement']), version: routeVersionInputSchema }), body);
    return this.db.transaction().execute(async (tx) => {
      const route = await tx.insertInto('route').values({ country_code: country, currency_code: currency, payment_method_code: payment_method, direction }).returning('id').executeTakeFirstOrThrow().catch((e) => {
        if ((e as { code?: string }).code === '23505') throw new PlatformError('CONFLICT', 'That route exists.');
        throw e;
      });
      const v = await this.routes.openVersion(tx, route.id, version, req.principal.administratorId, { requireFeePermission: false, hasFeePermission: true });
      return { route_id: route.id, ...v };
    });
  }

  /** A rate change set opens every version together or none (spec 3.6). */
  @Post('rate-change-sets')
  @HttpCode(201)
  @RequirePermission('routes.set_fees')
  async rateChangeSet(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const input = parseBody(rateChangeSetSchema, body);
    return this.db.transaction().execute(async (tx) => {
      const set = await tx.insertInto('rate_change_set').values({ effective_at: input.effective_at ? new Date(input.effective_at) : sql`now()`, note: input.note, agreement_reference: input.agreement_reference ?? null, created_by: req.principal.administratorId }).returning('id').executeTakeFirstOrThrow();
      const versions = [];
      for (const r of input.routes) versions.push({ route_id: r.route_id, ...(await this.routes.openVersion(tx, r.route_id, { ...r.version, rate_change_set_id: set.id }, req.principal.administratorId, { requireFeePermission: false, hasFeePermission: true })) });
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'rate_change_set.create', subjectType: 'rate_change_set', subjectId: set.id, next: { routes: versions.length, note: input.note, agreement: input.agreement_reference } });
      return { rate_change_set_id: set.id, versions };
    });
  }

  @Get('rate-change-sets')
  @RequirePermission('routes.read')
  async rateChangeSets() {
    const sets = await this.db.selectFrom('rate_change_set as s').leftJoin('administrator as a', 'a.id', 's.created_by').selectAll('s').select('a.name as author').orderBy('s.created_at', 'desc').execute();
    const versions = await this.db.selectFrom('route_version').select(['id', 'route_id', 'rate_change_set_id', 'sequence']).where('rate_change_set_id', 'is not', null).execute();
    return { sets: sets.map((s) => ({ ...s, versions: versions.filter((v) => v.rate_change_set_id === s.id) })) };
  }

  @Get('providers')
  @RequirePermission('providers.read')
  async providers(@Req() req: ConsoleRequest) {
    const scope = req.auth.providerScope('providers.read');
    let q = this.db.selectFrom('provider_account as pa').innerJoin('provider as p', 'p.code', 'pa.provider_code').leftJoin('circuit_breaker as cb', 'cb.provider_account_id', 'pa.id')
      .select(['pa.id', 'pa.name', 'pa.provider_code', 'p.name as provider_name', 'p.adapter_key', 'pa.status', 'pa.base_url', 'pa.supports_transfers', 'pa.supports_listing', 'pa.has_test_environment', 'pa.statement_format', 'pa.suspended_at', 'cb.state as breaker_state', 'cb.failure_count', 'cb.opened_at'])
      .select((eb) => eb.case().when('pa.credential_ciphertext', 'is', null).then(false).else(true).end().as('credentials_present'))
      .orderBy('pa.name');
    if (scope) q = q.where('pa.id', 'in', scope.length ? scope : ['00000000-0000-0000-0000-000000000000']);
    const accounts = await q.execute();
    const caps = await this.db.selectFrom('provider_account_capability').selectAll().execute();
    return { providers: accounts.map((a) => ({ ...a, capabilities: caps.filter((c) => c.provider_account_id === a.id), adapter: this.registry.get(a.adapter_key).capabilities() })), scoped: scope !== null };
  }

  @Get('providers/:id')
  @RequirePermission('providers.read')
  async provider(@Param('id') id: string, @Req() req: ConsoleRequest) {
    if (!req.auth.canReachProvider('providers.read', id)) throw new PlatformError('NOT_FOUND', 'No such provider account.');
    const { providers } = await this.providers(req);
    const account = providers.find((p) => p.id === id);
    if (!account) throw new PlatformError('NOT_FOUND', 'No such provider account.');
    const routes = await this.db.selectFrom('route_binding as b').innerJoin('route_version as rv', 'rv.id', 'b.route_version_id').innerJoin('route as r', 'r.id', 'rv.route_id')
      .select(['r.id', 'r.country_code', 'r.currency_code', 'r.payment_method_code', 'r.direction', 'b.priority', 'b.enabled', 'b.terms_status', 'b.expected_fee_bps']).where('b.provider_account_id', '=', id).where('rv.valid_to', 'is', null).execute();
    const failures = await this.db.selectFrom('transaction_attempt').select(['id', 'failure_reason', 'provider_error_code', 'ended_at']).where('provider_account_id', '=', id).where('state', '=', 'failed').orderBy('ended_at', 'desc').limit(20).execute();
    return { account, routes, recent_failures: failures };
  }

  @Post('providers')
  @HttpCode(201)
  @RequirePermission('providers.manage')
  async addProvider(@Body() body: unknown, @Req() req: ConsoleRequest) {
    const input = parseBody(providerAccountSchema, body);
    const adapter = this.registry.get((await this.db.selectFrom('provider').select('adapter_key').where('code', '=', input.provider_code).executeTakeFirst())?.adapter_key ?? '');
    const caps = adapter.capabilities();
    return this.db.transaction().execute(async (tx) => {
      const row = await tx.insertInto('provider_account').values({ provider_code: input.provider_code, name: input.name, base_url: input.base_url, supports_transfers: caps.supportsTransfers, supports_listing: caps.supportsListing, has_test_environment: caps.hasTestEnvironment, statement_format: input.statement_format ?? caps.statementFormat ?? null }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('circuit_breaker').values({ provider_account_id: row.id }).execute();
      if (input.capabilities.length) await tx.insertInto('provider_account_capability').values(input.capabilities.map((c) => ({ provider_account_id: row.id, country_code: c.country, currency_code: c.currency, payment_method_code: c.payment_method, direction: c.direction }))).execute();
      await this.audit.record(tx, { actorId: req.principal.administratorId, action: 'provider_account.create', subjectType: 'provider_account', subjectId: row.id, next: { ...input } });
      return { id: row.id };
    });
  }

  @Put('providers/:id/credentials')
  @HttpCode(200)
  @RequirePermission('providers.manage')
  async setCredentials(@Param('id') id: string, @Body() body: unknown, @Req() req: ConsoleRequest) {
    const { credentials, confirmation } = parseBody(credentialsSchema, body);
    // The fingerprint covers the key names only, so the secret values never travel twice.
    await withConfirmation(this.db, this.confirmations, req.principal, 'provider_account.credentials', { provider_account_id: id, keys: Object.keys(credentials).sort() }, confirmation, (tx, c) => this.accounts.setCredentials(tx, id, credentials, req.principal.administratorId, c));
    return { ok: true };
  }

  @Post('providers/:id/suspend')
  @HttpCode(200)
  @RequirePermission('providers.suspend')
  async suspend(@Param('id') id: string, @Req() req: ConsoleRequest) {
    await this.db.transaction().execute((tx) => this.accounts.setStatus(tx, id, 'suspended', req.principal.administratorId));
    return { ok: true };
  }

  @Post('providers/:id/restore')
  @HttpCode(200)
  @RequirePermission('providers.suspend')
  async restore(@Param('id') id: string, @Req() req: ConsoleRequest) {
    await this.db.transaction().execute((tx) => this.accounts.setStatus(tx, id, 'active', req.principal.administratorId));
    return { ok: true };
  }
}
