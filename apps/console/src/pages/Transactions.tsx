import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, Empty, ErrorLine, Pill, ScopeNote, When, useLoad } from '../components/common';

const STATES = ['created', 'action_required', 'submitted', 'processing', 'succeeded', 'failed', 'expired', 'undetermined'];

/** Transaction search (console spec 5.1). */
export function TransactionsPage() {
  const t = useT();
  const { has } = useSession();
  const [f, setF] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState<string | undefined>();
  const qs = new URLSearchParams(Object.entries({ ...f, ...(cursor ? { cursor } : {}) }).filter(([, v]) => v)).toString();
  const { data, error } = useLoad(() => get<{ data: any[]; next_cursor: string | null; scoped: boolean }>(`/transactions?${qs}`), [qs]);
  const set = (k: string, v: string) => { setCursor(undefined); setF({ ...f, [k]: v }); };
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{t('nav.transactions')}</h1>
        <div className="row"><Link to="/transactions/previews">{t('txn.previews')}</Link>{has('oversight.export') && <a href={`/console/transactions/export?${qs}`} onClick={async (e) => { e.preventDefault(); const r = await get<{ csv: string; export_id: string }>(`/transactions/export?${qs}`); const blob = new Blob([r.csv], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `transactions-${r.export_id}.csv`; a.click(); }}>{t('txn.export')}</a>}</div>
      </div>
      <div className="filters">
        <select value={f.state ?? ''} onChange={(e) => set('state', e.target.value)}><option value="">{t('txn.state')}</option>{STATES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select value={f.reconciliation_status ?? ''} onChange={(e) => set('reconciliation_status', e.target.value)}><option value="">{t('txn.recon')}</option>{['unreviewed', 'matched', 'disputed', 'examined', 'corrected'].map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <select value={f.direction ?? ''} onChange={(e) => set('direction', e.target.value)}><option value="">Direction</option><option value="collection">collection</option><option value="disbursement">disbursement</option></select>
        <input placeholder="Country" style={{ width: 80 }} value={f.country ?? ''} onChange={(e) => set('country', e.target.value.toUpperCase())} />
        <input placeholder="Method" style={{ width: 90 }} value={f.payment_method ?? ''} onChange={(e) => set('payment_method', e.target.value.toUpperCase())} />
        <input placeholder="Currency" style={{ width: 80 }} value={f.currency ?? ''} onChange={(e) => set('currency', e.target.value.toUpperCase())} />
        <input placeholder="Failure reason" value={f.failure_reason ?? ''} onChange={(e) => set('failure_reason', e.target.value.toUpperCase())} />
        <input type="datetime-local" value={f.created_after_local ?? ''} onChange={(e) => { setF({ ...f, created_after_local: e.target.value, created_after: e.target.value ? new Date(e.target.value).toISOString() : '' }); }} />
        <input type="datetime-local" value={f.created_before_local ?? ''} onChange={(e) => { setF({ ...f, created_before_local: e.target.value, created_before: e.target.value ? new Date(e.target.value).toISOString() : '' }); }} />
        <input placeholder="Min amount" type="number" style={{ width: 110 }} value={f.amount_min ?? ''} onChange={(e) => set('amount_min', e.target.value)} />
        <input placeholder="Max amount" type="number" style={{ width: 110 }} value={f.amount_max ?? ''} onChange={(e) => set('amount_max', e.target.value)} />
      </div>
      <ErrorLine error={error} />
      {data && <ScopeNote scoped={data.scoped} />}
      {data && (data.data.length === 0 ? <Empty text="No transaction matches these filters. Transactions appear here as projects confirm previews." /> : (
        <table>
          <thead><tr><th>{t('txn.reference')}</th><th>{t('txn.project')}</th><th>Direction</th><th>{t('txn.route')}</th><th className="num">{t('txn.amount')}</th><th>{t('txn.state')}</th><th>{t('txn.recon')}</th><th>{t('txn.created')}</th><th>{t('txn.terminal')}</th></tr></thead>
          <tbody>{data.data.map((r) => (
            <tr key={r.id}>
              <td><Link to={`/transactions/${r.reference}`}>{r.reference}</Link><br /><span className="small muted">{r.project_reference}</span></td>
              <td>{r.project_name}</td><td>{r.direction}</td><td>{r.country_code} · {r.payment_method_code}</td>
              <td className="num"><Amount minor={r.requested_amount} currency={r.currency_code} /></td>
              <td><Pill value={r.state} />{r.failure_reason && <><br /><span className="small muted">{r.failure_reason}</span></>}</td>
              <td><Pill value={r.reconciliation_status} /></td><td><When value={r.created_at} /></td><td><When value={r.terminal_at} /></td>
            </tr>
          ))}</tbody>
        </table>
      ))}
      {data?.next_cursor && <p><button onClick={() => setCursor(data.next_cursor!)}>Next page</button></p>}
    </>
  );
}
