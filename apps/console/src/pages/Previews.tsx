import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { Amount, Empty, ErrorLine, Pill, ScopeNote, When, useLoad } from '../components/common';

/** Previews (console spec 5.3): the unconfirmed ones are the value of this screen. */
export function PreviewsPage() {
  const [params] = useSearchParams();
  const qs = params.toString();
  const { data, error } = useLoad(() => get<any>(`/previews?${qs}`), [qs]);
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  return (
    <>
      <h1>Previews</h1>
      <ScopeNote scoped={data.scoped} />
      {data.repeat_unconfirmed.length > 0 && <div className="warnbox">Payers previewing repeatedly without completing in the last 24 hours: {data.repeat_unconfirmed.map((r: any) => <span key={r.msisdn_masked}><Link to={`/transactions/previews?msisdn=${encodeURIComponent(r.msisdn_masked)}`}>{r.msisdn_masked}</Link> ({r.n}) </span>)}</div>}
      {data.data.length === 0 ? <Empty text="No previews yet. A preview appears the moment a project asks what a payment will cost." /> : (
        <table><thead><tr><th>Reference</th><th>Project</th><th>Route</th><th className="num">Amount</th><th>Payer</th><th>Action</th><th>Status</th><th>Transaction</th><th>Created</th></tr></thead>
          <tbody>{data.data.map((p: any) => <tr key={p.id}><td>{p.reference}<br /><span className="small muted">{p.project_reference}</span></td><td>{p.project_name}</td><td>{p.country_code} · {p.payment_method_code} · {p.direction}</td><td className="num"><Amount minor={p.requested_amount} currency={p.currency_code} /></td><td>{p.msisdn_masked}</td><td>{p.payer_action}</td><td><Pill value={p.status} /></td><td>{p.transaction_reference ? <Link to={`/transactions/${p.transaction_reference}`}>{p.transaction_reference}</Link> : '—'}</td><td><When value={p.created_at} /></td></tr>)}</tbody></table>
      )}
    </>
  );
}
