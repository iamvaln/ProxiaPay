import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { advisoryLock, DB_TOKEN, type Db, type Executor, type Tx } from '../db/database';
import type { DB } from '../db/schema.generated';
import type { Selectable } from 'kysely';
import { bpsToPercent, computeFee, compose, type Bearer, type Direction, type FeeTerms } from '../money/money';
import { sum } from '../money/money';

export type RouteVersionRow = Selectable<DB['route_version']>;
export type EntitlementVersionRow = Selectable<DB['entitlement_version']>;
export type BindingRow = Selectable<DB['route_binding']>;

export interface ResolvedTerms {
  processing: FeeTerms;
  platform: FeeTerms;
  processingBearer: Bearer;
  platformBearer: Bearer;
  /** Which record supplied each value, for the transaction's terms snapshot. */
  sources: Record<string, 'entitlement' | 'route'>;
}

export interface ResolvedLimits {
  minimum: number;
  maximum: number;
  count24h: number;
  value24h: number;
  count30d: number;
  value30d: number;
  sources: Record<string, 'entitlement' | 'route'>;
}

export interface Resolution {
  route: { id: string; countryCode: string; currencyCode: string; paymentMethodCode: string; direction: Direction };
  country: { code: string; name: string; diallingPrefix: string };
  currency: { code: string; exponent: number };
  paymentMethodName: string;
  routeVersion: RouteVersionRow;
  entitlement: { id: string };
  entitlementVersion: EntitlementVersionRow;
  terms: ResolvedTerms;
  limits: ResolvedLimits;
  payerAction: 'none' | 'code' | 'browser';
}

export interface Figures {
  processingFee: number;
  platformFee: number;
  chargedAmount: number;
  settledAmount: number;
  expectedProviderFee: number;
  remainders: { processing: number; platform: number; provider: number };
}

/**
 * Resolves what a payment will cost and whether it may proceed (spec 3.4, 5.2, 6): the four
 * gates, the entitlement-over-route field-by-field fee resolution, the limits, and the payer
 * action the route requires. Resolution happens at preview and the result is frozen there.
 */
@Injectable()
export class RouteResolver {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async resolve(exec: Executor, input: { projectId: string; direction: Direction; country: string; currency: string; paymentMethod: string; amount: number }): Promise<Resolution> {
    const country = await exec.selectFrom('country').selectAll().where('code', '=', input.country).executeTakeFirst();
    if (!country) throw new PlatformError('COUNTRY_UNKNOWN', `Country ${input.country} is unrecognised.`, { field: 'country' });
    const currency = await exec.selectFrom('currency').selectAll().where('code', '=', input.currency).executeTakeFirst();
    const supported = currency && (await exec.selectFrom('country_currency').select('currency_code').where('country_code', '=', country.code).where('currency_code', '=', currency.code).executeTakeFirst());
    if (!currency || !supported) throw new PlatformError('CURRENCY_UNKNOWN', `Currency ${input.currency} is unrecognised or unsupported in ${country.code}.`, { field: 'currency' });
    const method = await exec.selectFrom('payment_method').selectAll().where('code', '=', input.paymentMethod).executeTakeFirst();
    if (!method) throw new PlatformError('PAYMENT_METHOD_UNKNOWN', `Payment method ${input.paymentMethod} is unrecognised.`, { field: 'payment_method' });
    if (!country.active) throw new PlatformError('COUNTRY_DISABLED', `${country.name} is deactivated.`);

    const route = await exec.selectFrom('route').selectAll()
      .where('country_code', '=', country.code).where('currency_code', '=', currency.code)
      .where('payment_method_code', '=', method.code).where('direction', '=', input.direction).executeTakeFirst();
    if (!route) throw new PlatformError('ROUTE_UNAVAILABLE', 'No route exists for that combination.');
    const routeVersion = await exec.selectFrom('route_version').selectAll().where('route_id', '=', route.id).where('valid_to', 'is', null).executeTakeFirst();
    if (!routeVersion) throw new PlatformError('ROUTE_UNAVAILABLE', 'The route has no open version.');
    if (!routeVersion.active) throw new PlatformError('ROUTE_DISABLED', 'The route is inactive.');

    const entitlement = await exec.selectFrom('entitlement').select('id').where('project_id', '=', input.projectId).where('route_id', '=', route.id).executeTakeFirst();
    if (!entitlement) throw new PlatformError('ENTITLEMENT_MISSING', 'The project holds no grant for this route.');
    const entitlementVersion = await exec.selectFrom('entitlement_version').selectAll().where('entitlement_id', '=', entitlement.id).where('valid_to', 'is', null).executeTakeFirst();
    if (!entitlementVersion || !entitlementVersion.active) throw new PlatformError('ENTITLEMENT_DISABLED', 'The grant for this route is inactive.');

    const terms = resolveTerms(routeVersion, entitlementVersion);
    const limits = resolveLimits(routeVersion, entitlementVersion);
    if (input.amount < limits.minimum) throw new PlatformError('AMOUNT_BELOW_MINIMUM', 'Amount is below the minimum for this route.', { field: 'amount', details: { minimum: limits.minimum, currency: currency.code } });
    if (input.amount > limits.maximum) throw new PlatformError('AMOUNT_ABOVE_MAXIMUM', 'Amount is above the maximum for this route.', { field: 'amount', details: { maximum: limits.maximum, currency: currency.code } });

    return {
      route: { id: route.id, countryCode: route.country_code, currencyCode: route.currency_code, paymentMethodCode: route.payment_method_code, direction: route.direction as Direction },
      country: { code: country.code, name: country.name, diallingPrefix: country.dialling_prefix },
      currency: { code: currency.code, exponent: currency.exponent },
      paymentMethodName: method.name,
      routeVersion,
      entitlement,
      entitlementVersion,
      terms,
      limits,
      payerAction: routeVersion.otp_required ? 'code' : routeVersion.browser_required ? 'browser' : 'none',
    };
  }

  /** The bindings a payment may be sent to, in fallback order, excluding suspended accounts, open breakers, and narrower limits the amount falls outside. */
  async availableBindings(exec: Executor, routeVersionId: string, amount: number): Promise<(BindingRow & { provider_code: string; adapter_key: string; account_status: string; breaker_state: string | null })[]> {
    const rows = await exec
      .selectFrom('route_binding as b')
      .innerJoin('provider_account as pa', 'pa.id', 'b.provider_account_id')
      .innerJoin('provider as p', 'p.code', 'pa.provider_code')
      .leftJoin('circuit_breaker as cb', 'cb.provider_account_id', 'pa.id')
      .selectAll('b')
      .select(['p.code as provider_code', 'p.adapter_key', 'pa.status as account_status', 'cb.state as breaker_state'])
      .where('b.route_version_id', '=', routeVersionId)
      .where('b.enabled', '=', true)
      .orderBy('b.priority')
      .execute();
    return rows.filter((b) =>
      b.account_status !== 'suspended' && b.breaker_state !== 'open'
      && (b.minimum_amount == null || amount >= b.minimum_amount) && (b.maximum_amount == null || amount <= b.maximum_amount));
  }

  computeFigures(resolution: Resolution, amount: number, binding: Pick<BindingRow, 'expected_fee_bps' | 'expected_fee_fixed'> | undefined): Figures {
    const processing = computeFee(amount, resolution.terms.processing);
    const platform = computeFee(amount, resolution.terms.platform);
    const provider = binding ? computeFee(amount, { bps: binding.expected_fee_bps, fixed: binding.expected_fee_fixed }) : { amount: 0, remainder: 0 };
    const c = compose({
      direction: resolution.route.direction, requested: amount, processingFee: processing.amount, platformFee: platform.amount,
      processingBearer: resolution.terms.processingBearer, platformBearer: resolution.terms.platformBearer,
    });
    // charged: what the payer is debited (collection) or what the project's balance carries (disbursement).
    // settled: what the project receives (collection) or what the recipient receives (disbursement).
    const charged = resolution.route.direction === 'collection' ? c.counterpartyAmount : c.projectAmount;
    const settled = resolution.route.direction === 'collection' ? c.projectAmount : c.counterpartyAmount;
    return {
      processingFee: processing.amount, platformFee: platform.amount, chargedAmount: charged, settledAmount: settled, expectedProviderFee: provider.amount,
      remainders: { processing: processing.remainder, platform: platform.remainder, provider: provider.remainder },
    };
  }

  /**
   * Velocity caps, evaluated under a lock on the entitlement so simultaneous confirmations cannot
   * each observe the same remaining allowance (spec 15.4). Succeeded and in-flight transactions
   * consume a cap; failed and expired ones release it.
   */
  async checkVelocity(tx: Tx, resolution: Resolution, amount: number): Promise<void> {
    await advisoryLock(tx, 'entitlement', resolution.entitlement.id);
    const projectId = await tx.selectFrom('entitlement').select('project_id').where('id', '=', resolution.entitlement.id).executeTakeFirstOrThrow();
    for (const [window, interval, countCap, valueCap] of [
      ['24h', sql`interval '24 hours'`, resolution.limits.count24h, resolution.limits.value24h],
      ['30d', sql`interval '30 days'`, resolution.limits.count30d, resolution.limits.value30d],
    ] as const) {
      const { rows } = await sql<{ n: number; total: number; oldest: Date | null }>`
        select count(*)::int as n, coalesce(sum(requested_amount), 0)::bigint as total, min(created_at) as oldest
          from transaction
         where project_id = ${projectId.project_id} and route_id = ${resolution.route.id}
           and created_at > now() - ${interval}
           and state in ('created', 'action_required', 'submitted', 'processing', 'succeeded', 'undetermined')`.execute(tx);
      const { n, total, oldest } = rows[0]!;
      const resetsAt = oldest ? new Date(oldest.getTime() + (window === '24h' ? 24 * 3600_000 : 30 * 24 * 3600_000)) : new Date();
      if (n + 1 > countCap) throw new PlatformError('VELOCITY_COUNT_EXCEEDED', `The ${window} transaction count cap is reached.`, { details: { window, cap: countCap, resets_at: resetsAt.toISOString() } });
      if (sum(total, amount) > valueCap) throw new PlatformError('VELOCITY_VALUE_EXCEEDED', `The ${window} transaction value cap is reached.`, { details: { window, cap: valueCap, currency: resolution.currency.code, resets_at: resetsAt.toISOString() } });
    }
  }

  /** What a project may currently do (API reference 5.8), with the rates resolved for it. */
  async settingsForProject(projectId: string) {
    const rows = await this.db
      .selectFrom('entitlement as e')
      .innerJoin('entitlement_version as ev', (j) => j.onRef('ev.entitlement_id', '=', 'e.id').on('ev.valid_to', 'is', null))
      .innerJoin('route as r', 'r.id', 'e.route_id')
      .innerJoin('route_version as rv', (j) => j.onRef('rv.route_id', '=', 'r.id').on('rv.valid_to', 'is', null))
      .innerJoin('country as c', 'c.code', 'r.country_code')
      .innerJoin('currency as cur', 'cur.code', 'r.currency_code')
      .innerJoin('payment_method as pm', 'pm.code', 'r.payment_method_code')
      .selectAll('rv')
      .select([
        'ev.minimum_amount as ev_min', 'ev.maximum_amount as ev_max', 'ev.count_24h', 'ev.value_24h', 'ev.count_30d', 'ev.value_30d',
        'ev.processing_fee_bps as ev_processing_bps', 'ev.processing_fee_fixed as ev_processing_fixed', 'ev.platform_fee_bps as ev_platform_bps', 'ev.platform_fee_fixed as ev_platform_fixed',
        'ev.processing_fee_bearer as ev_processing_bearer', 'ev.platform_fee_bearer as ev_platform_bearer', 'ev.active as ev_active',
        'r.country_code', 'r.currency_code', 'r.payment_method_code', 'r.direction', 'c.name as country_name', 'c.dialling_prefix', 'c.active as country_active', 'cur.exponent', 'pm.name as method_name',
      ])
      .where('e.project_id', '=', projectId)
      .orderBy(['r.country_code', 'r.payment_method_code', 'r.direction'])
      .execute();
    const routes = rows
      .filter((r) => r.country_active && r.active && r.ev_active)
      .map((r) => {
        const rv = r as unknown as RouteVersionRow;
        const ev = {
          processing_fee_bps: r.ev_processing_bps, processing_fee_fixed: r.ev_processing_fixed, platform_fee_bps: r.ev_platform_bps, platform_fee_fixed: r.ev_platform_fixed,
          processing_fee_bearer: r.ev_processing_bearer, platform_fee_bearer: r.ev_platform_bearer, minimum_amount: r.ev_min, maximum_amount: r.ev_max,
          count_24h: r.count_24h, value_24h: r.value_24h, count_30d: r.count_30d, value_30d: r.value_30d,
        } as EntitlementVersionRow;
        const terms = resolveTerms(rv, ev);
        const limits = resolveLimits(rv, ev);
        return {
          country: r.country_code, country_name: r.country_name, dialling_prefix: r.dialling_prefix, currency: r.currency_code,
          payment_method: r.payment_method_code, payment_method_name: r.method_name, direction: r.direction,
          fees: {
            processing: { percentage: bpsToPercent(terms.processing.bps), fixed: terms.processing.fixed, bearer: terms.processingBearer },
            platform: { percentage: bpsToPercent(terms.platform.bps), fixed: terms.platform.fixed, bearer: terms.platformBearer },
          },
          minimum_amount: limits.minimum, maximum_amount: limits.maximum,
          payer_action: r.otp_required ? 'code' : r.browser_required ? 'browser' : 'none',
          velocity: { count_24h: limits.count24h, value_24h: limits.value24h, count_30d: limits.count30d, value_30d: limits.value30d },
        };
      });
    const currencies = [...new Map(rows.map((r) => [r.currency_code, { code: r.currency_code, exponent: r.exponent }])).values()];
    return { currencies, routes };
  }
}

export function resolveTerms(rv: RouteVersionRow, ev: EntitlementVersionRow): ResolvedTerms {
  const sources: Record<string, 'entitlement' | 'route'> = {};
  const pick = <T>(key: string, e: T | null | undefined, r: T): T => {
    sources[key] = e == null ? 'route' : 'entitlement';
    return e == null ? r : e;
  };
  const processing: FeeTerms = ev.processing_fee_bps != null
    ? { bps: pick('processing_fee_bps', ev.processing_fee_bps, rv.processing_fee_bps), fixed: ev.processing_fee_fixed ?? 0, floor: null, ceiling: null }
    : { bps: pick('processing_fee_bps', null, rv.processing_fee_bps), fixed: rv.processing_fee_fixed, floor: rv.processing_fee_floor, ceiling: rv.processing_fee_ceiling };
  const platform: FeeTerms = ev.platform_fee_bps != null
    ? { bps: pick('platform_fee_bps', ev.platform_fee_bps, rv.platform_fee_bps), fixed: ev.platform_fee_fixed ?? 0, floor: null, ceiling: null }
    : { bps: pick('platform_fee_bps', null, rv.platform_fee_bps), fixed: rv.platform_fee_fixed, floor: rv.platform_fee_floor, ceiling: rv.platform_fee_ceiling };
  return {
    processing,
    platform,
    processingBearer: pick('processing_fee_bearer', ev.processing_fee_bearer as Bearer | null, rv.processing_fee_bearer as Bearer),
    platformBearer: pick('platform_fee_bearer', ev.platform_fee_bearer as Bearer | null, rv.platform_fee_bearer as Bearer),
    sources,
  };
}

export function resolveLimits(rv: RouteVersionRow, ev: EntitlementVersionRow): ResolvedLimits {
  const sources: Record<string, 'entitlement' | 'route'> = {};
  // An entitlement may narrow a route's limits, never widen them.
  const minimum = ev.minimum_amount != null && ev.minimum_amount > rv.minimum_amount ? ((sources.minimum = 'entitlement'), ev.minimum_amount) : ((sources.minimum = 'route'), rv.minimum_amount);
  const maximum = ev.maximum_amount != null && ev.maximum_amount < rv.maximum_amount ? ((sources.maximum = 'entitlement'), ev.maximum_amount) : ((sources.maximum = 'route'), rv.maximum_amount);
  return { minimum, maximum, count24h: ev.count_24h, value24h: ev.value_24h, count30d: ev.count_30d, value30d: ev.value_30d, sources: { ...sources, velocity: 'entitlement' } };
}
