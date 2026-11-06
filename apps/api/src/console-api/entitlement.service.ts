import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { DB_TOKEN, type Db, type Tx } from '../db/database';
import { AuditService } from '../audit/audit.service';
import { computeFee, subtract } from '../money/money';
import type { GrantedRoute } from './client-views';

export const entitlementInputSchema = z.object({
  route_id: z.string().uuid(),
  minimum_amount: z.number().int().min(0).nullable().default(null),
  maximum_amount: z.number().int().min(0).nullable().default(null),
  count_24h: z.number().int().min(0),
  value_24h: z.number().int().min(0),
  count_30d: z.number().int().min(0),
  value_30d: z.number().int().min(0),
  processing_fee_bps: z.number().int().min(0).nullable().default(null),
  processing_fee_fixed: z.number().int().min(0).nullable().default(null),
  platform_fee_bps: z.number().int().min(0).nullable().default(null),
  platform_fee_fixed: z.number().int().min(0).nullable().default(null),
  processing_fee_bearer: z.enum(['counterparty', 'project']).nullable().default(null),
  platform_fee_bearer: z.enum(['counterparty', 'project']).nullable().default(null),
  note: z.string().trim().min(1).max(512),
  accept_shortfall: z.boolean().default(false),
});
export type EntitlementInput = z.infer<typeof entitlementInputSchema>;

/** Entitlements as versioned grants (spec 3.4), with the below-cost warning of spec 6.2 at the moment of the grant. */
@Injectable()
export class EntitlementService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly audit: AuditService) {}

  async listForProject(projectId: string) {
    const rows = await this.db
      .selectFrom('entitlement as e')
      .innerJoin('route as r', 'r.id', 'e.route_id')
      .innerJoin('route_version as rv', (j) => j.onRef('rv.route_id', '=', 'r.id').on('rv.valid_to', 'is', null))
      .leftJoin('entitlement_version as ev', (j) => j.onRef('ev.entitlement_id', '=', 'e.id').on('ev.valid_to', 'is', null))
      .select(['e.id', 'e.route_id', 'r.country_code', 'r.currency_code', 'r.payment_method_code', 'r.direction', 'ev.id as version_id', 'ev.sequence', 'ev.active', 'ev.minimum_amount', 'ev.maximum_amount',
        'ev.count_24h', 'ev.value_24h', 'ev.count_30d', 'ev.value_30d', 'ev.processing_fee_bps', 'ev.processing_fee_fixed', 'ev.platform_fee_bps', 'ev.platform_fee_fixed', 'ev.processing_fee_bearer', 'ev.platform_fee_bearer', 'ev.note', 'ev.valid_from',
        'rv.processing_fee_bps as route_processing_fee_bps', 'rv.platform_fee_bps as route_platform_fee_bps', 'rv.processing_fee_bearer as route_processing_fee_bearer', 'rv.platform_fee_bearer as route_platform_fee_bearer', 'rv.minimum_amount as route_minimum', 'rv.maximum_amount as route_maximum'])
      .where('e.project_id', '=', projectId)
      .orderBy(['r.country_code', 'r.payment_method_code', 'r.direction'])
      .execute();
    const history = await this.db.selectFrom('entitlement_version as v').innerJoin('entitlement as e', 'e.id', 'v.entitlement_id').leftJoin('administrator as a', 'a.id', 'v.created_by').select(['v.entitlement_id', 'v.sequence', 'v.valid_from', 'v.valid_to', 'v.note', 'v.active', 'a.name as author']).where('e.project_id', '=', projectId).orderBy('v.sequence', 'desc').execute();
    return rows.map((r) => ({ ...r, history: history.filter((h) => h.entitlement_id === r.id) }));
  }

  /** Each open grant of the project with the open version of its route, for resolving the project's own terms; a route without an open version is left out. */
  async termsForProject(projectId: string): Promise<GrantedRoute[]> {
    const grants = await this.db
      .selectFrom('entitlement as e')
      .innerJoin('entitlement_version as ev', (j) => j.onRef('ev.entitlement_id', '=', 'e.id').on('ev.valid_to', 'is', null))
      .innerJoin('route as r', 'r.id', 'e.route_id')
      .innerJoin('payment_method as pm', 'pm.code', 'r.payment_method_code')
      .innerJoin('country as c', 'c.code', 'r.country_code')
      .selectAll('ev')
      .select(['r.id as route_id', 'r.country_code', 'r.payment_method_code', 'r.direction', 'r.currency_code', 'pm.name as payment_method_name', 'c.active as country_active'])
      .where('e.project_id', '=', projectId)
      .orderBy(['r.country_code', 'r.payment_method_code', 'r.direction', 'r.currency_code'])
      .execute();
    if (!grants.length) return [];
    const versions = await this.db.selectFrom('route_version').selectAll().where('route_id', 'in', grants.map((g) => g.route_id)).where('valid_to', 'is', null).execute();
    return grants.flatMap(({ route_id, country_code, payment_method_code, direction, currency_code, payment_method_name, country_active, ...entitlementVersion }) => {
      const routeVersion = versions.find((v) => v.route_id === route_id);
      return routeVersion ? [{ country_code, payment_method_code, payment_method_name, direction, currency_code, country_active, routeVersion, entitlementVersion }] : [];
    });
  }

  /** Warns where a rate granted here sits below what the route's provider is expected to charge (spec 3.4). */
  async shortfall(routeId: string, processingBps: number | null): Promise<{ binding_provider: string; expected_fee_bps: number; processing_fee_bps: number; shortfall_per_10000: number } | null> {
    const rv = await this.db.selectFrom('route_version').select(['id', 'processing_fee_bps']).where('route_id', '=', routeId).where('valid_to', 'is', null).executeTakeFirst();
    if (!rv) return null;
    const bps = processingBps ?? rv.processing_fee_bps;
    const binding = await this.db.selectFrom('route_binding as b').innerJoin('provider_account as pa', 'pa.id', 'b.provider_account_id').select(['b.expected_fee_bps', 'b.expected_fee_fixed', 'pa.name']).where('b.route_version_id', '=', rv.id).where('b.enabled', '=', true).orderBy('b.priority').executeTakeFirst();
    if (!binding || binding.expected_fee_bps <= bps) return null;
    const sample = 10_000;
    return { binding_provider: binding.name, expected_fee_bps: binding.expected_fee_bps, processing_fee_bps: bps, shortfall_per_10000: subtract(computeFee(sample, { bps: binding.expected_fee_bps, fixed: binding.expected_fee_fixed }).amount, computeFee(sample, { bps, fixed: 0 }).amount) };
  }

  /** `opts.tx` joins the caller's transaction; `opts.auditAction` replaces the grant/amend action name (the sandbox's automatic grants). */
  async grantOrAmend(projectId: string, input: EntitlementInput, actorId: string | null, opts: { tx?: Tx; auditAction?: string } = {}) {
    const warning = await this.shortfall(input.route_id, input.processing_fee_bps);
    if (warning && !input.accept_shortfall) throw new PlatformError('RULE_VIOLATION', 'The processing rate sits below the expected provider fee; accept the shortfall deliberately or correct the rate.', { details: { warning } });
    if ((input.processing_fee_bps == null) !== (input.processing_fee_fixed == null)) input.processing_fee_fixed = input.processing_fee_bps == null ? null : (input.processing_fee_fixed ?? 0);
    if ((input.platform_fee_bps == null) !== (input.platform_fee_fixed == null)) input.platform_fee_fixed = input.platform_fee_bps == null ? null : (input.platform_fee_fixed ?? 0);
    const run = async (tx: Tx) => {
      await sql`select pg_advisory_xact_lock(hashtext('entitlement_grant'), hashtext(${projectId + input.route_id}))`.execute(tx);
      let ent = await tx.selectFrom('entitlement').select('id').where('project_id', '=', projectId).where('route_id', '=', input.route_id).executeTakeFirst();
      if (!ent) ent = await tx.insertInto('entitlement').values({ project_id: projectId, route_id: input.route_id }).returning('id').executeTakeFirstOrThrow();
      const current = await tx.selectFrom('entitlement_version').selectAll().where('entitlement_id', '=', ent.id).where('valid_to', 'is', null).forUpdate().executeTakeFirst();
      if (current) await tx.updateTable('entitlement_version').set({ valid_to: sql`now()` }).where('id', '=', current.id).execute();
      const { note, accept_shortfall, route_id, ...values } = input;
      void accept_shortfall; void route_id;
      const version = await tx.insertInto('entitlement_version').values({ ...values, entitlement_id: ent.id, sequence: (current?.sequence ?? 0) + 1, active: true, created_by: actorId, note }).returning(['id', 'sequence']).executeTakeFirstOrThrow();
      await this.audit.record(tx, { actorId, action: opts.auditAction ?? (current ? 'entitlement.amend' : 'entitlement.grant'), subjectType: 'entitlement', subjectId: ent.id, prior: current ?? null, next: { ...values, note, sequence: version.sequence } });
      return { entitlement_id: ent.id, version_id: version.id, sequence: version.sequence, warning_accepted: warning ?? null };
    };
    return opts.tx ? run(opts.tx) : this.db.transaction().execute(run);
  }

  /** An entitlement is reached through its own project only; another project's id answers as missing. */
  private async owned(exec: Db | Tx, projectId: string, entitlementId: string) {
    const found = await exec.selectFrom('entitlement').select('id').where('id', '=', entitlementId).where('project_id', '=', projectId).executeTakeFirst();
    if (!found) throw new PlatformError('NOT_FOUND', 'No such entitlement.');
  }

  async deactivate(projectId: string, entitlementId: string, note: string, actorId: string) {
    await this.db.transaction().execute(async (tx) => {
      await this.owned(tx, projectId, entitlementId);
      const current = await tx.selectFrom('entitlement_version').selectAll().where('entitlement_id', '=', entitlementId).where('valid_to', 'is', null).forUpdate().executeTakeFirst();
      if (!current) throw new PlatformError('NOT_FOUND', 'No open entitlement version.');
      await tx.updateTable('entitlement_version').set({ valid_to: sql`now()` }).where('id', '=', current.id).execute();
      const { id, sequence, valid_from, valid_to, created_at, created_by, note: _n, ...values } = current;
      void id; void valid_from; void valid_to; void created_at; void created_by; void _n;
      await tx.insertInto('entitlement_version').values({ ...values, sequence: sequence + 1, active: false, created_by: actorId, note }).execute();
      await this.audit.record(tx, { actorId, action: 'entitlement.deactivate', subjectType: 'entitlement', subjectId: entitlementId, prior: { active: true }, next: { active: false, note } });
    });
  }

  /** Transactions currently in flight under a grant complete under the terms they began with (console spec 6.2). */
  async inFlight(projectId: string, entitlementId: string) {
    await this.owned(this.db, projectId, entitlementId);
    return this.db.selectFrom('transaction as t').innerJoin('entitlement_version as v', 'v.id', 't.entitlement_version_id').select(['t.reference', 't.state', 't.requested_amount', 't.currency_code', 't.created_at']).where('v.entitlement_id', '=', entitlementId).where('t.state', 'in', ['created', 'submitted', 'processing', 'action_required', 'undetermined']).execute();
  }
}
