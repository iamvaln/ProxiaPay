/**
 * The one module in which fee arithmetic happens (spec 15.7). Every input is an integer in
 * minor units or an integer rate in basis points (hundredths of a percent), every output is an
 * integer, rounding is half-up, and the remainder discarded by rounding is returned so it can be
 * recorded on the transaction. No floating point number touches money here or anywhere else.
 */

export type Bearer = 'counterparty' | 'project';
export type Direction = 'collection' | 'disbursement';

export interface FeeTerms {
  /** Rate in basis points: 250 is 2.5 percent. */
  bps: number;
  /** Fixed component in minor units. */
  fixed: number;
  floor?: number | null;
  ceiling?: number | null;
}

export interface FeeResult {
  amount: number;
  /** Remainder in hundred-thousandths of a minor unit (numerator over 10000) discarded by rounding. */
  remainder: number;
}

export function assertMinorUnits(value: unknown, field = 'amount'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer in minor units`);
  }
  return value;
}

function assertRate(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer in basis points`);
  }
  return value;
}

/** Computes a fee on a base amount: base × bps ÷ 10000, half-up, plus the fixed part, within floor and ceiling. */
export function computeFee(base: number, terms: FeeTerms): FeeResult {
  assertMinorUnits(base, 'base');
  assertRate(terms.bps, 'bps');
  assertMinorUnits(terms.fixed, 'fixed');
  const product = base * terms.bps;
  if (!Number.isSafeInteger(product)) throw new RangeError('fee computation overflows the safe integer range');
  let variable = Math.floor(product / 10000);
  const remainder = product - variable * 10000;
  if (remainder * 2 >= 10000) variable += 1; // half-up
  let amount = variable + terms.fixed;
  if (terms.floor != null && amount < terms.floor) amount = terms.floor;
  if (terms.ceiling != null && amount > terms.ceiling) amount = terms.ceiling;
  return { amount, remainder: remainder * 2 >= 10000 ? remainder - 10000 : remainder };
}

export interface CompositionInput {
  direction: Direction;
  requested: number;
  processingFee: number;
  platformFee: number;
  processingBearer: Bearer;
  platformBearer: Bearer;
}

export interface Composition {
  /** What the counterparty experiences: debited on a collection, received on a disbursement. */
  counterpartyAmount: number;
  /** What the project's balance experiences: credited on a collection, debited on a disbursement. */
  projectAmount: number;
  /** Fees borne by the counterparty (X in spec 6.1). */
  counterpartyFees: number;
  /** Fees borne by the project (Y in spec 6.1). */
  projectFees: number;
}

/**
 * Spec 6.1: a fee borne by the counterparty moves what the counterparty experiences; a fee borne
 * by the project moves what the project's balance experiences. All fees are computed on R.
 */
export function compose(input: CompositionInput): Composition {
  const r = assertMinorUnits(input.requested, 'requested');
  const x = (input.processingBearer === 'counterparty' ? input.processingFee : 0) + (input.platformBearer === 'counterparty' ? input.platformFee : 0);
  const y = (input.processingBearer === 'project' ? input.processingFee : 0) + (input.platformBearer === 'project' ? input.platformFee : 0);
  if (input.direction === 'collection') {
    return { counterpartyAmount: r + x, projectAmount: r - y, counterpartyFees: x, projectFees: y };
  }
  return { counterpartyAmount: r - x, projectAmount: r + y, counterpartyFees: x, projectFees: y };
}

/** Sum of a list of amounts, refusing non-integers. Provided so callers never write `+` over money themselves. */
export function sum(...amounts: number[]): number {
  let total = 0;
  for (const a of amounts) total += assertMinorUnits(a);
  return total;
}

export function subtract(a: number, b: number): number {
  return assertMinorUnits(a) - assertMinorUnits(b);
}

/** How a provider rounds the fee it adds on top. Ejara rounds up on collections; the simulator rounds half-up. */
export type ProviderRounding = 'ceil' | 'half_up';

function providerFee(amount: number, terms: FeeTerms, rounding: ProviderRounding): number {
  if (rounding === 'half_up') return computeFee(amount, terms).amount;
  const product = amount * terms.bps;
  if (!Number.isSafeInteger(product)) throw new RangeError('fee computation overflows the safe integer range');
  const whole = Math.floor(product / 10000);
  return (product - whole * 10000 > 0 ? whole + 1 : whole) + terms.fixed;
}

/**
 * For a provider that adds its fee on top of the amount it is sent: the largest amount A such that
 * A + fee(A) does not exceed `target`, which is what the payer was quoted. Sending A makes the payer's
 * debit land on the quote exactly where the provider's rounding allows it, and one unit under where it
 * does not — at 2 percent rounded up, 102 and 104 are reachable and 103 is not. The payer is never
 * debited more than quoted; the shortfall, when there is one, comes out of the platform's margin.
 */
export function providerAmountWithin(target: number, terms: FeeTerms, rounding: ProviderRounding): { amount: number; debit: number; fee: number } {
  assertMinorUnits(target, 'target');
  assertRate(terms.bps, 'bps');
  assertMinorUnits(terms.fixed, 'fixed');
  const debitOf = (a: number) => a + providerFee(a, terms, rounding);
  // A + A·bps/10000 + fixed ≤ target gives the starting point; rounding moves the answer by a unit or two.
  let amount = Math.floor(((target - terms.fixed) * 10000) / (10000 + terms.bps));
  while (amount > 0 && debitOf(amount) > target) amount -= 1;
  while (debitOf(amount + 1) <= target) amount += 1;
  if (amount <= 0) throw new RangeError('the provider fee consumes the whole quote');
  const fee = providerFee(amount, terms, rounding);
  return { amount, debit: amount + fee, fee };
}

/** Margin is computed, never stored: processing fee less the actual provider fee, and may be negative. */
export function margin(processingFee: number, actualProviderFee: number | null): number | null {
  if (actualProviderFee == null) return null;
  return subtract(processingFee, actualProviderFee);
}

/** Renders minor units in a currency's major units for logs and messages (never for arithmetic). */
export function formatAmount(minor: number, exponent: number): string {
  assertMinorUnits(minor);
  if (exponent === 0) return String(minor);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const s = String(abs).padStart(exponent + 1, '0');
  return `${sign}${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
}

/** Parses a decimal-string rate such as "2.5" into basis points, refusing more than two decimals. */
export function percentToBps(percent: string): number {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(percent.trim());
  if (!m) throw new TypeError(`rate ${percent} is not a percentage with at most two decimals`);
  const whole = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(2, '0');
  return whole * 100 + Number(frac);
}

export function bpsToPercent(bps: number): string {
  assertRate(bps, 'bps');
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/** A ratio of two amounts for reporting (coverage, success rates): never money itself. Null where the divisor is zero. */
export function ratio(numerator: number, denominator: number, decimals = 3): number | null {
  if (denominator === 0) return null;
  const r = numerator / denominator;
  const f = 10 ** decimals;
  return Math.round(r * f) / f;
}

/** Whole units of cover: how many `perUnit` fit in `amount`. Null where the rate is zero. */
export function unitsOfCover(amount: number, perUnit: number): number | null {
  assertMinorUnits(amount);
  assertMinorUnits(perUnit);
  return perUnit === 0 ? null : Math.floor(amount / perUnit);
}

/** Divides an amount evenly, rounding up, for rates such as "per hour" from a daily figure. */
export function divideCeil(amount: number, divisor: number): number {
  assertMinorUnits(amount);
  if (!Number.isInteger(divisor) || divisor <= 0) throw new TypeError('divisor must be a positive integer');
  return Math.ceil(amount / divisor);
}

/** Multiplies an amount by an integer count (a rate per hour times hours). */
export function times(amount: number, count: number): number {
  assertMinorUnits(amount);
  if (!Number.isInteger(count) || count < 0) throw new TypeError('count must be a non-negative integer');
  return amount * count;
}

/** Conversion at the provider boundary between minor units and a provider's major-unit figure. */
export function toMajorUnits(minor: number, exponent: number): number {
  assertMinorUnits(minor);
  return exponent === 0 ? minor : Number((minor / 10 ** exponent).toFixed(exponent));
}
export function fromMajorUnits(value: unknown, exponent: number): number {
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(n)) throw new TypeError(`provider amount ${String(value)} is not numeric`);
  return Math.round(n * 10 ** exponent);
}
