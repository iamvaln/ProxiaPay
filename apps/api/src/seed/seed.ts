import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Executor } from '../db/database';
import { SEEDED_ROLES } from '../permissions/permissions';
import {
  COUNTRIES, CURRENCIES, DEFAULT_SETTINGS, INDICATIVE_PLATFORM_BPS, INDICATIVE_PROCESSING_BPS, INDICATIVE_PROVIDER_BPS,
  PAYMENT_METHODS, ROUTE_CATALOGUE, ROUTE_LIMITS,
} from './catalogue';

export type AlertGroupName = 'Finance' | 'Developers' | 'Administrators';

export interface SeedOptions {
  withRoutes?: boolean;
  environment?: 'production' | 'sandbox';
  /** Initial email address per alert group; a group already holding one keeps it. */
  alertAddresses?: Partial<Record<AlertGroupName, string>>;
}

/** Idempotent: every insert is ON CONFLICT DO NOTHING, so re-running the seed changes nothing already present. */
export async function seedReferenceData(db: Executor, opts: SeedOptions = {}): Promise<void> {
  const withRoutes = opts.withRoutes ?? true;
  const environment = opts.environment ?? 'sandbox';

  await db.insertInto('currency').values(CURRENCIES.map((c) => ({ code: c.code, name: c.name, exponent: c.exponent }))).onConflict((oc) => oc.doNothing()).execute();
  await db.insertInto('country').values(COUNTRIES.map((c) => ({ code: c.code, iso3: c.iso3, name: c.name, dialling_prefix: c.prefix }))).onConflict((oc) => oc.doNothing()).execute();
  await db
    .insertInto('country_currency')
    .values(COUNTRIES.flatMap((c) => c.currencies.map((cur) => ({ country_code: c.code, currency_code: cur }))))
    .onConflict((oc) => oc.doNothing())
    .execute();
  await db.insertInto('payment_method').values(PAYMENT_METHODS).onConflict((oc) => oc.doNothing()).execute();

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.insertInto('platform_setting').values({ key, value: JSON.stringify(value) }).onConflict((oc) => oc.doNothing()).execute();
  }

  for (const role of SEEDED_ROLES) {
    await db.insertInto('role').values({ name: role.name, description: role.description, seeded: true }).onConflict((oc) => oc.doNothing()).execute();
    const r = await db.selectFrom('role').select('id').where('name', '=', role.name).executeTakeFirstOrThrow();
    await db.insertInto('role_permission').values(role.permissions.map((p) => ({ role_id: r.id, permission_key: p }))).onConflict((oc) => oc.doNothing()).execute();
  }

  // Alert groups and default routing of spec 8.6.
  for (const g of [
    { name: 'Finance', description: 'Treasury and reconciliation' },
    { name: 'Developers', description: 'Service health' },
    { name: 'Administrators', description: 'Security' },
  ]) {
    await db.insertInto('alert_group').values(g).onConflict((oc) => oc.doNothing()).execute();
  }
  const groups = Object.fromEntries((await db.selectFrom('alert_group').select(['id', 'name']).execute()).map((g) => [g.name, g.id]));
  // Delivery addresses come from the environment only on first seed; the console owns them afterwards.
  for (const [name, address] of Object.entries(opts.alertAddresses ?? {}) as [AlertGroupName, string | undefined][]) {
    if (!address) continue;
    await db.insertInto('alert_group_address').values({ group_id: groups[name]!, channel: 'email', address }).onConflict((oc) => oc.doNothing()).execute();
  }
  for (const [category, group, ack] of [
    ['treasury', 'Finance', true], ['reconciliation', 'Finance', false], ['service_health', 'Developers', false], ['security', 'Administrators', true],
  ] as const) {
    await db.insertInto('alert_policy').values({ category, minimum_severity: 'warning', acknowledgement_required: ack, escalation_minutes: 30, escalation_group_id: groups['Administrators']! }).onConflict((oc) => oc.doNothing()).execute();
    await db.insertInto('alert_policy_group').values({ category, group_id: groups[group]! }).onConflict((oc) => oc.doNothing()).execute();
  }

  // Providers: Ejara Pay (spec 12) and the simulator that stands in for it in sandbox (spec 11).
  await db.insertInto('provider').values([
    { code: 'ejara', name: 'Ejara Pay', adapter_key: 'ejara' },
    { code: 'simulator', name: 'Simulator', adapter_key: 'simulator' },
  ]).onConflict((oc) => oc.doNothing()).execute();

  const accountName = environment === 'production' ? 'Ejara Pay (production)' : 'Simulator (sandbox)';
  const providerCode = environment === 'production' ? 'ejara' : 'simulator';
  await db
    .insertInto('provider_account')
    .values({
      provider_code: providerCode,
      name: accountName,
      base_url: environment === 'production' ? 'https://ejara-pay.vercel.app' : 'simulator://local',
      supports_transfers: false,
      supports_listing: false, // both providers reconcile from uploaded statements (spec 12, 18)
      has_test_environment: providerCode === 'simulator',
      statement_format: 'ejara_csv_v1',
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  const account = await db.selectFrom('provider_account').select('id').where('name', '=', accountName).executeTakeFirstOrThrow();
  await db.insertInto('circuit_breaker').values({ provider_account_id: account.id }).onConflict((oc) => oc.doNothing()).execute();

  if (!withRoutes) return;

  for (const entry of ROUTE_CATALOGUE) {
    for (const method of entry.methods) {
      for (const direction of ['collection', 'disbursement'] as const) {
        await db.insertInto('provider_account_capability').values({
          provider_account_id: account.id, country_code: entry.country, currency_code: entry.currency, payment_method_code: method, direction,
        }).onConflict((oc) => oc.doNothing()).execute();
        await db.insertInto('route').values({ country_code: entry.country, currency_code: entry.currency, payment_method_code: method, direction }).onConflict((oc) => oc.doNothing()).execute();
        const route = await db.selectFrom('route').select('id')
          .where('country_code', '=', entry.country).where('currency_code', '=', entry.currency)
          .where('payment_method_code', '=', method).where('direction', '=', direction).executeTakeFirstOrThrow();
        const existing = await db.selectFrom('route_version').select('id').where('route_id', '=', route.id).executeTakeFirst();
        if (existing) continue;
        const limits = ROUTE_LIMITS[entry.currency]!;
        const version = {
          route_id: route.id,
          sequence: 1,
          processing_fee_bps: INDICATIVE_PROCESSING_BPS,
          processing_fee_fixed: 0,
          platform_fee_bps: INDICATIVE_PLATFORM_BPS,
          platform_fee_fixed: 0,
          processing_fee_bearer: 'counterparty',
          platform_fee_bearer: 'counterparty',
          minimum_amount: limits.min,
          maximum_amount: limits.max,
          otp_required: false, // correction 4: interaction requirements come from the verified source, not the annex columns
          browser_required: false,
          disbursement_fallback: false,
          active: true,
          note: 'Seeded from the commercial annex with the corrections of specification section 12. Terms indicative.',
        };
        const fingerprint = routeVersionFingerprint(version);
        const rv = await db.insertInto('route_version').values({ ...version, fingerprint }).returning('id').executeTakeFirstOrThrow();
        await db.insertInto('route_binding').values({
          route_version_id: rv.id, provider_account_id: account.id, expected_fee_bps: INDICATIVE_PROVIDER_BPS[direction], expected_fee_fixed: 0,
          terms_status: 'indicative', priority: 1, enabled: true,
        }).execute();
      }
    }
  }
}

/** Fingerprint over a version's commercial contents; stable across column order. */
export function routeVersionFingerprint(v: Record<string, unknown>): string {
  const keys = ['processing_fee_bps', 'processing_fee_fixed', 'processing_fee_floor', 'processing_fee_ceiling', 'platform_fee_bps', 'platform_fee_fixed',
    'platform_fee_floor', 'platform_fee_ceiling', 'processing_fee_bearer', 'platform_fee_bearer', 'minimum_amount', 'maximum_amount', 'otp_required',
    'browser_required', 'disbursement_fallback', 'active'];
  const canon = keys.map((k) => `${k}=${v[k] ?? ''}`).join('|');
  return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

export async function countRoutes(db: Executor): Promise<number> {
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from route`.execute(db);
  return rows[0]!.n;
}
