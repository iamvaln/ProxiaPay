import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, put } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, ErrorLine, NeedsPermission, Pill, Tag, When, useLoad } from '../components/common';
import { DataTable, SummaryGrid, type Column, type DataTableProps, type RowAction } from '../components/table/DataTable';
import { chip, fetchPage, periodFilter } from './list-support';

type Entry = Record<string, any>;
const ENTRY_TYPES = ['collection', 'disbursement_reservation', 'disbursement_settlement', 'disbursement_release', 'disbursement_suspension', 'suspense_settlement', 'suspense_release', 'float_transfer', 'cashout', 'float_funding', 'project_funding', 'adjustment', 'reversal', 'refund'];

/** One account's ledger entries; a row opens the transaction itself, not a search for it. */
export function entryList({ t, currency }: { t: (k: string) => string; currency: string }): Pick<DataTableProps<Entry>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'defaultOrder' | 'empty'> {
  const columns: Column<Entry>[] = [
    { key: 'when', label: t('col.when'), sortKey: 'when', render: (e) => <When value={e.occurred_at} /> },
    { key: 'type', label: t('col.type'), render: (e) => e.entry_type.replace(/_/g, ' ') },
    { key: 'side', label: t('col.side'), render: (e) => e.side },
    { key: 'amount', label: t('col.amount'), align: 'end', render: (e) => <Amount minor={e.amount} currency={currency} /> },
  ];
  const actions: RowAction<Entry>[] = [{ label: t('l.open_transaction'), primary: true, when: (e) => !!e.transaction_reference, to: (e) => `/transactions/${e.transaction_reference}` }];
  const summary = (e: Entry) => (
    <SummaryGrid items={[
      { label: t('l.posting'), value: <span className="mono">{e.id}</span> },
      { label: t('l.memo'), value: e.justification ?? e.reference ?? '—' },
      { label: t('l.related_transaction'), value: e.transaction_reference ? <Link to={`/transactions/${e.transaction_reference}`} className="mono">{e.transaction_reference}</Link> : '—' },
    ]} />
  );
  return {
    columns, actions, summary, rowKey: (e) => e.id, defaultSort: 'when', defaultOrder: 'desc',
    filters: [...chip<Entry>('type', t('col.type'), ENTRY_TYPES), ...chip<Entry>('side', t('col.side'), ['debit', 'credit']), periodFilter<Entry>(t)],
    empty: { none: t('l.entry_none'), why: t('l.entry_why') },
  };
}

export function FloatDetailPage() {
  const { id } = useParams();
  const { has } = useSession();
  const t = useT();
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
            <dt>Cover</dt><dd>{a.coverHours == null ? '—' : `${a.coverHours} h`} · target {a.targetHours} h · minimum {a.minimumHours} h {a.overrideAmount != null && <Tag family="checking">manual override <Amount minor={a.overrideAmount} currency={a.currency} /></Tag>}</dd>
            {a.proposedTransfer != null && <><dt>Proposed transfer</dt><dd><Amount minor={a.proposedTransfer} currency={a.currency} /> from the paired collection wallet {data.paired_collection && <>(free <Amount minor={data.paired_collection.freeLiquidity} currency={a.currency} />) → <Link to="/treasury">register</Link></>}</dd></>}
            {data.withdrawable && <><dt>Withdrawable</dt><dd><Amount minor={data.withdrawable.withdrawable} currency={a.currency} /> <span className="small muted">(solvency <Amount minor={data.withdrawable.solvency} currency={a.currency} />, liquidity <Amount minor={data.withdrawable.liquidity} currency={a.currency} />; {data.withdrawable.binding} binds)</span></dd></>}
          </dl>
          <h3>Cover periods</h3>
          {has('treasury.read_float') ? (th ? <form className="row" onSubmit={async (e) => { e.preventDefault(); await put(`/treasury/float/${id}/thresholds`, th); setTh(null); reload(); }}><label>target h<input type="number" value={th.target_hours} onChange={(e) => setTh({ ...th, target_hours: Number(e.target.value) })} /></label><label>minimum h<input type="number" value={th.minimum_hours} onChange={(e) => setTh({ ...th, minimum_hours: Number(e.target.value) })} /></label><label>override amount<input type="number" value={th.override_amount ?? ''} onChange={(e) => setTh({ ...th, override_amount: e.target.value === '' ? null : Number(e.target.value) })} /></label><button className="primary">Save</button><button type="button" onClick={() => setTh(null)}>Cancel</button></form> : <button onClick={() => setTh({ target_hours: a.targetHours, minimum_hours: a.minimumHours, override_amount: a.overrideAmount })}>Adjust cover periods</button>) : <NeedsPermission permission="treasury.read_float" />}
        </div>
      </div>
      <div className="card">
        <h2>{t('l.entries')}</h2>
        <DataTable<Entry> search={false} {...entryList({ t, currency: a.currency })} fetch={fetchPage<Entry>(`/treasury/float/${id}/entries`, { period: 'after' })} />
      </div>
    </>
  );
}
