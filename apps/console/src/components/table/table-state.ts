import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export type TableState = { q: string; filters: Record<string, string>; sort?: string; order: 'asc' | 'desc'; page: number; pageSize: 25 | 50 | 100 };
/** `sorts` and `filterValues`, when given, are the only values accepted from the URL. */
export type TableDefaults = { sort: string; order: 'asc' | 'desc'; filterKeys: string[]; sorts?: string[]; filterValues?: Record<string, string[]> };

export const PAGE_SIZES = [25, 50, 100] as const;

/** The page a list may show: past the end falls back to the last page, never below 1. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const last = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, Math.trunc(page) || 1), last);
}

/** Changing what the list holds (search, filter, sort, page size) starts again from the first page. */
export function patchTableState(state: TableState, patch: Partial<TableState>): TableState {
  const restarts = ['q', 'filters', 'sort', 'order', 'pageSize'].some((k) => k in patch);
  return { ...state, ...patch, page: restarts ? 1 : (patch.page ?? state.page) };
}

/** Invalid values are dropped, never thrown: a hand-edited URL still opens a list. */
export function readTableState(params: URLSearchParams, prefix: string, defaults: TableDefaults): TableState {
  const get = (k: string) => params.get(prefix + k);
  const page = Number(get('page'));
  const size = Number(get('page_size'));
  const order = get('order');
  const sort = get('sort');
  const filters: Record<string, string> = {};
  for (const key of defaults.filterKeys) { const v = get(key); if (v && (!defaults.filterValues?.[key] || defaults.filterValues[key]!.includes(v))) filters[key] = v; }
  return {
    q: get('q') ?? '',
    filters,
    sort: sort && (!defaults.sorts || defaults.sorts.includes(sort)) ? sort : defaults.sort,
    order: order === 'asc' || order === 'desc' ? order : defaults.order,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? (size as 25 | 50 | 100) : 25,
  };
}

/** Writes the list's params onto a copy of `current`, leaving the page's other params alone. An empty filter value removes its param. */
export function writeTableState(state: TableState, prefix: string, current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  const put = (k: string, v: string | undefined) => { if (v) next.set(prefix + k, v); else next.delete(prefix + k); };
  put('q', state.q);
  for (const [k, v] of Object.entries(state.filters)) put(k, v);
  put('sort', state.sort);
  put('order', state.order);
  put('page', state.page > 1 ? String(state.page) : undefined);
  put('page_size', state.pageSize !== 25 ? String(state.pageSize) : undefined);
  return next;
}

export function useTableState(prefix: string, defaults: TableDefaults): [TableState, (patch: Partial<TableState>) => void] {
  const [params, setParams] = useSearchParams();
  const key = JSON.stringify(defaults);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const d = useMemo(() => defaults, [key]);
  const state = useMemo(() => readTableState(params, prefix, d), [params, prefix, d]);
  const set = useCallback((patch: Partial<TableState>) => {
    setParams((prev) => writeTableState(patchTableState(readTableState(prev, prefix, d), patch), prefix, prev));
  }, [setParams, prefix, d]);
  return [state, set];
}
