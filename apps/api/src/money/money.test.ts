import { describe, expect, it } from 'vitest';
import { bpsToPercent, compose, computeFee, formatAmount, margin, percentToBps } from './money';

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
