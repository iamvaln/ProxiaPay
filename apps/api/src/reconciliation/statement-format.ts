import type { Direction } from '../money/money';

export interface ParsedRow {
  rowNumber: number;
  providerReference: string;
  externalReference: string | null;
  direction: Direction | null;
  amount: number | null;
  fee: number | null;
  currency: string | null;
  status: string | null;
  occurredAt: Date | null;
  raw: Record<string, string>;
}

export interface ParseOutcome { rows: ParsedRow[]; rejected: { rowNumber: number; reason: string }[] }

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.length)) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.length)) rows.push(row);
  return rows;
}

/**
 * Statement formats declared by adapters (spec 9.3, 11). `ejara_csv_v1` is the export of the
 * provider's console as understood at integration; header names are matched case-insensitively.
 */
const FORMATS: Record<string, (rows: string[][], exponentOf: (currency: string) => number | undefined) => ParseOutcome> = {
  ejara_csv_v1(rows, exponentOf) {
    const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
    const col = (names: string[]) => names.map((n) => header.indexOf(n.toLowerCase())).find((i) => i >= 0) ?? -1;
    const ref = col(['paymentReference', 'reference', 'payment_reference']);
    const ext = col(['externalReference', 'external_reference']);
    const type = col(['transactionType', 'type', 'transaction_type']);
    const amount = col(['amount', 'rawAmount']);
    const fees = col(['fees', 'fee']);
    const currency = col(['currencyCode', 'currency']);
    const status = col(['status']);
    const created = col(['createdAt', 'date', 'created_at', 'timestamp']);
    const out: ParseOutcome = { rows: [], rejected: [] };
    if (ref < 0) { out.rejected.push({ rowNumber: 1, reason: 'header lacks a paymentReference column' }); return out; }
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]!;
      const rowNumber = i + 1;
      const get = (idx: number) => (idx >= 0 ? (r[idx] ?? '').trim() : '');
      const providerReference = get(ref);
      if (!providerReference) { out.rejected.push({ rowNumber, reason: 'missing paymentReference' }); continue; }
      const cur = get(currency).toUpperCase() || null;
      const exponent = cur ? exponentOf(cur) : undefined;
      const toMinor = (s: string): number | null => {
        if (!s) return null;
        const n = Number(s.replace(/[\s,]/g, ''));
        if (!Number.isFinite(n)) return NaN;
        return Math.round(n * 10 ** (exponent ?? 0));
      };
      const amt = toMinor(get(amount));
      const fee = toMinor(get(fees));
      if (Number.isNaN(amt) || Number.isNaN(fee)) { out.rejected.push({ rowNumber, reason: 'amount or fee is not numeric' }); continue; }
      const t = get(type).toLowerCase();
      const direction: Direction | null = t === 'payin' || t === 'collection' ? 'collection' : t === 'payout' || t === 'disbursement' ? 'disbursement' : null;
      const when = get(created);
      const occurredAt = when ? new Date(when) : null;
      if (occurredAt && Number.isNaN(occurredAt.getTime())) { out.rejected.push({ rowNumber, reason: `unreadable date "${when}"` }); continue; }
      const raw: Record<string, string> = {};
      header.forEach((h, idx) => { raw[h] = r[idx] ?? ''; });
      out.rows.push({ rowNumber, providerReference, externalReference: get(ext) || null, direction, amount: amt, fee, currency: cur, status: get(status).toLowerCase() || null, occurredAt, raw });
    }
    return out;
  },
};

export function parseStatement(format: string, text: string, exponentOf: (currency: string) => number | undefined): ParseOutcome {
  const parser = FORMATS[format];
  if (!parser) throw new Error(`unknown statement format ${format}`);
  return parser(parseCsv(text), exponentOf);
}

export function normaliseStatementStatus(status: string | null): 'succeeded' | 'failed' | 'processing' | 'unknown' {
  switch ((status ?? '').toLowerCase()) {
    case 'confirmed': case 'success': case 'successful': case 'succeeded': case 'completed': return 'succeeded';
    case 'rejected': case 'failed': case 'cancelled': case 'canceled': return 'failed';
    case 'pending': case 'processing': return 'processing';
    default: return 'unknown';
  }
}
