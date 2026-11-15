import { describe, expect, it } from 'vitest';
import type { Bearer, Direction, FeeTerms } from '../money/money';
import { counterpartyMonotone, providerLimitBound, RouteResolver, type Resolution } from './route-resolver';

type Limits = { minimum_amount: number | null; maximum_amount: number | null };

/** The unit scan providerLimitRefusal ran before bisection, kept verbatim as the oracle. */
function oracle(counterparty: (r: number) => number, all: Limits[], requested: number, limits: { minimum: number; maximum: number }) {
  const admits = (r: number) => all.some((b) => (b.minimum_amount == null || counterparty(r) >= b.minimum_amount) && (b.maximum_amount == null || counterparty(r) <= b.maximum_amount));
  if (admits(requested)) return null;
  const { minimum, maximum } = limits;
  for (let r = requested + 1; r <= maximum; r++) {
    if (admits(r)) return { minimum: r };
  }
  for (let r = requested - 1; r >= minimum; r--) {
    if (admits(r)) return { maximum: r };
  }
  return null;
}

const resolution = (direction: Direction, processing: FeeTerms, platform: FeeTerms, processingBearer: Bearer, platformBearer: Bearer) =>
  ({ route: { direction }, terms: { processing, platform, processingBearer, platformBearer, sources: {} } }) as unknown as Resolution;
// computeFigures reads only the resolution it is given.
const counterpartyOf = (res: Resolution) => (r: number) => RouteResolver.counterpartyAmount(res.route.direction, RouteResolver.prototype.computeFigures.call(null, res, r, undefined));

const TERMS: [FeeTerms, FeeTerms, Bearer, Bearer][] = [
  [{ bps: 250, fixed: 0 }, { bps: 0, fixed: 0 }, 'counterparty', 'counterparty'],
  [{ bps: 250, fixed: 25 }, { bps: 100, fixed: 0 }, 'counterparty', 'project'],
  [{ bps: 350, fixed: 0, floor: 50, ceiling: 400 }, { bps: 150, fixed: 10 }, 'project', 'counterparty'],
  [{ bps: 9999, fixed: 3 }, { bps: 0, fixed: 7 }, 'counterparty', 'counterparty'],
  [{ bps: 0, fixed: 0 }, { bps: 0, fixed: 0 }, 'project', 'project'],
  // Two fees both on the counterparty: a payout's receipt can dip, so the scan stays.
  [{ bps: 2500, fixed: 0 }, { bps: 1500, fixed: 5 }, 'counterparty', 'counterparty'],
];
const BINDINGS: Limits[][] = [
  [{ minimum_amount: 500, maximum_amount: null }],
  [{ minimum_amount: null, maximum_amount: 1200 }],
  [{ minimum_amount: 700, maximum_amount: 900 }, { minimum_amount: 2500, maximum_amount: 3000 }],
  [{ minimum_amount: 1500, maximum_amount: 1499 }],
  [{ minimum_amount: 6000, maximum_amount: null }, { minimum_amount: null, maximum_amount: 50 }],
  [{ minimum_amount: 1000, maximum_amount: 1000 }, { minimum_amount: 1001, maximum_amount: 1001 }],
];

describe('the provider-limit bound', () => {
  it('gives the unit scan\'s answer for every fee shape, binding set and amount', () => {
    const limits = { minimum: 100, maximum: 4000 };
    let compared = 0;
    for (const direction of ['collection', 'disbursement'] as const) {
      for (const [processing, platform, pb, fb] of TERMS) {
        const res = resolution(direction, processing, platform, pb, fb);
        const counterparty = counterpartyOf(res);
        const monotone = counterpartyMonotone(res);
        // The claim bisection rests on: wherever it is made, the counterparty amount never falls.
        if (monotone) for (let r = limits.minimum; r < limits.maximum; r++) expect(counterparty(r + 1)).toBeGreaterThanOrEqual(counterparty(r));
        for (const bindings of BINDINGS) {
          for (const requested of [100, 101, 450, 480, 499, 500, 650, 800, 1000, 1001, 1100, 1450, 2000, 2600, 3999, 4000]) {
            expect(providerLimitBound(counterparty, monotone, bindings, requested, limits)).toEqual(oracle(counterparty, bindings, requested, limits));
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(2 * TERMS.length * BINDINGS.length * 16);
  });

  it('a payout with two fees on the recipient is not treated as monotone', () => {
    expect(counterpartyMonotone(resolution('disbursement', { bps: 2500, fixed: 0 }, { bps: 1500, fixed: 5 }, 'counterparty', 'counterparty'))).toBe(false);
    expect(counterpartyMonotone(resolution('collection', { bps: 2500, fixed: 0 }, { bps: 1500, fixed: 5 }, 'counterparty', 'counterparty'))).toBe(true);
    expect(counterpartyMonotone(resolution('disbursement', { bps: 2500, fixed: 0 }, { bps: 0, fixed: 5 }, 'counterparty', 'counterparty'))).toBe(true);
  });

  it('settles a refusal on a 1 000 000 maximum in a few dozen evaluations', () => {
    const res = resolution('collection', { bps: 250, fixed: 0 }, { bps: 0, fixed: 0 }, 'counterparty', 'project');
    const base = counterpartyOf(res);
    let calls = 0;
    const counterparty = (r: number) => { calls++; return base(r); };
    const limits = { minimum: 100, maximum: 1_000_000 };
    const started = performance.now();
    // Only the very top admitted: the old scan walked about a million units to find it.
    expect(providerLimitBound(counterparty, true, [{ minimum_amount: base(999_990), maximum_amount: null }], 100, limits)).toEqual({ minimum: 999_990 });
    // Nothing admitted at all: the old scan walked the whole range both ways.
    expect(providerLimitBound(counterparty, true, [{ minimum_amount: 5_000_000, maximum_amount: null }], 500_000, limits)).toBeNull();
    expect(calls).toBeLessThan(200);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
