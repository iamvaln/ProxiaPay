/**
 * The reference catalogue seeded at foundations (spec 16.1) with the corrections of spec 12.
 * The commercial annex naming the fifty route entries was not supplied alongside the
 * specification, so the routes below are a representative catalogue across the eleven countries
 * and five currencies the annex covers. Every fee is marked indicative, as the specification
 * requires until an agreement is signed, and the first live route is MTN Mobile Money collection
 * in Cameroon on the standard pattern.
 */
export const CURRENCIES = [
  { code: 'XAF', name: 'Central African CFA franc', exponent: 0 },
  { code: 'XOF', name: 'West African CFA franc', exponent: 0 },
  { code: 'GNF', name: 'Guinean franc', exponent: 0 },
  { code: 'CDF', name: 'Congolese franc', exponent: 2 },
  { code: 'USD', name: 'United States dollar', exponent: 2 },
];

export const COUNTRIES = [
  { code: 'CM', iso3: 'CMR', name: 'Cameroon', prefix: '+237', currencies: ['XAF'] },
  { code: 'GA', iso3: 'GAB', name: 'Gabon', prefix: '+241', currencies: ['XAF'] },
  { code: 'CG', iso3: 'COG', name: 'Republic of the Congo', prefix: '+242', currencies: ['XAF'] },
  { code: 'SN', iso3: 'SEN', name: 'Senegal', prefix: '+221', currencies: ['XOF'] },
  { code: 'CI', iso3: 'CIV', name: "Côte d'Ivoire", prefix: '+225', currencies: ['XOF'] },
  { code: 'BF', iso3: 'BFA', name: 'Burkina Faso', prefix: '+226', currencies: ['XOF'] },
  { code: 'ML', iso3: 'MLI', name: 'Mali', prefix: '+223', currencies: ['XOF'] },
  { code: 'TG', iso3: 'TGO', name: 'Togo', prefix: '+228', currencies: ['XOF'] },
  { code: 'BJ', iso3: 'BEN', name: 'Benin', prefix: '+229', currencies: ['XOF'] },
  { code: 'GN', iso3: 'GIN', name: 'Guinea', prefix: '+224', currencies: ['GNF'] }, // correction 2: GNF, not XOF
  { code: 'CD', iso3: 'COD', name: 'Democratic Republic of the Congo', prefix: '+243', currencies: ['CDF', 'USD'] }, // correction 1
];

export const PAYMENT_METHODS = [
  { code: 'MOMO', name: 'MTN Mobile Money' },
  { code: 'OM', name: 'Orange Money' },
  { code: 'MOOV', name: 'Moov Money' },
  { code: 'AIRTEL', name: 'Airtel Money' },
  { code: 'WAVE', name: 'Wave' },
  { code: 'MPESA', name: 'M-Pesa' },
  { code: 'FREE', name: 'Free Money' },
];

/** Country → currency → methods served. Both directions are seeded for each. */
export const ROUTE_CATALOGUE: { country: string; currency: string; methods: string[] }[] = [
  { country: 'CM', currency: 'XAF', methods: ['MOMO', 'OM'] },
  { country: 'GA', currency: 'XAF', methods: ['AIRTEL', 'MOOV'] }, // correction 3: Moov Money by its code
  { country: 'CG', currency: 'XAF', methods: ['MOMO', 'AIRTEL'] },
  { country: 'SN', currency: 'XOF', methods: ['OM', 'WAVE', 'FREE'] },
  { country: 'CI', currency: 'XOF', methods: ['MOMO', 'OM', 'MOOV', 'WAVE'] },
  { country: 'BF', currency: 'XOF', methods: ['OM', 'MOOV'] },
  { country: 'ML', currency: 'XOF', methods: ['OM', 'MOOV'] },
  { country: 'TG', currency: 'XOF', methods: ['MOOV', 'OM'] },
  { country: 'BJ', currency: 'XOF', methods: ['MOMO', 'MOOV'] },
  { country: 'GN', currency: 'GNF', methods: ['OM', 'MOMO'] },
  { country: 'CD', currency: 'CDF', methods: ['MPESA', 'AIRTEL', 'OM'] },
  { country: 'CD', currency: 'USD', methods: ['MPESA', 'AIRTEL', 'OM'] },
];

/** Amount limits per currency, minor units. */
export const ROUTE_LIMITS: Record<string, { min: number; max: number }> = {
  XAF: { min: 100, max: 1_000_000 },
  XOF: { min: 100, max: 1_000_000 },
  GNF: { min: 1000, max: 20_000_000 },
  CDF: { min: 100_000, max: 500_000_000 }, // 1,000.00 to 5,000,000.00 CDF
  USD: { min: 100, max: 500_000 }, // 1.00 to 5,000.00 USD
};

/** Indicative terms pending the signed agreement: 2.5 % processing, 0 platform, provider expected at 2 %. */
export const INDICATIVE_PROCESSING_BPS = 250;
export const INDICATIVE_PLATFORM_BPS = 0;
export const INDICATIVE_PROVIDER_BPS = 200;

/** Configured values of spec 14.7. Durations in seconds, money in XAF minor units. */
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  'session.idle_seconds': 30 * 60,
  'session.absolute_seconds': 12 * 60 * 60,
  'token.lifetime_seconds': 3600,
  'token.exchange_limit_per_minute': 10,
  'token.live_alert_threshold': 20,
  'auth.lockout_failures': 5,
  'auth.lockout_window_seconds': 15 * 60,
  'auth.lockout_seconds': 30 * 60,
  'confirmation.validity_seconds': 5 * 60,
  'confirmation.attempts': 3,
  'preview.validity_seconds': 15 * 60,
  'payer.code_window_seconds': 5 * 60,
  'payer.code_attempts': 3,
  'payer.browser_window_seconds': 10 * 60,
  'preview.alert_unconfirmed_per_hour': 5,
  'cashout.second_approval_above': 500_000,
  'adjustment.second_approval_above': 100_000,
  'float.cover_target_hours': 7 * 24,
  'float.cover_minimum_hours': 3 * 24,
  'breaker.failures': 5,
  'breaker.window_seconds': 5 * 60,
  'breaker.probe_interval_seconds': 2 * 60,
  'sweep.ceiling_collection_seconds': 2 * 60 * 60,
  'sweep.ceiling_disbursement_seconds': 6 * 60 * 60,
  'margin.alert_shortfall_24h': 25_000,
  'margin.alert_negative_hours': 6,
  'alert.ack_escalation_minutes': 30,
  'alert.quiet_period_hours': 24,
  'undetermined.stale_after_hours': 72,
  'rate_limit.requests_per_minute': 600,
  'api.request_rate_limit_per_minute': 600,
  'notification.max_attempts': 8,
};
