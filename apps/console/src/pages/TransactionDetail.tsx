import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, Empty, ErrorLine, NeedsPermission, Pill, When, useLoad } from '../components/common';

/** Transaction detail (console spec 5.2): everything about one payment without navigation. A browser address is absent entirely. */
export function TransactionDetailPage() {
  const { reference } = useParams();
  const t = useT();
  const { has } = useSession();
  const { data, error, reload } = useLoad(() => get<any>(`/transactions/${reference}`), [reference]);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [exchanges, setExchanges] = useState<any[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  const x = data.transaction, a = data.amounts, cur = a.currency;
  return (
    <>
      <h1>{x.reference} <Pill value={x.state} /> <Pill value={x.reconciliation_status} /></h1>
      <div className="grid2">
        <div className="card">
          <dl className="kv">
            <dt>Project</dt><dd><Link to={`/projects/${data.project.id}`}>{data.project.name}</Link> · {x.project_reference}</dd>
            <dt>Direction</dt><dd>{x.direction}</dd>
            <dt>Route</dt><dd>{x.route.country} · {x.route.payment_method} · {cur}</dd>
            <dt>Counterparty experiences</dt><dd><Amount minor={x.direction === 'collection' ? a.charged : a.settled ?? a.expected_settled} currency={cur} /></dd>
            <dt>Provider reference</dt><dd>{x.provider_reference ?? '—'}</dd>
            <dt>Operator reference</dt><dd>{x.operator_reference ?? '—'}</dd>
            <dt>Failure reason</dt><dd>{x.failure_reason ?? '—'}</dd>
            {data.refund_of && <><dt>Refund of</dt><dd><Link to={`/transactions/${data.refund_of}`}>{data.refund_of}</Link></dd></>}
            <dt>Created</dt><dd><When value={x.created_at} /></dd>
            <dt>Terminal</dt><dd><When value={x.terminal_at} /></dd>
            <dt>Correlation</dt><dd className="small muted">{data.correlation_id}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Amounts</h2>
          <dl className="kv">
            <dt>Requested</dt><dd><Amount minor={a.requested} currency={cur} /></dd>
            <dt>Charged</dt><dd><Amount minor={a.charged} currency={cur} /></dd>
            <dt>Settled</dt><dd><Amount minor={a.settled} currency={cur} /> {a.settled == null && <span className="small muted">(expected <Amount minor={a.expected_settled} currency={cur} />)</span>}</dd>
            <dt>Processing fee</dt><dd><Amount minor={a.processing_fee} currency={cur} /> · borne by {a.processing_fee_bearer}</dd>
            <dt>Platform fee</dt><dd><Amount minor={a.platform_fee} currency={cur} /> · borne by {a.platform_fee_bearer}</dd>
            <dt>Expected provider fee</dt><dd><Amount minor={a.expected_provider_fee} currency={cur} /></dd>
            <dt>Actual provider fee</dt><dd><Amount minor={a.actual_provider_fee} currency={cur} /> {a.provider_fee_differs && <span className="pill warning">differs {data.discrepancies.length ? <Link to={`/reconciliation/discrepancies/${data.discrepancies[0].id}`}>discrepancy</Link> : null}</span>}</dd>
            <dt>Margin</dt><dd><Amount minor={a.margin} currency={cur} /> <span className="small muted">processing fee less actual provider fee</span></dd>
            {a.reserved_amount > 0 && <><dt>Reserved</dt><dd><Amount minor={a.reserved_amount} currency={cur} /></dd></>}
          </dl>
        </div>
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Timeline</h2>
          <ul className="timeline">{data.timeline.map((e: any) => <li key={e.id}><When value={e.occurred_at} /> · {e.prior_state ? `${e.prior_state} → ` : ''}<b>{e.new_state.replace(/_/g, ' ')}</b> <span className="muted small">via {e.source}{e.actor ? ` (${e.actor})` : ''}</span>{e.detail?.code_attempt && <span className="small"> · code attempt {e.detail.code_attempt}{e.detail.attempts_remaining != null ? `, ${e.detail.attempts_remaining} left` : ''}</span>}{e.detail?.failure_reason && <span className="small"> · {e.detail.failure_reason}</span>}</li>)}</ul>
        </div>
        <div className="card">
          <h2>Attempts</h2>
          {data.attempts.length === 0 ? <Empty text="No provider attempt yet." /> : (
            <table><thead><tr><th>#</th><th>Provider account</th><th>Reference</th><th>Terms</th><th>Outcome</th><th className="num">Duration</th></tr></thead>
              <tbody>{data.attempts.map((at: any) => <tr key={at.id}><td>{at.sequence}{at.fees_recorded && <span className="pill primary" title="Fees recorded from this attempt">fees</span>}</td><td>{at.provider_account}</td><td>{at.provider_reference ?? '—'}<br /><span className="small muted">{at.operator_reference}</span></td><td className="small">{at.terms.expected_fee_bps / 100}% {at.terms.terms_status}</td><td><Pill value={at.state} />{at.failure_reason && <><br /><span className="small">{at.failure_reason}{at.provider_error_code ? ` (${at.provider_error_code})` : ''}</span></>}</td><td className="num">{at.duration_ms != null ? `${at.duration_ms} ms` : '—'}</td></tr>)}</tbody></table>
          )}
        </div>
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Configuration in force</h2>
          <dl className="kv">
            <dt>Route version</dt><dd><Link to={`/configuration/routes/${data.configuration.route_version.route_id}`}>#{data.configuration.route_version.sequence}</Link> · valid from <When value={data.configuration.route_version.valid_from} /></dd>
            <dt>Entitlement version</dt><dd>#{data.configuration.entitlement_version.sequence}</dd>
            <dt>Terms applied</dt><dd className="small">processing {data.configuration.terms_snapshot.processing_fee_bps / 100}% ({data.configuration.terms_snapshot.sources?.processing_fee_bps}), platform {data.configuration.terms_snapshot.platform_fee_bps / 100}% ({data.configuration.terms_snapshot.sources?.platform_fee_bps}), provider {data.configuration.terms_snapshot.provider_fee_bps != null ? `${data.configuration.terms_snapshot.provider_fee_bps / 100}% ${data.configuration.terms_snapshot.provider_terms_status}` : '—'}</dd>
            <dt>Limits checked</dt><dd className="small">{data.configuration.limits_snapshot.minimum}–{data.configuration.limits_snapshot.maximum} · {data.configuration.limits_snapshot.count24h}/24h · {data.configuration.limits_snapshot.count30d}/30d</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Payer</h2>
          <p>{revealed ?? data.payer.masked} {data.payer.name && <span className="muted">· {data.payer.name}</span>}</p>
          {data.payer.can_reveal ? (!revealed && <button onClick={async () => { const r = await get<{ msisdn: string }>(`/transactions/${reference}/reveal-identifier`).catch(() => null); if (!r) { const p = await post<{ msisdn: string }>(`/transactions/${reference}/reveal-identifier`); setRevealed(p.msisdn); } else setRevealed(r.msisdn); }}>{t('txn.reveal')}</button>) : <NeedsPermission permission="transactions.read_identifiers" />}
          <p className="small muted">Revealing is recorded against you.</p>
          <h2>Actions</h2>
          <div className="row">
            {has('transactions.recheck') ? <button onClick={async () => { await post(`/transactions/${reference}/recheck`); setNote('Re-check queued.'); }}>{t('txn.recheck')}</button> : <NeedsPermission permission="transactions.recheck" />}
            {has('transactions.refund') ? <button disabled={!(x.direction === 'collection' && x.state === 'succeeded')} title="Refunds are initiated as a disbursement referencing this collection">Initiate refund</button> : <NeedsPermission permission="transactions.refund" />}
          </div>
          {note && <p className="ok small">{note}</p>}
        </div>
      </div>
      <div className="card">
        <h2>Ledger entries</h2>
        {data.ledger_entries.length === 0 ? <Empty text="No ledger movement; money moves only on a conclusive outcome." /> : data.ledger_entries.map((e: any) => (
          <div key={e.id} style={{ marginBottom: 8 }}>
            <b>{e.entry_type.replace(/_/g, ' ')}</b> <span className="small muted"><When value={e.occurred_at} /></span>
            <table><tbody>{e.postings.map((p: any) => <tr key={p.account_id + p.side}><td>{p.account_type.replace(/_/g, ' ')}</td><td>{p.side}</td><td className="num"><Amount minor={p.amount} currency={p.currency_code} /></td></tr>)}</tbody></table>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Notifications to the project</h2>
        {data.notifications.length === 0 ? <Empty text="No notification was raised; the project has no endpoint, or nothing terminal happened yet." /> : (
          <table><thead><tr><th>Event</th><th>Status</th><th className="num">Attempts</th><th>Last response</th><th /></tr></thead>
            <tbody>{data.notifications.map((n: any) => <tr key={n.id}><td>{n.event_type}<br /><span className="small muted">{n.event_id}</span></td><td><Pill value={n.status} /></td><td className="num">{n.attempt}</td><td className="small">{n.attempts.at(-1) ? `${n.attempts.at(-1).response_status ?? n.attempts.at(-1).error}` : '—'}</td><td>{has('transactions.replay_notification') && <button onClick={async () => { await post(`/transactions/${reference}/notifications/${n.id}/replay`); reload(); }}>{t('txn.replay')}</button>}</td></tr>)}</tbody></table>
        )}
      </div>
      <div className="card">
        <h2>Provider exchanges</h2>
        {data.exchanges_available ? (exchanges ? <pre>{JSON.stringify(exchanges, null, 2)}</pre> : <button onClick={async () => setExchanges((await get<{ exchanges: any[] }>(`/transactions/${reference}/exchanges`)).exchanges)}>Load raw exchanges (recorded)</button>) : <NeedsPermission permission="transactions.read_exchanges" />}
      </div>
    </>
  );
}
