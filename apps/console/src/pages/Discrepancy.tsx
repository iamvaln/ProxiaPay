import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useSession } from '../lib/session';
import { Amount, ConfirmedAction, ErrorLine, NeedsPermission, Pill, When, useLoad } from '../components/common';

/** Discrepancy detail (console spec 9.4): ours, theirs, the difference, comments, and a decision whose consequence is shown before committing. */
export function DiscrepancyPage() {
  const { id } = useParams();
  const { has, me } = useSession();
  const { data, error, reload } = useLoad(() => get<any>(`/reconciliation/discrepancies/${id}`), [id]);
  const [comment, setComment] = useState('');
  const [decision, setDecision] = useState<'accepted' | 'rejected'>('accepted');
  const [follow, setFollow] = useState<'none' | 'correct_transaction' | 'post_adjustment'>('none');
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  const d = data;
  const cur = d.currency_code ?? '';
  const values = { decision, comment, follow };
  return (
    <>
      <h1>{d.type.replace(/_/g, ' ')} <Pill value={d.status} /> {d.recurrences_after_resolution > 0 && <span className="pill critical">recurred ×{d.recurrences_after_resolution} after resolution</span>}</h1>
      <div className="grid2">
        <div className="card">
          <dl className="kv">
            <dt>Subject</dt><dd>{d.transaction ? <Link to={`/transactions/${d.transaction.reference}`}>{d.transaction.reference}</Link> : d.subject_reference} <span className="small muted">({d.subject_type})</span></dd>
            <dt>What the platform holds</dt><dd><pre>{JSON.stringify(d.expected, null, 2)}</pre></dd>
            <dt>What the provider reported</dt><dd><pre>{JSON.stringify(d.observed, null, 2)}</pre></dd>
            <dt>Difference</dt><dd>{d.difference != null ? <Amount minor={d.difference} currency={cur} /> : '—'}</dd>
            <dt>First / last detected</dt><dd><When value={d.first_detected_at} /> / <When value={d.last_detected_at} /> · seen in {d.runs_seen} runs</dd>
            <dt>Run</dt><dd><Link to={`/reconciliation/runs/${d.run_id}`}>{d.run_id.slice(0, 8)}</Link></dd>
            {d.transaction && <><dt>Transaction</dt><dd><Pill value={d.transaction.state} /> {d.transaction.failure_reason ?? ''} · <Amount minor={d.transaction.requested_amount} currency={d.transaction.currency_code} /> · reconciliation <Pill value={d.transaction.reconciliation_status} /></dd></>}
            {d.decision && <><dt>Decision</dt><dd>{d.decision} · {d.adjustment_posted ? 'adjustment or correction posted' : 'records left untouched'} · <When value={d.decided_at} /></dd></>}
          </dl>
          {has('reconciliation.decide') && d.status !== 'resolved' && <button onClick={async () => { await post(`/reconciliation/discrepancies/${id}/assign`, { assignee_id: d.assignee_id === me?.administrator.id ? null : me?.administrator.id }); reload(); }}>{d.assignee_id === me?.administrator.id ? 'Release' : 'Take'}</button>}
        </div>
        <div className="card">
          <h2>Comments</h2>
          {d.comments.length === 0 ? <p className="muted">No comment yet.</p> : <ul>{d.comments.map((c: any) => <li key={c.id}><b>{c.author}</b> <span className="small muted"><When value={c.created_at} /></span><br />{c.body}</li>)}</ul>}
          <form className="row" onSubmit={async (e) => { e.preventDefault(); await post(`/reconciliation/discrepancies/${id}/comments`, { body: comment }); setComment(''); reload(); }}><input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment" style={{ width: 360 }} required /><button>Add</button></form>
        </div>
      </div>
      {d.status !== 'resolved' && (
        <div className="card">
          <h2>Decision</h2>
          {!has('reconciliation.decide') ? <NeedsPermission permission="reconciliation.decide" /> : (
            <div className="stack" style={{ display: 'grid', gap: 8, maxWidth: 800 }}>
              <div className="row">
                <label><input type="radio" checked={decision === 'accepted'} onChange={() => setDecision('accepted')} /> Accept: the provider's record is correct</label>
                <label><input type="radio" checked={decision === 'rejected'} onChange={() => { setDecision('rejected'); setFollow('none'); }} /> Reject: ours is, no action needed</label>
              </div>
              {decision === 'accepted' && <div className="row">
                <label><input type="radio" checked={follow === 'none'} onChange={() => setFollow('none')} /> Leave records untouched</label>
                {d.transaction && <label><input type="radio" checked={follow === 'correct_transaction'} onChange={() => setFollow('correct_transaction')} /> Correct the transaction's outcome</label>}
                <label><input type="radio" checked={follow === 'post_adjustment'} onChange={() => setFollow('post_adjustment')} /> Post an adjustment</label>
              </div>}
              <input placeholder="Comment (required)" value={comment} onChange={(e) => setComment(e.target.value)} />
              {follow !== 'none' && <button onClick={async () => { setErr(null); try { setPreview(await get(`/reconciliation/discrepancies/${id}/preview?follow=${follow}`)); } catch (e) { setErr((e as Error).message); } }}>Show what this will write</button>}
              {preview && <div className="warnbox">
                {preview.correction && <p>Transaction <b>{preview.correction.transaction}</b>: <Pill value={preview.correction.from.state} /> {preview.correction.from.failure_reason ?? ''} → <Pill value={preview.correction.to.state} />. The project receives <code>{preview.correction.notification}</code> carrying the prior outcome.</p>}
                {preview.suggested_postings && <table><tbody>{preview.suggested_postings.map((p: any, i: number) => <tr key={i}><td className="small">{p.accountId.slice(0, 8)}</td><td>{p.side}</td><td className="num"><Amount minor={p.amount} currency={cur} /></td></tr>)}</tbody></table>}
                {preview.requires_approval && <p className="small">Above the threshold: this moves to a second administrator's approval queue rather than committing.</p>}
              </div>}
              <ErrorLine error={err} />
              {follow === 'none' ? <button className="primary" disabled={!comment.trim()} onClick={async () => { setErr(null); try { await post(`/reconciliation/discrepancies/${id}/decision`, values); reload(); } catch (e) { setErr((e as Error).message); } }}>Record decision</button>
                : <ConfirmedAction operationType="discrepancy.decide" values={{ id, ...values }} path={`/reconciliation/discrepancies/${id}/decision`} label="Record decision" disabled={!comment.trim()} onDone={reload} />}
            </div>
          )}
        </div>
      )}
    </>
  );
}
