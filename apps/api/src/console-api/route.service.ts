import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db, type Tx } from '../db/database';
import { AuditService } from '../audit/audit.service';
import { routeVersionFingerprint } from '../seed/seed';
import { computeFee, subtract } from '../money/money';

export const routeVersionInputSchema = z.object({
  processing_fee_bps: z.number().int().min(0),
  processing_fee_fixed: z.number().int().min(0).default(0),
  processing_fee_floor: z.number().int().min(0).nullable().default(null),
  processing_fee_ceiling: z.number().int().min(0).nullable().default(null),
  platform_fee_bps: z.number().int().min(0).default(0),
  platform_fee_fixed: z.number().int().min(0).default(0),
  platform_fee_floor: z.number().int().min(0).nullable().default(null),
  platform_fee_ceiling: z.number().int().min(0).nullable().default(null),
  processing_fee_bearer: z.enum(['counterparty', 'project']),
  platform_fee_bearer: z.enum(['counterparty', 'project']),
  minimum_amount: z.number().int().min(0),
  maximum_amount: z.number().int().min(0),
  otp_required: z.boolean().default(false),
  browser_required: z.boolean().default(false),
  disbursement_fallback: z.boolean().default(false),
  active: z.boolean().default(true),
  bindings: z.array(z.object({
    provider_account_id: z.string().uuid(),
    expected_fee_bps: z.number().int().min(0),
    expected_fee_fixed: z.number().int().min(0).default(0),
    terms_status: z.enum(['indicative', 'contracted']).default('indicative'),
    enabled: z.boolean().default(true),
    minimum_amount: z.number().int().min(0).nullable().default(null),
    maximum_amount: z.number().int().min(0).nullable().default(null),
  })).min(1),
  note: z.string().trim().min(1).max(1000),
  accept_shortfall: z.boolean().default(false),
  rate_change_set_id: z.string().uuid().optional(),
});
export type RouteVersionInput = z.infer<typeof routeVersionInputSchema>;

const VERSION_FIELDS = ['processing_fee_bps', 'processing_fee_fixed', 'processing_fee_floor', 'processing_fee_ceiling', 'platform_fee_bps', 'platform_fee_fixed', 'platform_fee_floor', 'platform_fee_ceiling',
  'processing_fee_bearer', 'platform_fee_bearer', 'minimum_amount', 'maximum_amount', 'otp_required', 'browser_required', 'disbursement_fallback', 'active'] as const;

/** Routes and their immutable versions (spec 3.2, console spec 7.2), with the comparison shown before committing and the below-cost warning. */
@Injectable()
export class RouteService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly audit: AuditService) {}

  async list(filters: Record<string, string | undefined>) {
    let q = this.db
      .selectFrom('route as r')
      .innerJoin('route_version as rv', (j) => j.onRef('rv.route_id', '=', 'r.id').on('rv.valid_to', 'is', null))
      .innerJoin('country as c', 'c.code', 'r.country_code')
      .innerJoin('payment_method as pm', 'pm.code', 'r.payment_method_code')
      .select(['r.id', 'r.country_code', 'c.name as country_name', 'r.currency_code', 'r.payment_method_code', 'pm.name as payment_method_name', 'r.direction', 'rv.id as version_id', 'rv.sequence', 'rv.processing_fee_bps', 'rv.platform_fee_bps', 'rv.processing_fee_bearer', 'rv.platform_fee_bearer', 'rv.active', 'rv.otp_required', 'rv.browser_required', 'c.active as country_active'])
      .orderBy(['r.country_code', 'r.payment_method_code', 'r.direction']);
    if (filters.country) q = q.where('r.country_code', '=', filters.country);
    if (filters.currency) q = q.where('r.currency_code', '=', filters.currency);
    if (filters.payment_method) q = q.where('r.payment_method_code', '=', filters.payment_method);
    if (filters.direction) q = q.where('r.direction', '=', filters.direction);
    const routes = await q.execute();
    const bindings = await this.db.selectFrom('route_binding as b').innerJoin('provider_account as pa', 'pa.id', 'b.provider_account_id').select(['b.route_version_id', 'pa.name', 'b.terms_status', 'b.priority', 'b.enabled']).orderBy('b.priority').execute();
    const { rows: volumes } = await sql<{ route_id: string; n: number; value: number }>`select route_id, count(*)::int as n, coalesce(sum(requested_amount), 0)::bigint as value from transaction where created_at > now() - interval '30 days' group by 1`.execute(this.db);
    return routes.map((r) => {
      const bs = bindings.filter((b) => b.route_version_id === r.version_id);
      const v = volumes.find((x) => x.route_id === r.id);
      return { ...r, provider: bs.find((b) => b.enabled)?.name ?? null, indicative: bs.some((b) => b.terms_status === 'indicative'), volume_30d: v?.n ?? 0, value_30d: v?.value ?? 0 };
    });
  }

  async detail(routeId: string) {
    const route = await this.db.selectFrom('route').selectAll().where('id', '=', routeId).executeTakeFirst();
    if (!route) throw new PlatformError('NOT_FOUND', 'No such route.');
    const versions = await this.db.selectFrom('route_version as v').leftJoin('administrator as a', 'a.id', 'v.created_by').selectAll('v').select('a.name as author').where('v.route_id', '=', routeId).orderBy('v.sequence', 'desc').execute();
    const bindings = await this.db.selectFrom('route_binding as b').innerJoin('provider_account as pa', 'pa.id', 'b.provider_account_id').selectAll('b').select(['pa.name as provider_account_name', 'pa.status as provider_account_status']).where('b.route_version_id', 'in', versions.map((v) => v.id)).orderBy('b.priority').execute();
    const projects = await this.db.selectFrom('entitlement as e').innerJoin('project as p', 'p.id', 'e.project_id').innerJoin('entitlement_version as ev', (j) => j.onRef('ev.entitlement_id', '=', 'e.id').on('ev.valid_to', 'is', null))
      .select(['p.id', 'p.name', 'ev.processing_fee_bps', 'ev.platform_fee_bps', 'ev.processing_fee_bearer', 'ev.platform_fee_bearer', 'ev.active']).where('e.route_id', '=', routeId).execute();
    const withDiff = versions.map((v, i) => {
      const prev = versions[i + 1];
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (prev) for (const f of VERSION_FIELDS) if (prev[f] !== v[f]) changes[f] = { from: prev[f], to: v[f] };
      return { ...v, bindings: bindings.filter((b) => b.route_version_id === v.id), changes_from_previous: changes };
    });
    return { route, current: withDiff[0], versions: withDiff, projects_with_overrides: projects.filter((p) => p.processing_fee_bps != null || p.platform_fee_bps != null || p.processing_fee_bearer || p.platform_fee_bearer), projects };
  }

  /** The comparison and the warning, without committing (console spec 11.3). */
  async compare(routeId: string, input: RouteVersionInput) {
    const current = await this.db.selectFrom('route_version').selectAll().where('route_id', '=', routeId).where('valid_to', 'is', null).executeTakeFirst();
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (current) for (const f of VERSION_FIELDS) if (current[f] !== input[f]) changes[f] = { from: current[f], to: input[f] };
    const warnings = input.bindings.filter((b) => b.enabled && b.expected_fee_bps > input.processing_fee_bps).map((b) => ({ provider_account_id: b.provider_account_id, expected_fee_bps: b.expected_fee_bps, processing_fee_bps: input.processing_fee_bps, shortfall_per_10000: subtract(computeFee(10_000, { bps: b.expected_fee_bps, fixed: b.expected_fee_fixed }).amount, computeFee(10_000, { bps: input.processing_fee_bps, fixed: input.processing_fee_fixed }).amount) }));
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from transaction where route_id = ${routeId} and state in ('created', 'submitted', 'processing', 'action_required', 'undetermined')`.execute(this.db);
    return { changes, warnings, in_flight: rows[0]!.n };
  }

  async openVersion(tx: Tx, routeId: string, input: RouteVersionInput, actorId: string, opts: { requireFeePermission: boolean; hasFeePermission: boolean }) {
    const cmp = await this.compare(routeId, input);
    const feeChanged = Object.keys(cmp.changes).some((k) => k.includes('fee'));
    if (opts.requireFeePermission && feeChanged && !opts.hasFeePermission) throw new PlatformError('PERMISSION_DENIED', 'Changing fee terms requires the permission "routes.set_fees".', { details: { permission: 'routes.set_fees' } });
    if (cmp.warnings.length && !input.accept_shortfall) throw new PlatformError('RULE_VIOLATION', 'A binding is expected to charge more than the route recovers; accept the shortfall deliberately or correct the terms.', { details: { warnings: cmp.warnings } });
    if (input.maximum_amount < input.minimum_amount) throw new PlatformError('FIELD_INVALID', 'Maximum is below minimum.', { field: 'maximum_amount' });
    if (input.otp_required && input.browser_required) throw new PlatformError('FIELD_INVALID', 'A route requires a code or a browser step, not both.', { field: 'browser_required' });
    const current = await tx.selectFrom('route_version').selectAll().where('route_id', '=', routeId).where('valid_to', 'is', null).forUpdate().executeTakeFirst();
    if (current) await tx.updateTable('route_version').set({ valid_to: sql`now()` }).where('id', '=', current.id).execute();
    const { bindings, note, accept_shortfall, rate_change_set_id, ...values } = input;
    void accept_shortfall;
    const version = await tx.insertInto('route_version').values({ ...values, route_id: routeId, sequence: (current?.sequence ?? 0) + 1, created_by: actorId, note, fingerprint: routeVersionFingerprint(values), rate_change_set_id: rate_change_set_id ?? null }).returning(['id', 'sequence']).executeTakeFirstOrThrow();
    await tx.insertInto('route_binding').values(bindings.map((b, i) => ({ ...b, route_version_id: version.id, priority: i + 1 }))).execute();
    await this.audit.record(tx, { actorId, action: 'route.open_version', subjectType: 'route', subjectId: routeId, prior: current ? { version: current.id, sequence: current.sequence } : null, next: { version: version.id, sequence: version.sequence, changes: cmp.changes, note } });
    return { version_id: version.id, sequence: version.sequence, changes: cmp.changes, warnings_accepted: cmp.warnings };
  }
}
