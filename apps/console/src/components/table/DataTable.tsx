import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useSession, useT } from '../../lib/session';
import { Empty, ErrorLine, ScopeNote } from '../common';
import { clientRows } from './client-rows';
import { pageItems } from './pager';
import { clampPage, PAGE_SIZES, useTableState, type TableState } from './table-state';
import { t as translate, type Lang } from '../../lib/i18n';

export type { TableState } from './table-state';

export type Column<T> = { key: string; label: string; render: (row: T) => ReactNode; text?: (row: T) => string; sortValue?: (row: T) => string | number; sortKey?: string; align?: 'end'; mono?: boolean };
export type Filter<T> = { key: string; label: string; options: { value: string; label: string }[]; match?: (row: T, value: string) => boolean };
export type RowAction<T> = { label: string; when?: (row: T) => boolean; to?: (row: T) => string; run?: (row: T) => void | Promise<void>; primary?: boolean; opens?: boolean };
type Fetched<T> = { data: T[]; total: number; scoped?: boolean };

export type DataTableProps<T> = {
  rows?: T[]; fetch?: (state: TableState) => Promise<Fetched<T>>; prefix?: string;
  columns: Column<T>[]; filters?: Filter<T>[]; actions?: RowAction<T>[]; summary?: (row: T, openAction?: string) => ReactNode;
  rowKey: (row: T) => string; defaultSort: string; defaultOrder?: 'asc' | 'desc'; searchLabel?: string; /** false for a list whose endpoint has nothing to match a search against: a box that finds nothing is worse than none. */ search?: boolean; filterDefaults?: Record<string, string>;
  /** A filter the page holds outside the table: the empty state then reads as filtered, and clearing it is the page's `onClearFilters`. */ filtered?: boolean; onClearFilters?: () => void;
  empty: { none: string; why: string }; bare?: boolean;
};

const MAX_ACTIONS = 3;

/** The page to ask for instead of `requested`, or null when it is fine: past the end falls back to the last page. */
export function pageToRequest(requested: number, total: number, pageSize: number): number | null {
  const page = clampPage(requested, total, pageSize);
  return page === requested ? null : page;
}

/** "1–25 of 1,204" / "1–25 sur 1 204", numbers grouped the way the language groups them. */
export function formatRange(lang: Lang, page: number, pageSize: number, total: number): string {
  const n = new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-US');
  return translate(lang, 'table.range', { from: n.format(total === 0 ? 0 : (page - 1) * pageSize + 1), to: n.format(Math.min(page * pageSize, total)), total: n.format(total) });
}

/** Runs a row action; a rejection comes back as its message instead of vanishing. */
export async function runRowAction<T>(a: RowAction<T>, row: T): Promise<string | null> {
  try { await a.run?.(row); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/** A summary laid out as labelled values on a grid. */
export function SummaryGrid({ items }: { items: { label: string; value: ReactNode }[] }) {
  return <div className="sumgrid">{items.map((i) => <div key={i.label}><span>{i.label}</span>{i.value}</div>)}</div>;
}

/** `bare` is the look alone: rows as given, no URL state, no sort, no toolbar, no footer. */
export function DataTable<T>(props: DataTableProps<T>) {
  if (props.bare) {
    const rows = props.rows ?? [];
    return rows.length === 0
      ? <Empty text={`${props.empty.none} ${props.empty.why}`} />
      : <TableGrid rows={rows} columns={props.columns} actions={props.actions ?? []} summary={props.summary} rowKey={props.rowKey} />;
  }
  return <FullTable {...props} />;
}

function FullTable<T>(props: DataTableProps<T>) {
  const { columns, filters = [], actions = [], summary, rowKey } = props;
  const t = useT();
  const { lang } = useSession();
  const server = !props.rows && !!props.fetch;
  const sortKeyOf = (c: Column<T>) => (server ? c.sortKey : c.sortValue ? c.key : undefined);
  const [state, setState] = useTableState(props.prefix ?? '', {
    sort: props.defaultSort, order: props.defaultOrder ?? 'asc', filterKeys: filters.map((f) => f.key),
    sorts: [props.defaultSort, ...columns.flatMap((c) => sortKeyOf(c) ?? [])],
    filterValues: Object.fromEntries(filters.map((f) => [f.key, f.options.map((o) => o.value)])), filterDefaults: props.filterDefaults,
  });
  const number = new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-US');

  if (actions.length > MAX_ACTIONS && import.meta.env?.DEV) console.error(`DataTable: ${actions.length} row actions declared, at most ${MAX_ACTIONS} are shown`);

  // Server mode: the list the server returned for the current state.
  const [remote, setRemote] = useState<Fetched<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const fetchRef = useRef(props.fetch);
  fetchRef.current = props.fetch;
  const stateKey = JSON.stringify(state);
  useEffect(() => {
    if (!server) return;
    let live = true;
    setError(null);
    fetchRef.current!(state).then((res) => {
      if (!live) return;
      const page = pageToRequest(state.page, res.total, state.pageSize);
      if (page !== null) { setState({ page }); return; } // past the end: ask again for the last page
      setRemote(res);
    }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, stateKey, attempt]);

  const local = server ? null : clientRows(props.rows ?? [], state, columns, filters);
  const rows = server ? (remote?.data ?? []) : local!.rows;
  const total = server ? (remote?.total ?? 0) : local!.total;
  const page = clampPage(state.page, total, state.pageSize);
  const last = Math.max(1, Math.ceil(total / state.pageSize));
  const loading = server && !remote && !error;

  const filtering = !!props.filtered || !!state.q || Object.values(state.filters).some(Boolean);
  const clearFilters = () => { props.onClearFilters?.(); setState({ q: '', filters: Object.fromEntries(Object.keys(state.filters).map((k) => [k, ''])) }); };
  return (
    <div className="dt">
      <ScopeNote scoped={server ? remote?.scoped : undefined} />
      <form className="dt-bar" role="search" onSubmit={(e) => e.preventDefault()}>
        {props.search !== false && <SearchBox value={state.q} label={props.searchLabel ?? t('table.search')} onCommit={(q) => setState({ q })} />}
        {filters.map((f) => <FilterChip key={f.key} filter={f} value={state.filters[f.key] ?? ''} onChange={(v) => setState({ filters: { ...state.filters, [f.key]: v } })} />)}
      </form>
      {error && <div className="dt-error"><ErrorLine error={error} /><button type="button" onClick={() => setAttempt((n) => n + 1)}>{t('table.retry')}</button></div>}
      {loading && <p className="muted">{t('common.loading')}</p>}
      {!loading && !error && total === 0 && (
        <div className="dt-empty">
          {filtering
            ? <><p><strong>{t('table.no_match')}</strong></p><button type="button" onClick={clearFilters}>{t('table.clear_filters')}</button></>
            : <><p><strong>{props.empty.none}</strong></p><p className="muted">{props.empty.why}</p></>}
        </div>
      )}
      {total > 0 && <TableGrid rows={rows} columns={columns} actions={actions} summary={summary} rowKey={rowKey} sort={{ state, keyOf: sortKeyOf, onSort: setState }} />}
      {total > 0 && (
        <div className="dt-foot">
          <span>{formatRange(lang, page, state.pageSize, total)}</span>
          <span className="sp" />
          <nav className="pg" aria-label={t('table.page')}>
            <button type="button" aria-label={t('table.prev')} disabled={page <= 1} onClick={() => setState({ page: page - 1 })}>‹</button>
            {pageItems(page, last).map((it, i) => it === '…'
              ? <span key={`gap${i}`} className="gap" aria-hidden="true">…</span>
              : <button key={it} type="button" className={it === page ? 'primary' : undefined} aria-current={it === page ? 'page' : undefined} aria-label={`${t('table.page')} ${it}`} onClick={() => setState({ page: it })}>{number.format(it)}</button>)}
            <button type="button" aria-label={t('table.next')} disabled={page >= last} onClick={() => setState({ page: page + 1 })}>›</button>
          </nav>
          <label className="dt-size"><span className="sr-only">{t('table.page_size')}</span>
            <select value={state.pageSize} onChange={(e) => setState({ pageSize: Number(e.target.value) as 25 | 50 | 100 })}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} {t('table.page_size')}</option>)}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

function TableGrid<T>({ rows, columns, actions, summary, rowKey, sort }: {
  rows: T[]; columns: Column<T>[]; actions: RowAction<T>[]; summary?: (row: T, openAction?: string) => ReactNode; rowKey: (row: T) => string;
  sort?: { state: TableState; keyOf: (c: Column<T>) => string | undefined; onSort: (patch: Partial<TableState>) => void };
}) {
  const t = useT();
  const [expanded, setExpanded] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const toggle = (k: string) => setExpanded((e) => { const n = { ...e }; if (k in n) delete n[k]; else n[k] = ''; return n; });
  const shownActions = (row: T) => {
    const list = actions.filter((a) => !a.when || a.when(row));
    return [...list.filter((a) => a.primary), ...list.filter((a) => !a.primary)].slice(0, MAX_ACTIONS);
  };
  const hasActions = actions.length > 0;
  const span = columns.length + (summary ? 1 : 0) + (hasActions ? 1 : 0);
  // Only an action declaring `opens` unfolds the row, handing its label to the summary.
  const act = async (a: RowAction<T>, row: T) => {
    setFailure(await runRowAction(a, row));
    if (a.opens && summary) setExpanded((e) => ({ ...e, [rowKey(row)]: a.label }));
  };

  const head = (
    <thead>
      <tr>
        {summary && <th className="chev"><span className="sr-only">{t('table.details')}</span></th>}
        {columns.map((c) => {
          const sk = sort?.keyOf(c);
          const cls = c.align === 'end' ? 'num' : undefined;
          if (!sk) return <th key={c.key} className={cls}>{c.label}</th>;
          const on = sort!.state.sort === sk;
          return (
            <th key={c.key} className={cls} aria-sort={on ? (sort!.state.order === 'asc' ? 'ascending' : 'descending') : 'none'}>
              <button type="button" className="sort" onClick={() => sort!.onSort(on ? { order: sort!.state.order === 'asc' ? 'desc' : 'asc' } : { sort: sk, order: 'asc' })}>
                {c.label}<span className={on ? 's on' : 's'} aria-hidden="true">{on ? (sort!.state.order === 'asc' ? '▲' : '▼') : '▲▼'}</span>
              </button>
            </th>
          );
        })}
        {hasActions && <th className="act">{t('table.actions')}</th>}
      </tr>
    </thead>
  );

  const body = (
    <tbody>
      {rows.map((row) => {
        const k = rowKey(row);
        const open = k in expanded;
        return [
          <tr key={k} className={open ? 'open' : undefined}>
            {summary && (
              <td className="chev">
                <button type="button" className="toggle" aria-expanded={open} aria-controls={`sum-${k}`} aria-label={t('table.details')} onClick={() => toggle(k)}>{open ? '▾' : '▸'}</button>
              </td>
            )}
            {columns.map((c) => <td key={c.key} className={[c.align === 'end' ? 'num' : '', c.mono ? 'mono' : ''].filter(Boolean).join(' ') || undefined}>{c.render(row)}</td>)}
            {hasActions && (
              <td className="act">
                {shownActions(row).map((a) => a.to
                  ? <Link key={a.label} to={a.to(row)} className={a.primary ? 'btn primary' : 'btn'}>{a.label}</Link>
                  : <button key={a.label} type="button" className={a.primary ? 'primary' : undefined} onClick={() => void act(a, row)}>{a.label}</button>)}
              </td>
            )}
          </tr>,
          open && summary && <tr key={`${k}-sum`} className="sum" id={`sum-${k}`}><td colSpan={span}>{summary(row, expanded[k] || undefined)}</td></tr>,
        ];
      })}
    </tbody>
  );

  return <>
    <ErrorLine error={failure} />
    <div className="dt-scroll"><table>{head}{body}</table></div>
  </>;
}

/** The typed text is kept locally and committed to the URL a moment after the last keystroke, or on Enter. */
function SearchBox({ value, label, onCommit }: { value: string; label: string; onCommit: (q: string) => void }) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setText(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = (q: string) => { clearTimeout(timer.current); if (q !== value) onCommit(q); };
  return (
    <input type="search" className="dt-search" aria-label={label} placeholder={label} value={text}
      onChange={(e) => { setText(e.target.value); clearTimeout(timer.current); const q = e.target.value; timer.current = setTimeout(() => commit(q), 300); }}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(text); }} />
  );
}

/**
 * Whether a blur leaves the chip's menu open. Safari and Firefox on macOS do not focus a button on click, so
 * the blur that a press on a menu option causes names no related target: that press must not close the menu
 * before its click lands. A press elsewhere is closed by the pointer listener instead.
 */
export const staysOpen = (box: Node, related: EventTarget | null) => related === null || box.contains(related as Node);

function FilterChip<T>({ filter, value, onChange }: { filter: Filter<T>; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const active = filter.options.find((o) => o.value === value);
  return (
    <span ref={box} className="chip-wrap" onBlur={(e) => { if (!staysOpen(e.currentTarget, e.relatedTarget)) setOpen(false); }} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
      <button type="button" className={active ? 'chip active' : 'chip'} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        {active ? `${filter.label} : ${active.label}` : `+ ${filter.label}`}
      </button>
      {active && <button type="button" className="chip-clear" aria-label={t('table.clear_filter', { filter: filter.label })} onClick={() => { onChange(''); setOpen(false); }}>✕</button>}
      {open && (
        <div className="chip-menu">
          {filter.options.map((o) => <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => { onChange(o.value); setOpen(false); }}>{o.label}</button>)}
        </div>
      )}
    </span>
  );
}
