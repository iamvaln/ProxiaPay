import { describe, expect, it } from 'vitest';
import { alertKind, groupProblems, isDeparting, type AlertRow } from './home.logic';

let seq = 0;
function alert(over: Partial<AlertRow>): AlertRow {
  seq += 1;
  return {
    id: `a${seq}`,
    severity: 'warning',
    category: 'service_health',
    subject_type: 'transaction',
    subject_reference: `t${seq}`,
    fingerprint: `undetermined:t${seq}`,
    title: 'An alert',
    action_reference: '/somewhere',
    raised_at: new Date(Date.UTC(2026, 10, 3, 8, seq)),
    ...over,
  };
}

describe('the home verdict', () => {
  it('names the kind by the fingerprint prefix, keeping the dimension of a health alert', () => {
    expect(alertKind('undetermined:1b2c')).toBe('undetermined');
    expect(alertKind('health:success_rate:route:9f0e')).toBe('health:success_rate:route');
    expect(alertKind('coverage_ratio:XOF')).toBe('coverage_ratio');
  });

  it('groups per-transaction alerts into one problem, keeps one problem per route', () => {
    const alerts: AlertRow[] = [
      ...Array.from({ length: 12 }, (_, i) =>
        alert({ severity: i < 2 ? 'critical' : 'warning', subject_type: 'transaction', subject_reference: `t${i}`, fingerprint: `undetermined:t${i}` }),
      ),
      alert({ subject_type: 'route', subject_reference: 'r1', fingerprint: 'health:success_rate:route:r1', title: 'Orange Money CI is failing', action_reference: '/routes/r1' }),
      alert({ subject_type: 'route', subject_reference: 'r2', fingerprint: 'health:success_rate:route:r2', title: 'MTN MoMo CM is failing', action_reference: '/routes/r2' }),
      alert({ severity: 'informational', category: 'security', subject_type: 'approval', subject_reference: 'x1', fingerprint: 'approval:refund:x1' }),
    ];
    const p = groupProblems(alerts, new Map([['route:r1', 'Orange Money CI · collection'], ['route:r2', 'MTN MoMo CM · collection']]));
    expect(p.map((x) => [x.kind, x.count, x.severity])).toEqual([
      ['undetermined', 12, 'critical'],
      ['health:success_rate:route', 1, 'warning'],
      ['health:success_rate:route', 1, 'warning'],
    ]);
    expect(p[1]!.subject_name).toBe('Orange Money CI · collection'); // older alert first within a severity
    expect(p[0]!.subject_reference).toBeNull();
    expect(p[0]!.subject_name).toBeNull();
    expect(p[0]!.link).toBe('/transactions?state=undetermined');
    expect(p[1]!.link).toBe('/routes/r1');
    expect(p.some((x) => x.kind === 'approval')).toBe(false); // informational never feeds the verdict
  });

  it('orders critical before warning, then oldest first, and dates a group from its oldest alert', () => {
    const old = new Date(Date.UTC(2026, 10, 1, 6, 0));
    const mid = new Date(Date.UTC(2026, 10, 2, 6, 0));
    const recent = new Date(Date.UTC(2026, 10, 3, 6, 0));
    const p = groupProblems(
      [
        alert({ severity: 'warning', subject_type: 'route', subject_reference: 'r1', fingerprint: 'health:success_rate:route:r1', raised_at: old }),
        alert({ severity: 'critical', subject_type: 'provider_account', subject_reference: 'p1', fingerprint: 'breaker_open:p1', raised_at: recent }),
        alert({ severity: 'critical', subject_type: 'transaction', subject_reference: 'ta', fingerprint: 'undetermined:ta', raised_at: recent }),
        alert({ severity: 'critical', subject_type: 'transaction', subject_reference: 'tb', fingerprint: 'undetermined:tb', raised_at: mid, title: 'Oldest title' }),
      ],
      new Map(),
    );
    expect(p.map((x) => x.kind)).toEqual(['undetermined', 'breaker_open', 'health:success_rate:route']);
    expect(p[0]!.since).toBe(mid.toISOString());
    expect(p[0]!.title).toBe('Oldest title');
    expect(p[0]!.count).toBe(2);
  });

  it('falls back to the subject reference when no name is known', () => {
    const p = groupProblems([alert({ subject_type: 'route', subject_reference: 'r9', fingerprint: 'health:success_rate:route:r9' })], new Map());
    expect(p[0]!.subject_reference).toBe('r9');
    expect(p[0]!.subject_name).toBe('r9');
  });

  it('marks a route departing on an open alert, whatever its sample', () => {
    expect(isDeparting({ current: 0.5, baseline: 0.97, sample: 12, alerted: true })).toBe(true);
  });

  it('marks a route departing 5 points under its baseline on at least 20', () => {
    expect(isDeparting({ current: 0.91, baseline: 0.97, sample: 20, alerted: false })).toBe(true);
    expect(isDeparting({ current: 0.93, baseline: 0.97, sample: 20, alerted: false })).toBe(false);
    expect(isDeparting({ current: 0.5, baseline: 0.97, sample: 19, alerted: false })).toBe(false);
    expect(isDeparting({ current: 0.5, baseline: null, sample: 50, alerted: false })).toBe(false);
  });
});
