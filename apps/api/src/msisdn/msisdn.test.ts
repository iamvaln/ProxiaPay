import { describe, expect, it } from 'vitest';
import { maskMsisdn, normaliseMsisdn } from './msisdn';

const CM = { code: 'CM', diallingPrefix: '+237' };
const SN = { code: 'SN', diallingPrefix: '+221' };

describe('normaliseMsisdn', () => {
  it('prefixes a national number', () => {
    expect(normaliseMsisdn('677123456', CM)).toEqual({ ok: true, msisdn: '+237677123456', nsn: '677123456' });
  });
  it('passes an international number through unchanged', () => {
    expect(normaliseMsisdn('+237677123456', CM)).toEqual({ ok: true, msisdn: '+237677123456', nsn: '677123456' });
    expect(normaliseMsisdn('00237677123456', CM).ok).toBe(true);
    expect(normaliseMsisdn('237677123456', CM)).toEqual({ ok: true, msisdn: '+237677123456', nsn: '677123456' });
  });
  it('tolerates spacing and punctuation', () => {
    expect(normaliseMsisdn('+237 677 12 34 56', CM).ok).toBe(true);
    expect(normaliseMsisdn('(677) 123-456', CM).ok).toBe(true);
  });
  it('refuses another country prefix', () => {
    expect(normaliseMsisdn('+221771234567', CM)).toEqual({ ok: false, reason: 'foreign_prefix' });
    expect(normaliseMsisdn('+237677123456', SN)).toEqual({ ok: false, reason: 'foreign_prefix' });
  });
  it('refuses malformed numbers', () => {
    expect(normaliseMsisdn('12', CM)).toEqual({ ok: false, reason: 'malformed' });
    expect(normaliseMsisdn('6771234567', CM)).toEqual({ ok: false, reason: 'malformed' });
    expect(normaliseMsisdn('abc', CM)).toEqual({ ok: false, reason: 'malformed' });
    expect(normaliseMsisdn('+2376771234567', CM)).toEqual({ ok: false, reason: 'malformed' });
  });
  it('produces one identifier however supplied', () => {
    const forms = ['677123456', '+237677123456', '237677123456', '0677123456'];
    const out = new Set(forms.map((f) => (normaliseMsisdn(f, CM) as { msisdn: string }).msisdn));
    expect(out.size).toBe(1);
  });
});

describe('maskMsisdn', () => {
  it('keeps the prefix and the final digits', () => {
    expect(maskMsisdn('+237677123456')).toBe('+237•••••3456');
  });
});
