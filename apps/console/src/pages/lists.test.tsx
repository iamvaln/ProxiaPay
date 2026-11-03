import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from '../components/table/DataTable';
import { t as translate } from '../lib/i18n';
import { listPath } from './list-support';
import { transactionFetch, transactionList } from './Transactions';
import { previewList } from './Previews';
import { SearchResults } from './Search';
import { entryList } from './FloatDetail';
import { discrepancyList } from './Reconciliation';
import { alertList } from './Oversight';
import { deliveryList } from './ProjectDetail';

const fr = (k: string, v?: Record<string, string | number>) => translate('fr', k, v);
const noRef = { projects: [], providers: [], countries: [], methods: [], currencies: [] };
const wrap = (el: React.ReactNode) => html(<MemoryRouter>{el}</MemoryRouter>);
/** The visible header labels: the summary toggle's column and the sort arrows are not labels. */
const headers = (out: string) => [...out.matchAll(/<th(?=[\s>])(?![^>]*class="chev")[^>]*>(.*?)<\/th>/g)].map((m) => m[1]!.replace(/<span[^>]*aria-hidden="true"[^>]*>.*?<\/span>/g, '').replace(/<[^>]+>/g, ''));
const none = () => undefined;

const txn = { id: 'i1', reference: 'txn_abc', project_name: 'Shop', project_reference: 'ord-1', direction: 'collection', country_code: 'CM', payment_method_code: 'MOMO', currency_code: 'XAF', requested_amount: 1000, charged_amount: 1010, settled_amount: 990, processing_fee: 10, platform_fee: 5, processing_fee_bearer: 'counterparty', platform_fee_bearer: 'project', state: 'processing', reconciliation_status: 'unreviewed', msisdn_masked: '+237•••0001', provider_reference: 'prov-1', operator_reference: 'op-1', created_at: '2026-11-03T10:00:00Z', terminal_at: null, failure_reason: null };

describe('the transaction list', () => {
  const cfg = transactionList({ t: fr, has: () => true, ref: noRef, reload: none });
  it('keeps to its columns and folds amounts into the summary', () => {
    const out = wrap(<DataTable rows={[txn]} {...cfg} />);
    expect(headers(out)).toEqual(['Référence', 'Projet', 'Type', 'Route', 'Montant', 'État', 'Rapprochement', 'Créée', 'Actions']);
    expect(out).not.toContain('Débité');
    expect(wrap(<>{cfg.summary!(txn)}</>)).toContain('Débité au payeur');
  });

  it('offers Revérifier only on a transaction still in flight, and only with the permission', () => {
    const recheck = cfg.actions!.find((a) => a.label === 'Revérifier')!;
    expect(recheck.when!({ ...txn, state: 'undetermined' })).toBe(true);
    expect(recheck.when!({ ...txn, state: 'succeeded' })).toBe(false);
    const without = transactionList({ t: fr, has: () => false, ref: noRef, reload: none }).actions!.find((a) => a.label === 'Revérifier')!;
    expect(without.when!({ ...txn, state: 'processing' })).toBe(false);
    expect(recheck.opens).toBeUndefined();
  });

  it('adds the project and provider account filters, and drops the project chip on a project page', () => {
    const ref = { ...noRef, projects: [{ id: 'p1', name: 'Shop' }], providers: [{ id: 'a1', name: 'MTN CM' }] };
    const keys = (c: ReturnType<typeof transactionList>) => c.filters!.map((f) => f.key);
    expect(keys(transactionList({ t: fr, has: () => true, ref, reload: none }))).toEqual(expect.arrayContaining(['project', 'provider_account']));
    expect(keys(transactionList({ t: fr, has: () => true, ref, reload: none, project: true }))).not.toContain('project');
  });

  it('sorts by amount only once a currency is chosen', () => {
    const sortable = (currency?: string) => transactionList({ t: fr, has: () => true, ref: noRef, reload: none, currency }).columns.find((c) => c.key === 'amount')!.sortKey;
    expect(sortable()).toBeUndefined();
    expect(sortable('XAF')).toBe('amount');
  });

  it('explains an empty list in French', () => {
    const out = wrap(<DataTable rows={[]} {...cfg} />);
    expect(out).toContain('Aucune transaction');
    expect(out).toContain('Les transactions apparaissent ici');
  });
});

describe('a project page shows its activity filtered to the project', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('asks the transactions endpoint for that project', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [], total: 0, page: 1, page_size: 25 })));
    vi.stubGlobal('fetch', fetchMock);
    await transactionFetch('proj-123')({ q: '', filters: {}, sort: 'created', order: 'desc', page: 1, pageSize: 25 });
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toMatch(/^\/console\/transactions\?/);
    expect(url).toContain('project=proj-123');
  });
  it('mounts the shared transaction list under its own prefix', () => {
    const src = readFileSync(join(__dirname, 'ProjectDetail.tsx'), 'utf8');
    expect(src).toContain('<TransactionTable fixedProject={id} prefix="act_" />');
    expect(src).not.toMatch(/data\.(activity|deliveries|origin_refusals)/);
  });
  it('builds a query from the table state', () => {
    const q = listPath('/x', { q: 'abc', filters: { state: 'failed', period: 'd7' }, sort: 'created', order: 'desc', page: 3, pageSize: 50 }, { period: 'created_after' });
    expect(q).toContain('page=3');
    expect(q).toContain('page_size=50');
    expect(q).toContain('state=failed');
    expect(q).toContain('created_after=');
    expect(q).not.toContain('period=');
  });
});

describe('float entries link to the transaction itself', () => {
  it('opens /transactions/<reference>, never a search', () => {
    const cfg = entryList({ t: fr, currency: 'XAF' });
    const entry = { id: 'p1', entry_type: 'collection', side: 'debit', amount: 100, occurred_at: '2026-11-03T10:00:00Z', transaction_id: 'x', transaction_reference: 'txn_abc', justification: null, reference: null };
    expect(cfg.actions![0]!.to!(entry)).toBe('/transactions/txn_abc');
    const out = wrap(<>{cfg.summary!(entry)}</>) + wrap(<DataTable rows={[entry]} {...cfg} />);
    expect(out).toContain('href="/transactions/txn_abc"');
    expect(out).not.toContain('?q=');
    expect(cfg.actions![0]!.when!({ ...entry, transaction_reference: null })).toBe(false);
  });
});

describe('search', () => {
  const data = { transactions: [{ id: '1', reference: 'txn_abc', state: 'succeeded' }], previews: [{ id: '2', reference: 'prv_abc', state: 'open' }], capped: false };
  it('says when results stopped at the cap', () => {
    expect(translate('fr', 'l.search_capped')).toBe('50 premiers résultats ; affinez la recherche');
    expect(wrap(<SearchResults q="txn" data={{ ...data, capped: true }} />)).toContain('First 50 results; narrow the search');
    expect(wrap(<SearchResults q="txn" data={data} />)).not.toContain('narrow the search');
  });
  it('links out to previews only for a reference search, never for a payer number', () => {
    expect(wrap(<SearchResults q="prv_abc" data={data} />)).toContain('/transactions/previews?q=prv_abc');
    const byNumber = wrap(<SearchResults q="+237670000001" data={data} />);
    expect(byNumber).not.toContain('/transactions/previews');
    expect(byNumber).toContain('prv_abc');
  });
});

describe('the other lists', () => {
  it('previews open the transaction only when one exists', () => {
    const a = previewList({ t: fr, ref: noRef }).actions![0]!;
    expect(a.when!({ transaction_reference: 'txn_1' })).toBe(true);
    expect(a.when!({ transaction_reference: null })).toBe(false);
  });
  it('a discrepancy can be taken only by someone who may decide, while it is unresolved and not already theirs', () => {
    const mine = { id: 'd', status: 'open', assignee_id: 'me' };
    const take = (has: boolean) => discrepancyList({ t: fr, has: () => has, me: 'me', ref: noRef, reload: none }).actions!.find((x) => x.label === 'M’attribuer')!;
    expect(take(true).when!({ ...mine, assignee_id: null })).toBe(true);
    expect(take(true).when!(mine)).toBe(false);
    expect(take(true).when!({ ...mine, status: 'resolved', assignee_id: null })).toBe(false);
    expect(take(false).when!({ ...mine, assignee_id: null })).toBe(false);
  });
  it('an alert can be acknowledged while open, and always acted on through its link', () => {
    const acts = alertList({ t: fr, has: () => true, reload: none }).actions!;
    expect(acts.map((a) => a.label)).toEqual(['Ouvrir', 'Acquitter', 'Agir']);
    expect(acts[1]!.when!({ status: 'open' })).toBe(true);
    expect(acts[1]!.when!({ status: 'cleared' })).toBe(false);
    expect(acts[2]!.to!({ action_reference: '/treasury' })).toBe('/treasury');
  });
  it('a delivery is replayed through the permission the transaction page uses', () => {
    const replay = deliveryList({ t: fr, has: (p) => p === 'transactions.replay_notification', reload: none }).actions![0]!;
    expect(replay.label).toBe('Rejouer');
    expect(replay.when!({})).toBe(true);
    expect(deliveryList({ t: fr, has: () => false, reload: none }).actions![0]!.when!({})).toBe(false);
  });
  it('no action asks for a confirmation code without opening its row', () => {
    for (const cfg of [transactionList({ t: fr, has: () => true, ref: noRef, reload: none }), alertList({ t: fr, has: () => true, reload: none })]) {
      for (const a of cfg.actions!) expect(a.opens ?? false).toBe(false);
    }
  });
});

describe('every list page', () => {
  const dir = __dirname;
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  // Tables kept as plain markup for Task 6: short, ordered or non-list tables on these pages.
  const KEPT: Record<string, number> = {
    'Transactions.tsx': 0, 'Previews.tsx': 0, 'Search.tsx': 0, 'Reconciliation.tsx': 0, 'FloatDetail.tsx': 0,
    'Treasury.tsx': 2, // float accounts, project balances
    'ProjectDetail.tsx': 3, // credentials, declared origins, entitlements
    'Oversight.tsx': 5, // health measures (2), reporting pivot, administrators, roles
  };
  it('renders no raw <table> outside DataTable', () => {
    for (const [file, kept] of Object.entries(KEPT)) expect([file, (read(file).match(/<table/g) ?? []).length]).toEqual([file, kept]);
  });
  it('reads no sub-list the server no longer embeds', () => {
    const src = Object.keys(KEPT).map(read).join('\n');
    expect(src).not.toMatch(/data\.(origin_refusals|deliveries|activity|entries|results)\b/);
    expect(src).not.toMatch(/\.(discrepancies|runs)\.map/);
  });
  it('has every interface string in both languages', () => {
    const i18n = readFileSync(join(dir, '..', 'lib', 'i18n.ts'), 'utf8');
    const used = new Set<string>();
    for (const f of [...Object.keys(KEPT), 'list-support.tsx']) for (const m of read(f).matchAll(/\bt\('([a-z_]+\.[a-z_0-9]+)'/g)) used.add(m[1]!);
    for (const k of used) expect(i18n, k).toMatch(new RegExp(`'${k.replace('.', '\\.')}': \\{ en: .*fr: `));
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });
});
