import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import type { Filter, TableState } from '../components/table/DataTable';

/** A server page, as every console list endpoint returns it. */
export type Paged<T> = { data: T[]; total: number; page: number; page_size: number; scoped?: boolean };

const DAY = 86_400_000;
const PERIOD_DAYS: Record<string, number> = { d1: 1, d7: 7, d30: 30 };

/** The period chip every dated list offers: a preset window ending now, sent to the server as the lower bound. */
export function periodFilter<T>(t: (k: string) => string): Filter<T> {
  return { key: 'period', label: t('l.period'), options: [{ value: 'd1', label: t('l.period_d1') }, { value: 'd7', label: t('l.period_d7') }, { value: 'd30', label: t('l.period_d30') }] };
}

/**
 * The request path for a list: the table's state as the server contract names it. `period` names the lower-bound
 * param a period chip sets (`after` or `created_after`); `extra` carries the page's own fixed parameters.
 */
export function listPath(base: string, s: TableState, opts: { period?: string; extra?: Record<string, string | undefined> } = {}): string {
  const p = new URLSearchParams({ page: String(s.page), page_size: String(s.pageSize), order: s.order });
  if (s.sort) p.set('sort', s.sort);
  if (s.q) p.set('q', s.q);
  for (const [k, v] of Object.entries(s.filters)) {
    if (!v) continue;
    if (k === 'period') { if (opts.period && PERIOD_DAYS[v]) p.set(opts.period, new Date(Date.now() - PERIOD_DAYS[v]! * DAY).toISOString()); } else p.set(k, v);
  }
  for (const [k, v] of Object.entries(opts.extra ?? {})) if (v) p.set(k, v);
  return `${base}?${p}`;
}

export const fetchPage = <T,>(base: string, opts?: Parameters<typeof listPath>[2]) => (s: TableState) => get<Paged<T>>(listPath(base, s, opts));

/** Bumping the revision remounts the table, which fetches its page again: how a list refreshes after a row action. */
export function useReload(): [number, () => void] {
  const [rev, setRev] = useState(0);
  return [rev, () => setRev((n) => n + 1)];
}

export type Reference = { projects: { id: string; name: string }[]; providers: { id: string; name: string }[]; countries: { code: string; name: string }[]; methods: string[]; currencies: string[] };

/**
 * The names the filter chips offer. What an administrator is not allowed to read is simply not offered, so a
 * failed request leaves its list empty rather than failing the page. `ready` is false until every one answered.
 */
export function useReference(): Reference & { ready: boolean } {
  const [ref, setRef] = useState<Reference & { ready: boolean }>({ projects: [], providers: [], countries: [], methods: [], currencies: [], ready: false });
  useEffect(() => {
    let live = true;
    const quiet = <T,>(p: Promise<T>) => p.catch(() => null);
    void Promise.all([quiet(get<any>('/projects')), quiet(get<any>('/configuration/providers')), quiet(get<any>('/configuration/countries')), quiet(get<any>('/configuration/payment-methods'))]).then(([projects, providers, countries, methods]) => {
      if (!live) return;
      setRef({
        projects: (projects?.projects ?? []).map((p: any) => ({ id: p.id, name: p.name })),
        providers: (providers?.providers ?? []).map((p: any) => ({ id: p.id, name: p.name })),
        countries: (countries?.countries ?? []).map((c: any) => ({ code: c.code, name: c.name })),
        methods: (methods?.payment_methods ?? []).map((m: any) => m.code),
        currencies: (countries?.currencies ?? []).map((c: any) => c.code),
        ready: true,
      });
    });
    return () => { live = false; };
  }, []);
  return ref;
}

/** A chip over plain values. A chip with nothing to offer is left out. */
export function chip<T>(key: string, label: string, values: string[] | { value: string; label: string }[]): Filter<T>[] {
  const options = values.map((v) => (typeof v === 'string' ? { value: v, label: v.replace(/_/g, ' ') } : v));
  return options.length ? [{ key, label, options }] : [];
}

/** The administrators a chip can name; empty when this administrator may not list them. */
export function useAdministrators(): { id: string; name: string }[] {
  const [admins, setAdmins] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    get<any>('/oversight/administrators').then((r) => { if (live) setAdmins(r.administrators.map((a: any) => ({ id: a.id, name: a.name }))); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return admins;
}

/** A chip over values read from the rows themselves; the list is held in memory, so the chip filters it there. */
export function chipBy<T>(key: string, label: string, values: string[] | { value: string; label: string }[], of: (r: T) => string | null | undefined): Filter<T>[] {
  return chip<T>(key, label, values).map((f) => ({ ...f, match: (r, v) => of(r) === v }));
}

/** The distinct non-empty values of a column, sorted: what a chip over an in-memory list offers. */
export const distinct = <T,>(rows: T[], of: (r: T) => string | null | undefined): string[] => [...new Set(rows.flatMap((r) => of(r) ?? []))].sort();

/** Yes/no chip over a boolean column. */
export function yesNo<T>(key: string, label: string, t: (k: string) => string, of: (r: T) => boolean): Filter<T>[] {
  return chipBy<T>(key, label, [{ value: 'yes', label: t('l.yes') }, { value: 'no', label: t('l.no') }], (r) => (of(r) ? 'yes' : 'no'));
}
