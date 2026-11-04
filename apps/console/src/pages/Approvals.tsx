import { useState } from 'react';
import { get, post } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, ConfirmedAction, ErrorLine, useLoad } from '../components/common';
import { DataTable, type Column, type DataTableProps } from '../components/table/DataTable';
import { age } from '../lib/format';
import { chipBy, distinct } from './list-support';

type Row = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;

/** What the initiator saw and the decision: approve behind its code, or decline with a reason. Unchanged from the row expansion it replaces. */
export function DecisionPanel({ r, reload }: { r: Row; reload: () => void }) {
  const t = useT();
  const { me } = useSession();
  const [reason, setReason] = useState('');
  const [declineError, setDeclineError] = useState<string | null>(null);
  return (
    <div className="grid2">
      <div><h3>{t('l.initiator_saw')}</h3><pre>{JSON.stringify(r.subject, null, 2)}</pre></div>
      <div>
        <h3>{t('l.justification')}</h3><p>{r.justification || <span className="muted">—</span>}</p>
        {r.own ? <p className="muted small">{t('l.approve_own_refused')}</p> : !r.can_act ? <p className="muted small">{t('l.approve_lacks_permission')}</p> : (
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <ConfirmedAction operationType="approval.approve" values={{ id: r.id, decision: 'approve', reason: '' }} path={`/approvals/${r.id}/decision`} label={t('common.approve')} onDone={reload} />
            <div>
              <input placeholder={t('l.decline_reason')} value={reason} onChange={(e) => setReason(e.target.value)} />{' '}
              <button className="danger" disabled={!reason.trim()} onClick={async () => { setDeclineError(null); try { await post(`/approvals/${r.id}/decision`, { decision: 'decline', reason }); reload(); } catch (e) { setDeclineError((e as Error).message); } }}>{t('common.decline')}</button>
              <ErrorLine error={declineError} />
            </div>
          </div>
        )}
        <p className="small muted">{t('l.signed_in_as', { name: me?.administrator.name ?? '' })}</p>
      </div>
    </div>
  );
}

/** The approval queue, the longest wait first. Approuver and Refuser both unfold the decision panel; the decision is made there. */
export function approvalList({ t, rows, reload }: { t: Tr; rows: Row[]; reload: () => void }): Pick<DataTableProps<Row>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'defaultOrder' | 'empty'> {
  const columns: Column<Row>[] = [
    { key: 'request', label: t('col.request'), text: (r) => `${r.summary} ${r.type}`, sortValue: (r) => r.summary, render: (r) => <>{r.summary}<br /><span className="small muted">{r.type}</span></> },
    { key: 'amount', label: t('col.amount'), align: 'end', sortValue: (r) => r.amount ?? -1, render: (r) => (r.amount != null ? <Amount minor={r.amount} currency={r.currency_code} /> : '—') },
    { key: 'by', label: t('col.requested_by'), text: (r) => r.initiator_name, render: (r) => <>{r.initiator_name}{r.own && <span className="small muted"> · {t('common.own_request')}</span>}</> },
    { key: 'waiting', label: t('col.waiting'), align: 'end', sortValue: (r) => Date.now() - Date.parse(r.created_at), render: (r) => <span title={r.created_at}>{age(r.created_at)}</span> },
  ];
  const decide = (r: Row) => !r.own && !!r.can_act;
  return {
    columns, rowKey: (r) => r.id, defaultSort: 'waiting', defaultOrder: 'desc',
    filters: chipBy<Row>('type', t('col.type'), distinct(rows, (r) => r.type), (r) => r.type),
    actions: [
      { label: t('common.approve'), opens: true, when: decide },
      { label: t('common.decline'), opens: true, when: decide },
    ],
    summary: (r) => <DecisionPanel r={r} reload={reload} />,
    empty: { none: t('l.approval_none'), why: t('l.approval_why') },
  };
}

/** The approval queue (console spec 4.3, 11.2): what the initiator saw, their justification, and the two actions. */
export function ApprovalsPage() {
  const t = useT();
  const { data, error, reload } = useLoad(() => get<{ requests: any[] }>('/approvals'));
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  return (
    <>
      <h1>{t('home.approvals')}</h1>
      <DataTable<Row> rows={data.requests} {...approvalList({ t, rows: data.requests, reload })} />
    </>
  );
}
