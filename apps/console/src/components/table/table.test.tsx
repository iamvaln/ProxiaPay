import { renderToStaticMarkup as html } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { clientRows } from './client-rows';
import { DataTable, formatRange, pageToRequest, runRowAction, staysOpen, type Column, type Filter, type RowAction } from './DataTable';
import { pageItems } from './pager';
import { clampPage, patchTableState, readTableState, writeTableState, type TableState } from './table-state';

type Row = { id: string; name: string; n: number; state: string };
const D = { sort: 'name', order: 'asc' as const, filterKeys: ['state'] };
const base: TableState = { q: '', filters: {}, sort: 'name', order: 'asc', page: 1, pageSize: 25 };
const cols: Column<Row>[] = [
  { key: 'id', label: 'Reference', render: (r) => r.id, text: (r) => r.id, mono: true },
  { key: 'name', label: 'Name', render: (r) => r.name, text: (r) => r.name, sortValue: (r) => r.name },
  { key: 'n', label: 'Count', render: (r) => r.n, sortValue: (r) => r.n, align: 'end' },
];
const make = (count: number): Row[] => Array.from({ length: count }, (_, i) => ({ id: `r${i}`, name: `name${String(i).padStart(3, '0')}`, n: i, state: i % 2 ? 'a' : 'b' }));
const filters: Filter<Row>[] = [{ key: 'state', label: 'State', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], match: (r, v) => r.state === v }];
const empty = { none: 'No rows yet.', why: 'Rows appear when something happens.' };
const render = (props: Partial<React.ComponentProps<typeof DataTable<Row>>>, url = '/') =>
  html(<MemoryRouter initialEntries={[url]}><DataTable<Row> rows={make(3)} columns={cols} rowKey={(r) => r.id} defaultSort="name" empty={empty} {...props} /></MemoryRouter>);

describe('table state', () => {
  it('readTableState ignores invalid values', () => {
    const s = readTableState(new URLSearchParams('page=abc&page_size=7&order=up'), '', D);
    expect([s.page, s.pageSize, s.order, s.sort]).toEqual([1, 25, 'asc', 'name']);
  });
  it('falls back to defaults for an unknown sort, a negative or fractional page, and an unknown filter value', () => {
    const d = { ...D, sorts: ['name', 'n'], filterValues: { state: ['a', 'b'] } };
    const s = readTableState(new URLSearchParams('sort=zzz&page=-1&state=nope'), '', d);
    expect([s.sort, s.page, s.filters]).toEqual(['name', 1, {}]);
    expect(readTableState(new URLSearchParams('page=1.5'), '', d).page).toBe(1);
    const ok = readTableState(new URLSearchParams('sort=n&state=a'), '', d);
    expect([ok.sort, ok.filters]).toEqual(['n', { state: 'a' }]);
  });
  it('clearing a filter removes its param', () => {
    const out = writeTableState({ ...base, filters: { state: '' } }, '', new URLSearchParams('state=a&keep=1'));
    expect(out.has('state')).toBe(false);
    expect(out.get('keep')).toBe('1');
  });
  it('writeTableState namespaces with a prefix', () => {
    const out = writeTableState({ ...base, page: 2 }, 'del_', new URLSearchParams('keep=1'));
    expect(out.get('del_page')).toBe('2');
    expect(out.get('keep')).toBe('1');
    expect(readTableState(out, 'del_', D).page).toBe(2);
    expect(readTableState(out, '', D).page).toBe(1);
  });
  it('resets to page 1 when a filter changes', () => {
    const at7 = { ...base, page: 7 };
    expect(patchTableState(at7, { filters: { state: 'a' } }).page).toBe(1);
    expect(patchTableState(at7, { q: 'x' }).page).toBe(1);
    expect(patchTableState(at7, { sort: 'n' }).page).toBe(1);
    expect(patchTableState(at7, { page: 8 }).page).toBe(8);
  });
  it('clampPage moves past-the-end pages to the last page', () => {
    expect(clampPage(3, 30, 25)).toBe(2);
    expect(clampPage(1, 0, 25)).toBe(1);
    expect(clampPage(0, 100, 25)).toBe(1);
  });
});

describe('client rows', () => {
  it('searches what is shown, names included', () => {
    const rows = [{ id: 'BF', name: 'Burkina Faso', n: 1, state: 'a' }, { id: 'CM', name: 'Cameroun', n: 2, state: 'a' }];
    expect(clientRows(rows, { ...base, q: 'burkina' }, cols).rows.map((r) => r.id)).toEqual(['BF']);
  });
  it('sorts and pages', () => {
    const r = clientRows(make(60).reverse(), { ...base, page: 3 }, cols);
    expect(r.total).toBe(60);
    expect(r.rows).toHaveLength(10);
    expect(r.rows[0]!.name).toBe('name050');
  });
  it('applies filters through match', () => {
    expect(clientRows(make(10), { ...base, filters: { state: 'a' } }, cols, filters).total).toBe(5);
  });
});

describe('pageItems', () => {
  it('collapses long ranges', () => {
    expect(pageItems(5, 49)).toEqual([1, '…', 4, 5, 6, '…', 49]);
    expect(pageItems(1, 3)).toEqual([1, 2, 3]);
    expect(pageItems(1, 49)).toEqual([1, 2, '…', 49]);
  });
});

describe('DataTable', () => {
  it('shows the total and the range', () => {
    expect(render({ rows: make(1204) })).toContain('1–25 of 1,204');
    expect(new Intl.NumberFormat('fr-FR').format(1204)).toBe('1 204');
  });
  it('renders sortable headers as buttons inside th with aria-sort', () => {
    const out = render({ rows: make(3) });
    expect(out).toContain('aria-sort="ascending"');
    expect(out).toMatch(/<th[^>]*aria-sort="none"[^>]*><button[^>]*class="sort"/);
  });
  it('renders a summary toggle as a button with aria-expanded', () => {
    const out = render({ summary: (r) => <b>{r.id}</b> });
    expect(out).toMatch(/<button[^>]*aria-expanded="false"/);
  });
  it('shows at most three actions, Ouvrir first', () => {
    const a = (label: string, primary = false): RowAction<Row> => ({ label, primary, to: (r) => `/x/${r.id}` });
    const out = render({ rows: make(1), actions: [a('Replay'), a('Ouvrir', true), a('Other')] });
    expect(out.indexOf('Ouvrir')).toBeLessThan(out.indexOf('Replay'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const four = render({ rows: make(1), actions: [a('Ouvrir', true), a('B'), a('C'), a('D')] });
    expect(four).not.toContain('>D<');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  it('explains an empty list, and offers to clear filters when filters are on', () => {
    const none = render({ rows: [] });
    expect(none).toContain('No rows yet.');
    expect(none).toContain('Rows appear when something happens.');
    const filtered = render({ rows: make(4), filters }, '/?state=zzz&q=nomatch');
    expect(filtered).toContain('No results for these filters');
    expect(filtered).toContain('Clear filters');
  });
  it('shows an active filter chip with its value and a clear control', () => {
    const out = render({ rows: make(4), filters }, '/?state=a');
    expect(out).toContain('State : Alpha');
    expect(out).toContain('Clear State');
  });
  it('asks for the last page when the server says the page is past the end', () => {
    expect(pageToRequest(3, 30, 25)).toBe(2);
    expect(pageToRequest(2, 30, 25)).toBeNull();
    expect(pageToRequest(1, 0, 25)).toBeNull();
    expect(render({ rows: undefined, fetch: vi.fn() }, '/?page=3')).toContain('Loading…');
  });
  it('formats the range with the language grouping', () => {
    expect(formatRange('fr', 1, 25, 1204)).toBe('1–25 sur 1\u202f204');
    expect(formatRange('en', 1, 25, 1204)).toBe('1–25 of 1,204');
    expect(formatRange('en', 1, 25, 0)).toBe('0–0 of 0');
    expect(formatRange('en', 49, 25, 1204)).toBe('1,201–1,204 of 1,204');
  });
  it('a bare table renders its rows as given, with no router, no paging, no sort', () => {
    const out = html(<DataTable<Row> bare rows={make(30)} columns={cols} rowKey={(r) => r.id} defaultSort="name" empty={empty} />);
    expect(out.match(/<tr/g)).toHaveLength(31);
    expect(out).not.toContain('aria-sort');
    expect(out).not.toContain('<button');
  });
  it('a failed action is reported, not swallowed', async () => {
    const boom: RowAction<Row> = { label: 'Go', run: async () => { throw new Error('refused by server'); } };
    expect(await runRowAction(boom, make(1)[0]!)).toBe('refused by server');
    expect(await runRowAction({ label: 'Ok', run: () => undefined }, make(1)[0]!)).toBeNull();
  });
  it('a plain action never opens the summary; only opens: true does', () => {
    const out = render({ rows: make(1), summary: () => <i>S</i>, actions: [{ label: 'Plain', run: () => undefined }, { label: 'Confirm', opens: true }] });
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('Plain');
    expect(out).toContain('Confirm');
  });
});

describe('tuning after a pass over every list', () => {
  it('a blur that names no related target keeps a chip menu open, one that leaves the chip closes it', () => {
    const inside = {} as Node;
    const box = { contains: (n: unknown) => n === inside } as unknown as Node;
    expect(staysOpen(box, null)).toBe(true);
    expect(staysOpen(box, inside as unknown as EventTarget)).toBe(true);
    expect(staysOpen(box, {} as EventTarget)).toBe(false);
  });

  it('the scope note sits above the toolbar, where it is seen before the rows', () => {
    const src = readFileSync(new URL('./DataTable.tsx', import.meta.url), 'utf8');
    expect(src.indexOf('<ScopeNote')).toBeGreaterThan(-1);
    expect(src.indexOf('<ScopeNote')).toBeLessThan(src.indexOf('className="dt-bar"'));
  });
});
