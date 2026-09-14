import type { Lang } from './i18n';

const EXPONENTS: Record<string, number> = { XAF: 0, XOF: 0, GNF: 0, CDF: 2, USD: 2 };

/** Amounts carry their currency and the decimal places that currency uses; the decimal mark and grouping follow the language. */
export function money(minor: number | null | undefined, currency: string, lang: Lang = 'en'): string {
  if (minor == null) return '—';
  const exp = EXPONENTS[currency] ?? 2;
  const major = minor / 10 ** exp;
  return `${new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { minimumFractionDigits: exp, maximumFractionDigits: exp }).format(major)} ${currency}`;
}

export function when(value: string | Date | null | undefined, lang: Lang = 'en', timezone?: string): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(d);
}

export function utc(value: string | Date | null | undefined): string {
  if (!value) return '';
  return (typeof value === 'string' ? new Date(value) : value).toISOString();
}

export function pct(rate: number | null | undefined): string {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)} %`;
}

export function age(value: string | Date): string {
  const ms = Date.now() - (typeof value === 'string' ? new Date(value) : value).getTime();
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return `${Math.floor(ms / 60_000)} min`;
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}
