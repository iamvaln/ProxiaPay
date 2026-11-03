import { Link, useSearchParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, Pill, Tag, When } from '../components/common';
import { DataTable, SummaryGrid, type Column, type DataTableProps, type Filter, type RowAction } from '../components/table/DataTable';
import { readTableState } from '../components/table/table-state';
import { chip, fetchPage, listPath, useReference, useReload, type Reference } from './list-support';

const STATES = ['created', 'action_required', 'submitted', 'processing', 'succeeded', 'failed', 'expired', 'undetermined'];
const RECON = ['unreviewed', 'matched', 'disputed', 'examined', 'corrected'];
const FAILURES = ['PAYER_DECLINED', 'PAYER_UNRESPONSIVE', 'WALLET_NOT_FOUND', 'WALLET_INACTIVE', 'WALLET_LIMIT_EXCEEDED', 'WALLET_BALANCE_INSUFFICIENT', 'CODE_ATTEMPTS_EXHAUSTED', 'ACTION_WINDOW_EXPIRED', 'PROVIDER_REJECTED', 'PROVIDER_UNAVAILABLE', 'NO_PROVIDER_AVAILABLE', 'OUTCOME_UNDETERMINED'];
/** A transaction in these states can still be asked about at the provider. */
const RECHECKABLE = ['submitted', 'processing', 'undetermined'];
/** The page's own range parameters, beside the table's: they are not chips because they take free values. */
const RANGE = ['created_after', 'created_before', 'amount_min', 'amount_max'] as const;
const FILTER_KEYS = ['state', 'reconciliation_status', 'direction', 'project', 'country', 'payment_method', 'provider_account', 'currency', 'failure_reason'];

type Txn = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;

/** Columns, summary, actions and filters of the transaction list; the Transactions page and a project's activity both use it. */
export function transactionList({ t, has, ref, reload, currency, project }: { t: Tr; has: (p: string) => boolean; ref: Reference; reload: () => void; currency?: string; project?: boolean }): Pick<DataTableProps<Txn>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'defaultOrder' | 'empty'> {
  const columns: Column<Txn>[] = [
    { key: 'reference', label: t('col.reference'), mono: true, render: (r) => <Link to={`/transactions/${r.reference}`}>{r.reference}</Link> },
    ...(project ? [] : [{ key: 'project', label: t('col.project'), render: (r: Txn) => r.project_name }]),
    { key: 'type', label: t('col.type'), render: (r) => <Tag family="tag">{t(`l.${r.direction}`)}</Tag> },
    { key: 'route', label: t('col.route'), render: (r) => `${r.country_code} · ${r.payment_method_code}` },
    // Raw minor units only compare inside one currency, so the amount sorts once a currency is chosen.
    { key: 'amount', label: t('col.amount'), align: 'end', sortKey: currency ? 'amount' : undefined, render: (r) => <Amount minor={r.requested_amount} currency={r.currency_code} /> },
    { key: 'state', label: t('col.state'), render: (r) => <Pill value={r.state} /> },
    { key: 'reconciliation', label: t('col.reconciliation'), render: (r) => <Pill value={r.reconciliation_status} /> },
    { key: 'created', label: t('col.created'), sortKey: 'created', render: (r) => <When value={r.created_at} /> },
  ];
  const filters: Filter<Txn>[] = [
    ...chip<Txn>('state', t('col.state'), STATES),
    ...chip<Txn>('reconciliation_status', t('col.reconciliation'), RECON),
    ...chip<Txn>('direction', t('col.type'), [{ value: 'collection', label: t('l.collection') }, { value: 'disbursement', label: t('l.disbursement') }]),
    ...(project ? [] : chip<Txn>('project', t('col.project'), ref.projects.map((p) => ({ value: p.id, label: p.name })))),
    ...chip<Txn>('country', t('l.country'), ref.countries.map((c) => ({ value: c.code, label: c.name }))),
    ...chip<Txn>('payment_method', t('l.method'), ref.methods),
    ...chip<Txn>('provider_account', t('l.provider_account'), ref.providers.map((p) => ({ value: p.id, label: p.name }))),
    ...chip<Txn>('currency', t('l.currency'), ref.currencies),
    ...chip<Txn>('failure_reason', t('l.failure_reason'), FAILURES),
  ];
  const actions: RowAction<Txn>[] = [
    { label: t('table.open'), primary: true, to: (r) => `/transactions/${r.reference}` },
    // The same call and permission as the transaction page's force re-check.
    { label: t('l.recheck'), when: (r) => has('transactions.recheck') && RECHECKABLE.includes(r.state), run: async (r) => { await post(`/transactions/${r.reference}/recheck`); reload(); } },
  ];
  const summary = (r: Txn) => (
    <SummaryGrid items={[
      { label: t('l.charged'), value: <Amount minor={r.charged_amount} currency={r.currency_code} /> },
      { label: t('l.received'), value: r.settled_amount == null ? <span className="muted">—</span> : <Amount minor={r.settled_amount} currency={r.currency_code} /> },
      { label: t('l.fees'), value: <span><Amount minor={r.processing_fee} currency={r.currency_code} /> <span className="small muted">({r.processing_fee_bearer})</span> + <Amount minor={r.platform_fee} currency={r.currency_code} /> <span className="small muted">({r.platform_fee_bearer})</span></span> },
      { label: t('l.payer'), value: r.msisdn_masked },
      { label: t('l.provider_reference'), value: <span className="mono">{r.provider_reference ?? '—'}</span> },
      { label: t('l.operator_reference'), value: <span className="mono">{r.operator_reference ?? '—'}</span> },
      { label: t('l.terminal'), value: r.terminal_at ? <When value={r.terminal_at} /> : <span className="muted">—</span> },
      { label: t('l.failure_reason'), value: r.failure_reason ?? '—' },
      { label: t('l.project_reference'), value: <span className="mono">{r.project_reference}</span> },
    ]} />
  );
  return { columns, filters, actions, summary, rowKey: (r) => r.id, defaultSort: 'created', defaultOrder: 'desc', empty: { none: t('l.txn_none'), why: t('l.txn_why') } };
}

/** The request behind the list: the table's state plus the page's own parameters, among them the project a list is fixed to. */
export const transactionFetch = (fixedProject?: string, range: Record<string, string> = {}) => fetchPage<Txn>('/transactions', { extra: { ...range, ...(fixedProject ? { project: fixedProject } : {}) } });

/** The transaction list wherever it appears. `fixedProject` narrows it to one project and drops that chip; `prefix` keeps its URL params apart from a page's other lists. */
export function TransactionTable({ fixedProject, prefix = '', range = {} }: { fixedProject?: string; prefix?: string; range?: Record<string, string> }) {
  const t = useT();
  const { has } = useSession();
  const ref = useReference();
  const [rev, reload] = useReload();
  const [params] = useSearchParams();
  const currency = params.get(`${prefix}currency`) ?? undefined;
  if (!ref.ready) return <p className="muted">{t('common.loading')}</p>;
  const cfg = transactionList({ t, has, ref, reload, currency, project: !!fixedProject });
  const extra = { ...range, ...(fixedProject ? { project: fixedProject } : {}) };
  return (
    <>
      {!currency && <p className="small muted">{t('l.amount_needs_currency')}</p>}
      <DataTable<Txn> key={`${rev}:${JSON.stringify(extra)}`} {...cfg} prefix={prefix} searchLabel={t('l.search_reference')} fetch={transactionFetch(fixedProject, range)} />
    </>
  );
}

/** Transaction search (console spec 5.1). */
export function TransactionsPage() {
  const t = useT();
  const { has } = useSession();
  const [params, setParams] = useSearchParams();
  const range = Object.fromEntries(RANGE.map((k) => [k, params.get(k) ?? '']).filter(([, v]) => v)) as Record<string, string>;
  const apply = (form: HTMLFormElement) => {
    const data = new FormData(form);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const k of RANGE) { const v = String(data.get(k) ?? ''); if (v) next.set(k, v); else next.delete(k); }
      next.delete('page');
      return next;
    });
  };
  // The server takes instants; the browser's datetime-local is the administrator's own clock.
  const sent = { ...range, ...(range.created_after ? { created_after: new Date(range.created_after).toISOString() } : {}), ...(range.created_before ? { created_before: new Date(range.created_before).toISOString() } : {}) };
  const exportCsv = async (e: React.MouseEvent) => {
    e.preventDefault();
    const state = readTableState(params, '', { sort: 'created', order: 'desc', filterKeys: FILTER_KEYS });
    const r = await get<{ csv: string; export_id: string }>(listPath('/transactions/export', state, { extra: sent }));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); a.download = `transactions-${r.export_id}.csv`; a.click();
  };
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{t('nav.transactions')}</h1>
        <div className="row"><Link to="/transactions/previews">{t('txn.previews')}</Link>{has('oversight.export') && <a href="#export" onClick={exportCsv}>{t('txn.export')}</a>}</div>
      </div>
      <form className="filters" key={JSON.stringify(range)} onSubmit={(e) => { e.preventDefault(); apply(e.currentTarget); }}>
        <label className="small">{t('l.created_after')} <input type="datetime-local" name="created_after" defaultValue={range.created_after ?? ''} /></label>
        <label className="small">{t('l.created_before')} <input type="datetime-local" name="created_before" defaultValue={range.created_before ?? ''} /></label>
        <label className="small">{t('l.amount_min')} <input type="number" name="amount_min" style={{ width: 110 }} defaultValue={range.amount_min ?? ''} /></label>
        <label className="small">{t('l.amount_max')} <input type="number" name="amount_max" style={{ width: 110 }} defaultValue={range.amount_max ?? ''} /></label>
        <button>{t('l.apply')}</button>
      </form>
      <TransactionTable range={sent} />
    </>
  );
}
