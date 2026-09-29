import { describe, expect, it } from 'vitest';
import { bpsToPercent, compose, computeFee, formatAmount, margin, percentToBps, providerAmountWithin } from './money';

describe('computeFee', () => {
  it('applies basis points with half-up rounding', () => {
    expect(computeFee(1000, { bps: 250, fixed: 0 })).toEqual({ amount: 25, remainder: 0 });
    expect(computeFee(1001, { bps: 250, fixed: 0 }).amount).toBe(25); // 25.025 → 25
    expect(computeFee(1020, { bps: 250, fixed: 0 }).amount).toBe(26); // 25.5 → 26
    expect(computeFee(1019, { bps: 250, fixed: 0 }).amount).toBe(25); // 25.475 → 25
    expect(computeFee(1, { bps: 1, fixed: 0 }).amount).toBe(0);
  });
  it('records the remainder discarded', () => {
    const r = computeFee(1001, { bps: 250, fixed: 0 });
    expect(r.remainder).toBe(250); // 0.025 of a minor unit, as numerator over 10000
    expect(computeFee(1020, { bps: 250, fixed: 0 }).remainder).toBe(-5000); // rounded up by half
  });
  it('adds fixed part and honours floor and ceiling', () => {
    expect(computeFee(1000, { bps: 250, fixed: 10 }).amount).toBe(35);
    expect(computeFee(100, { bps: 250, fixed: 0, floor: 50 }).amount).toBe(50);
    expect(computeFee(1_000_000, { bps: 250, fixed: 0, ceiling: 5000 }).amount).toBe(5000);
  });
  it('refuses non-integer inputs', () => {
    expect(() => computeFee(10.5, { bps: 250, fixed: 0 })).toThrow(TypeError);
    expect(() => computeFee(1000, { bps: 2.5, fixed: 0 })).toThrow(TypeError);
    expect(() => computeFee(1000, { bps: -1, fixed: 0 })).toThrow(TypeError);
  });
});

describe('compose (spec 6.1 worked cases)', () => {
  it('collection of 1000 with the payer bearing both fees charges 1030 and credits 1000', () => {
    const c = compose({ direction: 'collection', requested: 1000, processingFee: 25, platformFee: 5, processingBearer: 'counterparty', platformBearer: 'counterparty' });
    expect(c).toEqual({ counterpartyAmount: 1030, projectAmount: 1000, counterpartyFees: 30, projectFees: 0 });
  });
  it('disbursement of 1000 with the recipient bearing both fees debits 1000 and delivers 970', () => {
    const c = compose({ direction: 'disbursement', requested: 1000, processingFee: 25, platformFee: 5, processingBearer: 'counterparty', platformBearer: 'counterparty' });
    expect(c).toEqual({ counterpartyAmount: 970, projectAmount: 1000, counterpartyFees: 30, projectFees: 0 });
  });
  it('mixed bearers move each fee to its own side', () => {
    const c = compose({ direction: 'collection', requested: 1000, processingFee: 25, platformFee: 5, processingBearer: 'project', platformBearer: 'counterparty' });
    expect(c).toEqual({ counterpartyAmount: 1005, projectAmount: 975, counterpartyFees: 5, projectFees: 25 });
    const d = compose({ direction: 'disbursement', requested: 1000, processingFee: 25, platformFee: 5, processingBearer: 'project', platformBearer: 'project' });
    expect(d).toEqual({ counterpartyAmount: 1000, projectAmount: 1030, counterpartyFees: 0, projectFees: 30 });
  });
});

describe('helpers', () => {
  it('margin may be negative and is null before the provider reports', () => {
    expect(margin(25, 20)).toBe(5);
    expect(margin(25, 30)).toBe(-5);
    expect(margin(25, null)).toBeNull();
  });
  it('formats by exponent', () => {
    expect(formatAmount(1000, 0)).toBe('1000');
    expect(formatAmount(1050, 2)).toBe('10.50');
    expect(formatAmount(5, 2)).toBe('0.05');
    expect(formatAmount(-1050, 2)).toBe('-10.50');
  });
  it('converts percentage strings to basis points and back', () => {
    expect(percentToBps('2.5')).toBe(250);
    expect(percentToBps('0.5')).toBe(50);
    expect(percentToBps('2')).toBe(200);
    expect(percentToBps('1.75')).toBe(175);
    expect(() => percentToBps('1.234')).toThrow();
    expect(bpsToPercent(250)).toBe('2.5');
    expect(bpsToPercent(175)).toBe('1.75');
    expect(bpsToPercent(0)).toBe('0');
  });
});

describe('providerAmountWithin (a provider that adds its fee on top)', () => {
  // Ejara: 2 percent on top, rounded up for collections. Observed on the prodbox on 2026-09-29:
  // 100 sent was debited 102, and a 101 would be debited 104, so a quote of 103 cannot be hit.
  const EJARA = { bps: 200, fixed: 0 };

  it('never debits more than the quote when the quote itself is unreachable', () => {
    expect(providerAmountWithin(103, EJARA, 'ceil')).toEqual({ amount: 100, debit: 102, fee: 2 });
  });

  it('lands exactly on a reachable quote', () => {
    expect(providerAmountWithin(10250, EJARA, 'ceil')).toEqual({ amount: 10049, debit: 10250, fee: 201 });
  });

  it('reproduces the simulator\'s figures under half-up rounding', () => {
    // A 1000 collection quoted at 1025: send 1005, the simulator adds 20, the float receives 1005.
    expect(providerAmountWithin(1025, EJARA, 'half_up')).toEqual({ amount: 1005, debit: 1025, fee: 20 });
  });

  it('returns the largest amount within the quote, for every quote in a range and both roundings', () => {
    // The provider's fee on an amount, written out independently of the implementation.
    const feeOf = (amount: number, rounding: 'ceil' | 'half_up') =>
      rounding === 'ceil' ? Math.ceil((amount * 200) / 10000) : computeFee(amount, EJARA).amount;
    for (const rounding of ['ceil', 'half_up'] as const) {
      for (let target = 100; target <= 3000; target++) {
        const r = providerAmountWithin(target, EJARA, rounding);
        expect(r.fee, `${rounding} ${target}`).toBe(feeOf(r.amount, rounding));
        expect(r.debit).toBe(r.amount + r.fee);
        expect(r.debit, `${rounding} ${target} within the quote`).toBeLessThanOrEqual(target);
        // Maximal: one more unit would take the payer past the quote.
        expect(r.amount + 1 + feeOf(r.amount + 1, rounding), `${rounding} ${target} maximal`).toBeGreaterThan(target);
      }
    }
  });

  it('includes a fixed component', () => {
    expect(providerAmountWithin(1000, { bps: 0, fixed: 50 }, 'ceil')).toEqual({ amount: 950, debit: 1000, fee: 50 });
  });

  it('refuses a quote the fee alone would consume', () => {
    expect(() => providerAmountWithin(50, { bps: 0, fixed: 50 }, 'ceil')).toThrow(RangeError);
  });
});
