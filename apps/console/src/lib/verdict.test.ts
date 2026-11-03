import { describe, expect, it } from 'vitest';
import type { Problem } from './home';
import { changeVsLastWeek, headline, problemText, verdictState } from './verdict';

const base: Problem = { severity: 'warning', kind: 'x', subject_type: 'route', subject_reference: 'r1', subject_name: null, count: 1, since: '2026-11-03T08:00:00Z', title: 'Alert title', link: '/oversight/alerts/1' };
const p = (kind: string, subject_name: string | null, extra: Partial<Problem> = {}): Problem => ({ ...base, kind, subject_name, ...extra });
const warning = p('float_cover', 'Ejara CI XOF disbursement');
const critical = p('breaker_open', 'Orange Money CI', { severity: 'critical' });

describe('verdictState', () => {
  it('is confirmed without problems, checking on warnings, refused on any critical', () => {
    expect(verdictState([])).toBe('confirmed');
    expect(verdictState([warning])).toBe('checking');
    expect(verdictState([warning, critical])).toBe('refused');
  });
});

describe('headline', () => {
  it('counts problems in both languages', () => {
    expect(headline([], 'fr')).toBe('Tout fonctionne normalement');
    expect(headline([], 'en')).toBe('Everything is running normally');
    expect(headline([warning, critical], 'fr')).toBe('2 problèmes demandent ton attention');
    expect(headline([warning], 'en')).toBe('1 problem needs your attention');
    expect(headline([warning, critical], 'en')).toBe('2 problems need your attention');
    expect(headline([warning], 'fr')).toBe('1 problème demande ton attention');
  });
});

describe('problemText', () => {
  const cases: [string, Problem, string, string][] = [
    ['route health', p('health:success_rate:route', 'Orange Money CI · collection'), 'Orange Money CI · collection décroche', 'Orange Money CI · collection is failing'],
    ['provider account health', p('health:success_rate:provider_account', 'Ejara Pay'), 'Ejara Pay : le taux de réussite a chuté', 'Ejara Pay success rate fell'],
    ['project health', p('health:success_rate:project', 'Shop CM'), 'Shop CM : le taux de réussite a chuté', 'Shop CM success rate fell'],
    ['breaker open', p('breaker_open', 'Orange Money CI'), 'Circuit ouvert sur Orange Money CI', 'Circuit breaker open on Orange Money CI'],
    ['provider suspended', p('provider_suspended', 'Ejara Pay', { title: 'Provider account suspended' }), 'Ejara Pay est suspendu', 'Ejara Pay is suspended'],
    ['float cover', p('float_cover', 'Ejara CM XAF disbursement'), 'Ejara CM XAF disbursement : couverture de trésorerie basse', 'Ejara CM XAF disbursement float cover is low'],
    ['float insufficient', p('float_insufficient', 'Ejara CM XAF disbursement'), 'Ejara CM XAF disbursement : trésorerie insuffisante', 'Ejara CM XAF disbursement float is insufficient'],
    ['coverage ratio', p('coverage_ratio', 'XAF'), 'XAF : ratio de couverture sous 1', 'XAF coverage ratio is below 1'],
    ['undetermined', p('undetermined', null, { count: 12 }), '12 transactions sans issue connue', '12 transactions with no known outcome'],
    ['undetermined, one', p('undetermined', null, { count: 1 }), '1 transaction sans issue connue', '1 transaction with no known outcome'],
    ['float drift', p('float_drift', 'CM/XAF/disbursement'), 'CM/XAF/disbursement : la trésorerie s’écarte du solde du fournisseur', 'CM/XAF/disbursement float drifts from the provider balance'],
    ['notification failing', p('notification_failing', null, { count: 3 }), '3 notifications en échec', '3 notifications failing'],
    ['unknown kind', p('something_new', 'Whatever', { title: 'Calls refused on origin' }), 'Calls refused on origin', 'Calls refused on origin'],
  ];
  it.each(cases)('%s', (_n, problem, fr, en) => {
    expect(problemText(problem, 'fr')).toBe(fr);
    expect(problemText(problem, 'en')).toBe(en);
  });
  it('never renders the English title for a kind with its own sentence', () => {
    expect(problemText(p('provider_suspended', 'Ejara Pay', { title: 'Provider account suspended' }), 'fr')).not.toContain('suspended');
  });
});

describe('changeVsLastWeek', () => {
  it('is a ratio, null without a usable baseline', () => {
    expect(changeVsLastWeek(1120, 1000)).toBeCloseTo(0.12);
    expect(changeVsLastWeek(500, null)).toBeNull();
    expect(changeVsLastWeek(500, 0)).toBeNull();
  });
});
