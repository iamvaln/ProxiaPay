import { describe, expect, it } from 'vitest';
import { money, moneyParts } from './format';

describe('an amount split into figure and currency', () => {
  it('joins back into exactly what money() prints, in French and English, negative, and with decimals', () => {
    for (const [minor, cur, lang] of [[120487000, 'XAF', 'fr'], [-50400, 'XAF', 'en'], [12345, 'USD', 'fr'], [0, 'CDF', 'en']] as const) {
      const p = moneyParts(minor, cur, lang);
      expect(`${p.figure} ${p.currency}`).toBe(money(minor, cur, lang));
    }
  });

  it('keeps the currency out of the figure', () => {
    expect(moneyParts(125000, 'XAF', 'en')).toEqual({ figure: '125,000', currency: 'XAF' });
  });

  it('shows a dash and no currency when there is no amount', () => {
    expect(moneyParts(null, 'XAF')).toEqual({ figure: '—', currency: '' });
    expect(money(null, 'XAF')).toBe('—');
  });
});
