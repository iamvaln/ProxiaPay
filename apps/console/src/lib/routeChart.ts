import type { RouteSeries } from './home';

type Direction = 'collection' | 'disbursement';

/** An hour with fewer terminal transactions than this draws no point: its rate says nothing. */
export const MIN_POINT = 5;

/** 24 hourly rates, oldest first; null where the hour is too thin to draw. */
export function points(s: RouteSeries): (number | null)[] {
  return s.hours.map((h) => (h.terminal < MIN_POINT ? null : h.succeeded / h.terminal));
}

const SHORT_NAMES: Record<string, string> = {
  MOMO: 'MTN MoMo', OM: 'Orange Money', MOOV: 'Moov Money', AIRTEL: 'Airtel Money', WAVE: 'Wave', MPESA: 'M-Pesa', FREE: 'Free Money',
};

/** The route is operator × country: the label always carries both, so two MTN routes never read as one. */
function labelOf(s: RouteSeries): string {
  return `${SHORT_NAMES[s.payment_method_code] ?? s.payment_method_name} ${s.country_code}`;
}

export function view(series: RouteSeries[], direction: Direction, country: string | 'all') {
  const pool = series.filter((s) => s.direction === direction);
  const chosen = country === 'all' ? pool.filter((s) => s.departing) : pool.filter((s) => s.country_code === country);
  const seen = new Set<string>();
  const lines = chosen.map((s) => {
    const dashed = seen.has(s.payment_method_code);
    seen.add(s.payment_method_code);
    return { series: s, dashed, label: labelOf(s) };
  });
  if (country !== 'all') return { lines, band: null };
  const calm = pool.filter((s) => !s.departing).map(points);
  if (calm.length === 0) return { lines, band: null };
  const lo: (number | null)[] = [];
  const hi: (number | null)[] = [];
  for (let i = 0; i < 24; i++) {
    const vs = calm.map((p) => p[i]).filter((v): v is number => v != null);
    lo.push(vs.length ? Math.min(...vs) : null);
    hi.push(vs.length ? Math.max(...vs) : null);
  }
  return { lines, band: { lo, hi, count: calm.length } };
}

export function countryChips(series: RouteSeries[], direction: Direction): { country: string; departing: number }[] {
  const byCountry = new Map<string, number>();
  for (const s of series) {
    if (s.direction !== direction) continue;
    byCountry.set(s.country_code, (byCountry.get(s.country_code) ?? 0) + (s.departing ? 1 : 0));
  }
  return [...byCountry].map(([country, departing]) => ({ country, departing })).sort((a, b) => a.country.localeCompare(b.country));
}

/** Pushes end labels at least `gap` apart, top to bottom, without changing their order. Result is in the input's order. */
export function spreadLabels(ys: number[], gap: number): number[] {
  const order = ys.map((_, i) => i).sort((a, b) => ys[a]! - ys[b]!);
  const out = [...ys];
  for (let k = 1; k < order.length; k++) {
    const prev = out[order[k - 1]!]!;
    if (out[order[k]!]! - prev < gap) out[order[k]!] = prev + gap;
  }
  return out;
}

const OPERATOR_TOKENS: Record<string, string> = {
  MOMO: 'momo', OM: 'om', MOOV: 'moov', AIRTEL: 'airtel', WAVE: 'wave', MPESA: 'mpesa', FREE: 'free',
};

export function operatorColour(paymentMethodCode: string): string {
  const token = OPERATOR_TOKENS[paymentMethodCode];
  return token ? `var(--operator-${token})` : 'var(--ink)';
}
