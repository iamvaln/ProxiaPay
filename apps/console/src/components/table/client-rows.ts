import type { Column, Filter } from './DataTable';
import { clampPage, type TableState } from './table-state';

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Search, filter, sort and page a list held in memory. The search covers what the columns show, names included. */
export function clientRows<T>(rows: T[], state: TableState, cols: Column<T>[], filters: Filter<T>[] = []): { rows: T[]; total: number } {
  let out = rows;
  const q = fold(state.q.trim());
  if (q) out = out.filter((r) => cols.some((c) => c.text && fold(c.text(r)).includes(q)));
  for (const f of filters) {
    const v = state.filters[f.key];
    if (v && f.match) out = out.filter((r) => f.match!(r, v));
  }
  const col = cols.find((c) => c.key === state.sort && c.sortValue);
  if (col) {
    const dir = state.order === 'desc' ? -1 : 1;
    out = [...out].sort((a, b) => {
      const x = col.sortValue!(a), y = col.sortValue!(b);
      return dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)));
    });
  }
  const page = clampPage(state.page, out.length, state.pageSize);
  return { rows: out.slice((page - 1) * state.pageSize, page * state.pageSize), total: out.length };
}
