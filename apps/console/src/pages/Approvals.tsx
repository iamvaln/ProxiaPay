import { useState } from 'react';
import { get, post } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, ConfirmedAction, Empty, ErrorLine, When, useLoad } from '../components/common';
import { age } from '../lib/format';

/** The approval queue (console spec 4.3, 11.2): what the initiator saw, their justification, and the two actions. */
export function ApprovalsPage() {
  const t = useT();
  const { me } = useSession();
  const { data, error, reload } = useLoad(() => get<{ requests: any[] }>('/approvals'));
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [declineError, setDeclineError] = useState<string | null>(null);
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  return (
    <>
      <h1>{t('home.approvals')}</h1>
      {data.requests.length === 0 && <Empty />}
      {data.requests.length > 0 && (
        <table>
          <thead><tr><th>Request</th><th className="num">Amount</th><th>Initiated by</th><th>Raised</th><th className="num">Waiting</th><th /></tr></thead>
          <tbody>{data.requests.map((r) => (
            <>
              <tr key={r.id}>
                <td>{r.summary}<br /><span className="small muted">{r.type}</span></td>
                <td className="num">{r.amount != null ? <Amount minor={r.amount} currency={r.currency_code} /> : '—'}</td>
                <td>{r.initiator_name}{r.own && <span className="small muted"> · {t('common.own_request')}</span>}</td>
                <td><When value={r.created_at} /></td>
                <td className="num">{age(r.created_at)}</td>
                <td><button onClick={() => setOpen(open === r.id ? null : r.id)}>Open</button></td>
              </tr>
              {open === r.id && (
                <tr key={`${r.id}-detail`}><td colSpan={6}>
                  <div className="grid2">
                    <div><h3>What the initiator saw</h3><pre>{JSON.stringify(r.subject, null, 2)}</pre></div>
                    <div>
                      <h3>Justification</h3><p>{r.justification || <span className="muted">—</span>}</p>
                      {r.own ? <p className="muted small">The platform refuses an approval from the administrator who initiated the request.</p> : !r.can_act ? <p className="muted small">You lack the permission to approve this type of request.</p> : (
                        <div className="row" style={{ alignItems: 'flex-start' }}>
                          <ConfirmedAction operationType="approval.approve" values={{ id: r.id, decision: 'approve', reason: '' }} path={`/approvals/${r.id}/decision`} label={t('common.approve')} onDone={reload} />
                          <div>
                            <input placeholder="Reason for declining" value={reason} onChange={(e) => setReason(e.target.value)} />{' '}
                            <button className="danger" disabled={!reason.trim()} onClick={async () => { setDeclineError(null); try { await post(`/approvals/${r.id}/decision`, { decision: 'decline', reason }); reload(); } catch (e) { setDeclineError((e as Error).message); } }}>{t('common.decline')}</button>
                            <ErrorLine error={declineError} />
                          </div>
                        </div>
                      )}
                      <p className="small muted">Signed in as {me?.administrator.name}</p>
                    </div>
                  </div>
                </td></tr>
              )}
            </>
          ))}</tbody>
        </table>
      )}
    </>
  );
}
