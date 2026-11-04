import { describe, expect, it } from 'vitest';
import type { RouteSeries } from './home';
import { countryChips, operatorColour, points, spreadLabels, view } from './routeChart';

function route(id: string, code: string, country: string, o: Partial<RouteSeries> & { rate?: number; terminal?: number } = {}): RouteSeries {
  const { rate, terminal: term, ...rest } = o;
  const terminal = term ?? 20;
  const succeeded = Math.round(terminal * (rate ?? 0.97));
  return {
    route_id: id, payment_method_code: code, payment_method_name: 'Long name', country_code: country, currency: 'XAF', direction: 'collection',
    baseline: 0.97, current: rate ?? 0.97, sample: 100, alerted: false, departing: false,
    hours: Array.from({ length: 24 }, (_, i) => ({ hour: new Date(Date.UTC(2026, 10, 3, i)).toISOString(), terminal, succeeded })),
    ...rest,
  };
}

describe('points', () => {
  it('is null for an hour under MIN_POINT terminal and a fraction otherwise', () => {
    const s = route('a', 'MOMO', 'CM');
    s.hours[0] = { hour: s.hours[0]!.hour, terminal: 4, succeeded: 4 };
    s.hours[1] = { hour: s.hours[1]!.hour, terminal: 20, succeeded: 19 };
    const p = points(s);
    expect(p).toHaveLength(24);
    expect(p[0]).toBeNull();
    expect(p[1]).toBe(0.95);
  });
});

describe('view', () => {
  it('all: departing routes are lines, the rest of the direction is the band', () => {
    const calmA = route('a', 'OM', 'CM', { rate: 0.9 });
    const calmB = route('b', 'WAVE', 'SN', { rate: 0.95 });
    const sick = route('c', 'MOMO', 'CM', { departing: true });
    const other = route('d', 'MOMO', 'CM', { direction: 'disbursement', departing: true });
    calmA.hours[3] = { hour: calmA.hours[3]!.hour, terminal: 2, succeeded: 2 };
    calmB.hours[3] = { hour: calmB.hours[3]!.hour, terminal: 2, succeeded: 2 };
    const v = view([calmA, calmB, sick, other], 'collection', 'all');
    expect(v.lines.map((l) => l.series.route_id)).toEqual(['c']);
    expect(v.band?.count).toBe(2);
    expect(v.band?.lo[0]).toBe(0.9);
    expect(v.band?.hi[0]).toBe(0.95);
    expect(v.band?.lo[3]).toBeNull();
    expect(v.band?.hi[3]).toBeNull();
  });

  it('country: every route of that country is a line and there is no band', () => {
    const calmA = route('a', 'OM', 'CM');
    const calmB = route('b', 'WAVE', 'SN');
    const ci = route('e', 'OM', 'CI');
    const ci2 = route('f', 'WAVE', 'CI', { direction: 'disbursement' });
    const v = view([calmA, calmB, ci, ci2], 'collection', 'CI');
    expect(v.lines.map((l) => l.series.route_id)).toEqual(['e']);
    expect(v.band).toBeNull();
  });

  it('never merges one operator across countries: two lines, the second dashed', () => {
    const cm = route('x', 'MOMO', 'CM', { departing: true });
    const ci = route('y', 'MOMO', 'CI', { departing: true });
    const v = view([cm, ci], 'collection', 'all');
    expect(v.lines.map((l) => [l.label, l.dashed])).toEqual([['MTN MoMo CM', false], ['MTN MoMo CI', true]]);
  });
});

describe('countryChips', () => {
  it('counts departing routes per country, sorted by code', () => {
    const chips = countryChips([route('1', 'MOMO', 'CM', { departing: true }), route('2', 'OM', 'CI'), route('3', 'OM', 'CM')], 'collection');
    expect(chips).toEqual([{ country: 'CI', departing: 0 }, { country: 'CM', departing: 1 }]);
  });
});

describe('spreadLabels', () => {
  it('pushes labels apart and keeps order', () => {
    expect(spreadLabels([100, 104, 150], 14)).toEqual([100, 114, 150]);
  });
});

describe('operatorColour', () => {
  it('maps a code to its token, unknown to ink', () => {
    expect(operatorColour('MOMO')).toBe('var(--operator-momo)');
    expect(operatorColour('NOPE')).toBe('var(--ink)');
  });
});
