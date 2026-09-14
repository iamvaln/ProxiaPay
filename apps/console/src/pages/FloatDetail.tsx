import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, put } from '../lib/api';
import { useSession } from '../lib/session';
import { Amount, ErrorLine, NeedsPermission, Pill, When, useLoad } from '../components/common';

export function FloatDetailPage() {
  const { id } = useParams();
  const { has } = useSession();
  const { data, error, reload } = useLoad(() => get<any>(`/treasury/float/${id}`), [id]);
  const [th, setTh] = useState<any>(null);
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  const a = data.account;
  return (
    <>
      <h1>{a.providerAccountName} · {a.countryCode} · {a.currency} · {a.direction} <Pill value={a.band} /></h1>
      <div className="grid2">
        <div className="card">
          <dl className="kv">
            <dt>Wallet balance</dt><dd><Amount minor={a.balance} currency={a.currency} /></dd>
            <dt>Open disbursements</dt><dd><Amount minor={a.openDisbursements} currency={a.currency} /></dd>
            <dt>Free liquidity</dt><dd><b><Amount minor={a.freeLiquidity} currency={a.currency} /></b></dd>
            <dt>Recent outflow</dt><dd><Amount minor={a.outflowPerHour} currency={a.currency} /> per hour (95th percentile of daily volume, last 7 days)</dd>
            <dt>Cover</dt><dd>{a.coverHours == null ? '—' : `${a.coverHours} h`} · target {a.targetHours} h · minimum {a.minimumHours} h {a.overrideAmount != null && <span className="pill warning">manual override <Amount minor={a.overrideAmount} currency={a.currency} /></span>}</dd>
            {a.proposedTransfer != null && <><dt>Proposed transfer</dt><dd><Amount minor={a.proposedTransfer} currency={a.currency} /> from the paired collection wallet {data.paired_collection && <>(free <Amount minor={data.paired_collection.freeLiquidity} currency={a.currency} />) → <Link to="/treasury">register</Link></>}</dd></>}
            {data.withdrawable && <><dt>Withdrawable</dt><dd><Amount minor={data.withdrawable.withdrawable} currency={a.currency} /> <span className="small muted">(solvency <Amount minor={data.withdrawable.solvency} currency={a.currency} />, liquidity <Amount minor={data.withdrawable.liquidity} currency={a.currency} />; {data.withdrawable.binding} binds)</span></dd></>}
          </dl>
          <h3>Cover periods</h3>
          {has('treasury.read_float') ? (th ? <form className="row" onSubmit={async (e) => { e.preventDefault(); await put(`/treasury/float/${id}/thresholds`, th); setTh(null); reload(); }}><label>target h<input type="number" value={th.target_hours} onChange={(e) => setTh({ ...th, target_hours: Number(e.target.value) })} /></label><label>minimum h<input type="number" value={th.minimum_hours} onChange={(e) => setTh({ ...th, minimum_hours: Number(e.target.value) })} /></label><label>override amount<input type="number" value={th.override_amount ?? ''} onChange={(e) => setTh({ ...th, override_amount: e.target.value === '' ? null : Number(e.target.value) })} /></label><button className="primary">Save</button><button type="button" onClick={() => setTh(null)}>Cancel</button></form> : <button onClick={() => setTh({ target_hours: a.targetHours, minimum_hours: a.minimumHours, override_amount: a.overrideAmount })}>Adjust cover periods</button>) : <NeedsPermission permission="treasury.read_float" />}
        </div>
        <div className="card">
          <h2>Entries</h2>
          <table><thead><tr><th>When</th><th>Type</th><th>Side</th><th className="num">Amount</th><th>Reference</th></tr></thead>
            <tbody>{data.entries.map((e: any) => <tr key={e.id}><td><When value={e.occurred_at} /></td><td>{e.entry_type.replace(/_/g, ' ')}</td><td>{e.side}</td><td className="num"><Amount minor={e.amount} currency={a.currency} /></td><td className="small">{e.transaction_id ? <Link to={`/transactions?q=${e.transaction_id}`}>transaction</Link> : e.reference ?? e.justification ?? '—'}</td></tr>)}</tbody></table>
        </div>
      </div>
    </>
  );
}
