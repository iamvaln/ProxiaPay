import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useSession } from '../lib/session';
import { Amount, Empty, ErrorLine, NeedsPermission, Pill, ScopeNote, When, useLoad } from '../components/common';

/** Reconciliation (console spec 9.1–9.3): runs, statement upload with what was read, and the discrepancy queue with recurrence shown prominently. */
export function ReconciliationPage() {
  const { id: runId } = useParams();
  const { has } = useSession();
  const [tab, setTab] = useState<'discrepancies' | 'runs' | 'upload'>(runId ? 'runs' : 'discrepancies');
  const [f, setF] = useState<Record<string, string>>(runId ? { run: runId } : {});
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const disc = useLoad(() => get<any>(`/reconciliation/discrepancies?${qs}`), [qs, tab]);
  const runs = useLoad(() => get<any>('/reconciliation/runs'), [tab]);
  const providers = useLoad(() => get<any>('/configuration/providers').catch(() => ({ providers: [] })), []);
  const [upload, setUpload] = useState<{ provider_account_id: string; filename: string; content_base64: string; period_start: string; period_end: string }>({ provider_account_id: '', filename: '', content_base64: '', period_start: '', period_end: '' });
  const [uploaded, setUploaded] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = runId && runs.data ? runs.data.runs.find((r: any) => r.id === runId) : null;
  return (
    <>
      <h1>Reconciliation</h1>
      <div className="tabs">{(['discrepancies', 'runs', 'upload'] as const).map((k) => <a key={k} href="#" className={tab === k ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab(k); }}>{k}</a>)}</div>
      {tab === 'discrepancies' && (<>
        <div className="filters">
          <select value={f.type ?? ''} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">Type</option>{['float_drift', 'fee_variance', 'orphan_transaction', 'missing_transaction', 'state_divergence', 'stale_undetermined', 'unconfirmed_transfer', 'checkpoint_mismatch'].map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select>
          <select value={f.status ?? ''} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Status</option><option value="open">open</option><option value="under_review">under review</option><option value="resolved">resolved</option></select>
          <label className="row"><input type="checkbox" checked={f.recurred === 'true'} onChange={(e) => setF({ ...f, recurred: e.target.checked ? 'true' : '' })} /> recurred after resolution</label>
          {f.run && <span className="pill primary">run {f.run.slice(0, 8)} <a href="#" onClick={(e) => { e.preventDefault(); setF({ ...f, run: '' }); }}>×</a></span>}
        </div>
        <ErrorLine error={disc.error} />
        {disc.data && <ScopeNote scoped={disc.data.scoped} />}
        {disc.data && (disc.data.discrepancies.length === 0 ? <Empty text="No discrepancy. Discrepancies are raised by a reconciliation run, weekly or from an uploaded statement." /> : (
          <table><thead><tr><th>Type</th><th>Subject</th><th>Expected</th><th>Observed</th><th className="num">Difference</th><th>Status</th><th>First detected</th><th className="num">Runs seen</th><th>Assignee</th></tr></thead>
            <tbody>{disc.data.discrepancies.map((d: any) => <tr key={d.id}>
              <td><Link to={`/reconciliation/discrepancies/${d.id}`}>{d.type.replace(/_/g, ' ')}</Link>{d.recurrences_after_resolution > 0 && <><br /><span className="pill critical">recurred ×{d.recurrences_after_resolution}</span></>}</td>
              <td>{d.transaction_reference ? <Link to={`/transactions/${d.transaction_reference}`}>{d.transaction_reference}</Link> : d.subject_reference}</td>
              <td className="small">{JSON.stringify(d.expected)}</td><td className="small">{JSON.stringify(d.observed)}</td>
              <td className="num">{d.difference != null ? <Amount minor={d.difference} currency={d.currency_code ?? ''} /> : '—'}</td>
              <td><Pill value={d.status} />{d.decision && <><br /><span className="small">{d.decision}</span></>}</td><td><When value={d.first_detected_at} /></td><td className="num">{d.runs_seen}</td><td>{d.assignee_name ?? '—'}</td>
            </tr>)}</tbody></table>
        ))}
      </>)}
      {tab === 'runs' && (<>
        <ErrorLine error={runs.error} />
        {run && <div className="warnbox">Run {run.id.slice(0, 8)} · {run.provider_account_name} · {run.mode} · {run.records_compared} compared, {run.discrepancies_raised} raised · <Pill value={run.status} /> <Link to={`/reconciliation/discrepancies?run=${run.id}`} onClick={() => { setF({ run: run.id }); setTab('discrepancies'); }}>see discrepancies</Link>{run.error && <p className="error">{run.error}</p>}</div>}
        {runs.data && (runs.data.runs.length === 0 ? <Empty text="No run yet. Runs execute weekly per provider account with a listing, or from an uploaded statement." /> : (
          <table><thead><tr><th>Started</th><th>Provider account</th><th>Mode</th><th>Period</th><th className="num">Compared</th><th className="num">Raised</th><th>Status</th><th>By</th></tr></thead>
            <tbody>{runs.data.runs.map((r: any) => <tr key={r.id}><td><Link to={`/reconciliation/runs/${r.id}`} onClick={() => setF({ run: r.id })}><When value={r.started_at} /></Link></td><td>{r.provider_account_name}</td><td>{r.mode}</td><td className="small"><When value={r.period_start} /> → <When value={r.period_end} /></td><td className="num">{r.records_compared}</td><td className="num">{r.discrepancies_raised}</td><td><Pill value={r.status} /></td><td className="small muted">{r.started_by ? 'administrator' : 'schedule'}</td></tr>)}</tbody></table>
        ))}
      </>)}
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
          {has('reconciliation.run') ? <button className="primary" onClick={async () => { const r = await post<{ run_id: string }>(`/reconciliation/statements/${uploaded.import.id}/run`); setUploaded(null); setF({ run: r.run_id }); setTab('runs'); }}>Run the comparison</button> : <NeedsPermission permission="reconciliation.run" />}
        </div>}
      </div>)}
    </>
  );
}
