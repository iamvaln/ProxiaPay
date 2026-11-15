import type { Lang } from './i18n';

const EXPONENTS: Record<string, number> = { XAF: 0, XOF: 0, GNF: 0, CDF: 2, USD: 2 };

/** A figure in minor units written with the given decimals; grouping and decimal mark follow the language. */
export function figureOf(minor: number, exponent: number, lang: Lang = 'en'): string {
  return new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { minimumFractionDigits: exponent, maximumFractionDigits: exponent }).format(minor / 10 ** exponent);
}

/**
 * An amount typed in the currency (`12.50` with 2 decimals, `5000` with none) in minor units, or null when it is not a plain
 * figure with at most `exp` decimals. The exponent comes from the platform's currency table, never guessed here; the digits
 * are read as such, so no floating point touches the amount.
 */
export function toMinor(text: string, exp: number): number | null {
  const m = /^(\d+)(?:[.,](\d*))?$/.exec(text.trim());
  if (!m || (m[2] ?? '').length > exp) return null;
  const minor = Number(m[1]) * 10 ** exp + Number((m[2] ?? '').padEnd(exp, '0') || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Amounts carry their currency and the decimal places that currency uses; the decimal mark and grouping follow the language. */
export function money(minor: number | null | undefined, currency: string, lang: Lang = 'en'): string {
  const p = moneyParts(minor, currency, lang);
  return p.currency ? `${p.figure} ${p.currency}` : p.figure;
}

/** The same amount as money(), with the figure and the currency apart, so the currency can be set smaller beside it. */
export function moneyParts(minor: number | null | undefined, currency: string, lang: Lang = 'en'): { figure: string; currency: string } {
  if (minor == null) return { figure: '—', currency: '' };
  return { figure: figureOf(minor, EXPONENTS[currency] ?? 2, lang), currency };
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
