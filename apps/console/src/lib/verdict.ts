import type { Problem } from './home';
import { t, type Lang } from './i18n';

export type VerdictState = 'confirmed' | 'checking' | 'refused';

export function verdictState(problems: Problem[]): VerdictState {
  if (problems.length === 0) return 'confirmed';
  return problems.some((p) => p.severity === 'critical') ? 'refused' : 'checking';
}

export function headline(problems: Problem[], lang: Lang): string {
  if (problems.length === 0) return t(lang, 'home.verdict.ok');
  return t(lang, problems.length === 1 ? 'home.verdict.headline_one' : 'home.verdict.headline_other', { count: problems.length });
}

/** Kinds whose sentence depends on how many alerts were grouped into the problem. */
const COUNTED = new Set(['undetermined']);
/** Kinds with their own sentence; any other kind falls back to the alert's title, untranslated. */
const SENTENCED = new Set([
  'health:success_rate:route', 'health:success_rate:provider_account', 'health:success_rate:project', 'breaker_open', 'provider_suspended',
  'float_cover', 'float_insufficient', 'coverage_ratio', 'float_drift', 'notification_failing', ...COUNTED,
]);

export function problemText(p: Problem, lang: Lang): string {
  if (!SENTENCED.has(p.kind)) return p.title;
  const name = p.subject_name ?? p.subject_reference ?? '';
  const key = COUNTED.has(p.kind) ? `home.verdict.${p.kind}_${p.count === 1 ? 'one' : 'other'}` : `home.verdict.${p.kind}`;
  return t(lang, key, { name, count: p.count });
}

/** Today against the same weekday last week, as a ratio (0.12 is +12 %); null when there is nothing to compare with. */
export function changeVsLastWeek(today: number, lastWeek: number | null): number | null {
  return lastWeek ? today / lastWeek - 1 : null;
}
