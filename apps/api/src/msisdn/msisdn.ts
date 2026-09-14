/**
 * Payer identifier normalisation (spec 5.2). A number is accepted in national form or in
 * international form with the country's own prefix, and stored as E.164. A prefix belonging
 * to another country is refused rather than rewritten. National significant number lengths
 * are the ones the operators in each country issue; a number outside them is malformed.
 */

export interface CountryDialling {
  code: string;
  diallingPrefix: string; // '+237'
}

/** National significant number lengths by country, for the countries in the catalogue. */
const NSN_LENGTHS: Record<string, number[]> = {
  CM: [9], GA: [8, 9], CG: [9], TD: [8], CF: [8], GQ: [9],
  SN: [9], CI: [10], BF: [8], ML: [8], TG: [8], BJ: [8, 10], NE: [8],
  GN: [9], CD: [9],
};

export type MsisdnResult =
  | { ok: true; msisdn: string; nsn: string }
  | { ok: false; reason: 'malformed' | 'foreign_prefix' };

export function normaliseMsisdn(raw: string, country: CountryDialling): MsisdnResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'malformed' };
  let s = raw.replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!/^\+?\d{6,15}$/.test(s)) return { ok: false, reason: 'malformed' };
  const prefixDigits = country.diallingPrefix.slice(1);
  let nsn: string;
  if (s.startsWith('+')) {
    if (!s.startsWith(country.diallingPrefix)) return { ok: false, reason: 'foreign_prefix' };
    nsn = s.slice(country.diallingPrefix.length);
  } else if (s.startsWith(prefixDigits) && isPlausibleWithPrefix(s, prefixDigits, country.code)) {
    nsn = s.slice(prefixDigits.length);
  } else {
    nsn = s.replace(/^0/, '');
  }
  const lengths = NSN_LENGTHS[country.code] ?? [8, 9, 10];
  if (!lengths.includes(nsn.length) || nsn.startsWith('0')) return { ok: false, reason: 'malformed' };
  return { ok: true, msisdn: `${country.diallingPrefix}${nsn}`, nsn };
}

/** "237677123456" without a plus is treated as prefixed only where the remainder is a valid national number. */
function isPlausibleWithPrefix(s: string, prefixDigits: string, code: string): boolean {
  const rest = s.slice(prefixDigits.length);
  const lengths = NSN_LENGTHS[code] ?? [8, 9, 10];
  return lengths.includes(rest.length);
}

/** Masks to the final digits for list views and logs: +237•••••3456. */
export function maskMsisdn(msisdn: string, visible = 4): string {
  const digits = msisdn.replace(/\D/g, '');
  const prefixLen = msisdn.startsWith('+') ? Math.min(3, digits.length - visible) : 0;
  const head = msisdn.startsWith('+') ? `+${digits.slice(0, prefixLen)}` : '';
  const tail = digits.slice(-visible);
  const hidden = '•'.repeat(Math.max(0, digits.length - prefixLen - visible));
  return `${head}${hidden}${tail}`;
}
