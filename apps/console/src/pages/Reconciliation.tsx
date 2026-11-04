import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, ErrorLine, NeedsPermission, Pill, Tag, When, useLoad } from '../components/common';
import { DataTable, SummaryGrid, type Column, type DataTableProps, type Filter, type RowAction } from '../components/table/DataTable';
import { AdjustmentForm } from './Adjustment';
import { chip, fetchPage, periodFilter, useReference, useReload, useTab, type Reference } from './list-support';

const TYPES = ['float_drift', 'fee_variance', 'orphan_transaction', 'missing_transaction', 'state_divergence', 'stale_undetermined', 'unconfirmed_transfer', 'checkpoint_mismatch'];
type Row = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;
const short = (id: string) => id.slice(0, 8);

export function discrepancyList({ t, has, me, ref, reload }: { t: Tr; has: (p: string) => boolean; me?: string; ref: Reference; reload: () => void }): Pick<DataTableProps<Row>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'defaultOrder' | 'empty'> {
  const account = (id: string) => ref.providers.find((p) => p.id === id)?.name ?? short(id);
  const columns: Column<Row>[] = [
    { key: 'type', label: t('col.type'), sortKey: 'type', render: (r) => r.type.replace(/_/g, ' ') },
    { key: 'subject', label: t('col.subject'), mono: true, render: (r) => r.transaction_reference ? <Link to={`/transactions/${r.transaction_reference}`}>{r.transaction_reference}</Link> : r.subject_reference },
    { key: 'account', label: t('col.provider_account'), render: (r) => account(r.provider_account_id) },
    { key: 'difference', label: t('col.difference'), align: 'end', render: (r) => r.difference != null ? <Amount minor={r.difference} currency={r.currency_code ?? ''} /> : <span className="muted">—</span> },
    { key: 'status', label: t('col.status'), render: (r) => <><Pill value={r.status} />{r.recurrences > 0 && <> <Tag family="refused">{t('l.recurred_n', { n: r.recurrences })}</Tag></>}</> },
    { key: 'assignee', label: t('col.assignee'), render: (r) => r.assignee_name ?? <span className="muted">—</span> },
    { key: 'detected', label: t('col.detected'), sortKey: 'detected', render: (r) => <When value={r.first_detected_at} /> },
  ];
  const filters: Filter<Row>[] = [
    ...chip<Row>('type', t('col.type'), TYPES),
    ...chip<Row>('status', t('col.status'), ['open', 'under_review', 'resolved']),
    ...chip<Row>('assignee', t('col.assignee'), me ? [{ value: me, label: t('l.me') }] : []),
    ...chip<Row>('provider_account', t('col.provider_account'), ref.providers.map((p) => ({ value: p.id, label: p.name }))),
    ...chip<Row>('recurred', t('l.recurred'), [{ value: 'true', label: t('l.recurred_after') }]),
  ];
  const actions: RowAction<Row>[] = [
    { label: t('table.open'), primary: true, to: (r) => `/reconciliation/discrepancies/${r.id}` },
    // The same endpoint as the detail page's Take.
    { label: t('l.assign_me'), when: (r) => has('reconciliation.decide') && r.status !== 'resolved' && r.assignee_id !== me, run: async (r) => { await post(`/reconciliation/discrepancies/${r.id}/assign`, { assignee_id: me }); reload(); } },
  ];
  const summary = (r: Row) => (
    <SummaryGrid items={[
      { label: t('l.expected'), value: <code className="small">{JSON.stringify(r.expected)}</code> },
      { label: t('l.observed'), value: <code className="small">{JSON.stringify(r.observed)}</code> },
      { label: t('l.runs_seen'), value: r.runs_seen },
      { label: t('l.last_detected'), value: <When value={r.last_detected_at} /> },
      ...(r.decision ? [{ label: t('l.decision'), value: r.decision }] : []),
    ]} />
  );
  return { columns, filters, actions, summary, rowKey: (r) => r.id, defaultSort: 'detected', defaultOrder: 'desc', empty: { none: t('l.disc_none'), why: t('l.disc_why') } };
}

export function runList({ t, ref }: { t: Tr; ref: Reference }): Pick<DataTableProps<Row>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'defaultOrder' | 'empty'> {
  const columns: Column<Row>[] = [
    { key: 'account', label: t('col.provider_account'), render: (r) => r.provider_account_name },
    { key: 'period', label: t('col.period'), render: (r) => <><When value={r.period_start} /> → <When value={r.period_end} /></> },
    { key: 'status', label: t('col.status'), render: (r) => <Pill value={r.status} /> },
    { key: 'raised', label: t('col.discrepancies'), align: 'end', render: (r) => r.discrepancies_raised },
    { key: 'started', label: t('col.started'), sortKey: 'started', render: (r) => <When value={r.started_at} /> },
  ];
  const filters: Filter<Row>[] = [
    ...chip<Row>('provider_account', t('col.provider_account'), ref.providers.map((p) => ({ value: p.id, label: p.name }))),
    ...chip<Row>('status', t('col.status'), ['running', 'completed', 'failed']),
    periodFilter<Row>(t),
  ];
  const actions: RowAction<Row>[] = [{ label: t('table.open'), primary: true, to: (r) => `/reconciliation/runs/${r.id}` }];
  const summary = (r: Row) => (
    <SummaryGrid items={[
      { label: t('l.finished'), value: r.finished_at ? <When value={r.finished_at} /> : <span className="muted">—</span> },
      { label: t('l.compared'), value: r.records_compared },
      { label: t('l.by_type'), value: Object.keys(r.summary ?? {}).length ? Object.entries(r.summary).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ') : '—' },
      { label: t('l.started_by'), value: r.started_by ? t('l.administrator') : t('l.schedule') },
      { label: t('l.mode'), value: r.mode },
      ...(r.error ? [{ label: t('l.error'), value: <span className="error">{r.error}</span> }] : []),
    ]} />
  );
  return { columns, filters, actions, summary, rowKey: (r) => r.id, defaultSort: 'started', defaultOrder: 'desc', empty: { none: t('l.run_none'), why: t('l.run_why') } };
}

const TABS = ['discrepancies', 'runs', 'upload', 'adjustment'] as const;

/** Reconciliation (console spec 9.1–9.3): runs, statement upload with what was read, the discrepancy queue with recurrence shown prominently, and free-standing adjustments. */
export function ReconciliationPage() {
  const { id: routeRun } = useParams();
  const [params] = useSearchParams();
  const t = useT();
  const { has, me } = useSession();
  // A run's page and `?run=` both narrow the queue to that run.
  const fixedRun = routeRun ?? params.get('run') ?? undefined;
  const [tab, setTab] = useTab(TABS, 'discrepancies');
  const ref = useReference();
  const [rev, reload] = useReload();
  const run = useLoad(() => (fixedRun ? get<{ run: Row }>(`/reconciliation/runs/${fixedRun}`) : Promise.resolve(null)), [fixedRun]);
  const providers = useLoad(() => get<any>('/configuration/providers').catch(() => ({ providers: [] })), []);
  const [upload, setUpload] = useState<{ provider_account_id: string; filename: string; content_base64: string; period_start: string; period_end: string }>({ provider_account_id: '', filename: '', content_base64: '', period_start: '', period_end: '' });
  const [uploaded, setUploaded] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const r = run.data?.run;
  return (
    <>
      <h1>{t('nav.reconciliation')}</h1>
      <div className="tabs">{TABS.map((k) => <a key={k} href="#" className={tab === k ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab(k); }}>{t(`l.tab_${k}`)}</a>)}</div>
      <ErrorLine error={run.error} />
      {r && <div className="warnbox">{t('l.run')} {short(r.id)} · {ref.providers.find((p) => p.id === r.provider_account_id)?.name ?? short(r.provider_account_id)} · {r.mode} · {r.records_compared} {t('l.compared').toLowerCase()}, {r.discrepancies_raised} {t('l.raised')} · <Pill value={r.status} /> <Link to="/reconciliation/discrepancies">{t('l.all_runs')}</Link>{r.error && <p className="error">{r.error}</p>}</div>}
      {tab === 'discrepancies' && (ref.ready
        ? <DataTable<Row> key={`${rev}:${fixedRun ?? ''}`} prefix="d_" {...discrepancyList({ t, has, me: me?.administrator.id, ref, reload })} search={false} fetch={fetchPage<Row>('/reconciliation/discrepancies', { extra: { run: fixedRun } })} />
        : <p className="muted">{t('common.loading')}</p>)}
      {tab === 'runs' && (ref.ready ? <DataTable<Row> prefix="r_" search={false} {...runList({ t, ref })} fetch={fetchPage<Row>('/reconciliation/runs', { period: 'after' })} /> : <p className="muted">{t('common.loading')}</p>)}
      {tab === 'upload' && (<div className="card" style={{ maxWidth: 700 }}>
        <h2>Upload a provider statement</h2>
        <p className="small muted">For providers exposing no listing, export the transactions from their console and upload the file; the platform reports what it read before the comparison runs.</p>
        {!has('reconciliation.upload') ? <NeedsPermission permission="reconciliation.upload" /> : (
          <form className="stack" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { setUploaded(await post('/reconciliation/statements', { ...upload, period_start: new Date(upload.period_start).toISOString(), period_end: new Date(upload.period_end).toISOString() })); } catch (x) { setErr((x as Error).message); } }}>
            <label>Provider account<select value={upload.provider_account_id} onChange={(e) => setUpload({ ...upload, provider_account_id: e.target.value })} required><option value="">—</option>{(providers.data?.providers ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name} ({p.statement_format ?? 'no format'})</option>)}</select></label>
            <label>File<input type="file" accept=".csv,text/csv" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => setUpload({ ...upload, filename: file.name, content_base64: btoa(String.fromCharCode(...new Uint8Array(reader.result as ArrayBuffer))) }); reader.readAsArrayBuffer(file); }} required /></label>
            <div className="row"><label>Period start<input type="datetime-local" value={upload.period_start} onChange={(e) => setUpload({ ...upload, period_start: e.target.value })} required /></label><label>Period end<input type="datetime-local" value={upload.period_end} onChange={(e) => setUpload({ ...upload, period_end: e.target.value })} required /></label></div>
            <ErrorLine error={err} />
            <button className="primary">Read the file</button>
          </form>
        )}
        {uploaded && <div className="warnbox">
          <p>Read <b>{uploaded.import.row_count}</b> rows; <b>{uploaded.rejected.length}</b> could not be parsed. Rows span {uploaded.observed_period.start ? <When value={uploaded.observed_period.start} /> : '—'} → {uploaded.observed_period.end ? <When value={uploaded.observed_period.end} /> : '—'}.{uploaded.period_disagrees && <span className="negative"> The rows fall outside the declared period.</span>}</p>
          {uploaded.rejected.length > 0 && <ul className="small">{uploaded.rejected.slice(0, 10).map((r: any) => <li key={r.rowNumber}>row {r.rowNumber}: {r.reason}</li>)}</ul>}
          {has('reconciliation.run') ? <button className="primary" onClick={async () => { await post<{ run_id: string }>(`/reconciliation/statements/${uploaded.import.id}/run`); setUploaded(null); setTab('runs'); }}>Run the comparison</button> : <NeedsPermission permission="reconciliation.run" />}
        </div>}
      </div>)}
      {tab === 'adjustment' && <AdjustmentForm />}
    </>
  );
}
