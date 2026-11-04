import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, ConfirmedAction, ErrorLine, NeedsPermission, Pill, ScopeNote, Tag, When, useLoad } from '../components/common';
import { DataTable, SummaryGrid, type Column, type DataTableProps, type Filter } from '../components/table/DataTable';
import { chip, chipBy, cleanCurrency, distinct, fetchPage, periodFilter, useReload, useTab } from './list-support';

type Row = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;
type Lists = Pick<DataTableProps<Row>, 'columns' | 'filters' | 'summary' | 'rowKey' | 'defaultSort' | 'defaultOrder' | 'empty'>;
type Accounts = { id: string; label: string }[];

const MOVEMENT_FILTERS = (t: Tr, statuses: string[], accounts: Accounts, currencies: string[]): Filter<Row>[] => [
  ...chip<Row>('status', t('col.status'), statuses),
  ...chip<Row>('account', t('l.float_account'), accounts.map((a) => ({ value: a.id, label: a.label }))),
  ...chip<Row>('currency', t('l.currency'), currencies),
  periodFilter<Row>(t),
];

/** Float transfers: where the money moved, how much, and which reconciliation run confirmed it. */
export function transferList({ t, accounts, currencies, currency }: { t: Tr; accounts: Accounts; currencies: string[]; currency?: string }): Lists {
  const name = (id: string) => accounts.find((a) => a.id === id)?.label ?? id.slice(0, 8);
  const columns: Column<Row>[] = [
    { key: 'path', label: t('col.from_to'), render: (r) => <span className="small">{name(r.source_account_id)} → {name(r.destination_account_id)}</span> },
    { key: 'amount', label: t('col.amount'), align: 'end', sortKey: currency ? 'amount' : undefined, render: (r) => <Amount minor={r.amount} currency={r.currency_code} /> },
    { key: 'status', label: t('col.status'), render: (r) => <Pill value={r.status} /> },
    { key: 'created', label: t('col.created'), sortKey: 'created', render: (r) => <When value={r.created_at} /> },
  ];
  const summary = (r: Row) => (
    <SummaryGrid items={[
      { label: t('l.path'), value: r.execution_path },
      { label: t('l.confirming_run'), value: r.confirming_run_id ? <Link to={`/reconciliation/runs/${r.confirming_run_id}`}>{r.confirming_run_id.slice(0, 8)}</Link> : '—' },
      { label: t('l.provider_fee'), value: <Amount minor={r.provider_fee} currency={r.currency_code} /> },
      { label: t('l.references'), value: <span className="mono">{r.provider_reference ?? '—'}</span> },
      { label: t('l.administrators'), value: r.initiator },
      ...(r.note ? [{ label: t('l.note'), value: r.note }] : []),
    ]} />
  );
  return { columns, filters: MOVEMENT_FILTERS(t, ['pending', 'confirmed', 'failed'], accounts, currencies), summary, rowKey: (r) => r.id, defaultSort: 'created', defaultOrder: 'desc', empty: { none: t('l.transfer_none'), why: t('l.transfer_why') } };
}

/** Cashouts: capital leaving the platform, with both administrators who approved it. */
export function cashoutList({ t, accounts, currencies, currency }: { t: Tr; accounts: Accounts; currencies: string[]; currency?: string }): Lists {
  const name = (id: string) => accounts.find((a) => a.id === id)?.label ?? id.slice(0, 8);
  const columns: Column<Row>[] = [
    { key: 'account', label: t('l.float_account'), render: (r) => <span className="small">{name(r.float_account_id)}</span> },
    { key: 'amount', label: t('col.amount'), align: 'end', sortKey: currency ? 'amount' : undefined, render: (r) => <Amount minor={r.amount} currency={r.currency_code} /> },
    { key: 'status', label: t('col.status'), render: (r) => <Pill value={r.status} /> },
    { key: 'by', label: t('col.requested_by'), render: (r) => r.initiator },
    { key: 'created', label: t('col.created'), sortKey: 'created', render: (r) => <When value={r.created_at} /> },
  ];
  const summary = (r: Row) => (
    <SummaryGrid items={[
      { label: t('l.destination'), value: <span className="mono">{r.destination_reference}</span> },
      { label: t('l.approvals'), value: `${r.initiator} + ${r.approver ?? '—'}` },
      { label: t('l.confirmation'), value: r.confirmed_at ? <When value={r.confirmed_at} /> : '—' },
      { label: t('l.solvency'), value: <Amount minor={r.solvency_remainder} currency={r.currency_code} /> },
      { label: t('l.liquidity'), value: <Amount minor={r.liquidity_remainder} currency={r.currency_code} /> },
      ...(r.supporting_document ? [{ label: t('l.document'), value: r.supporting_document }] : []),
    ]} />
  );
  return { columns, filters: MOVEMENT_FILTERS(t, ['pending_approval', 'approved', 'declined', 'confirmed'], accounts, currencies), summary, rowKey: (r) => r.id, defaultSort: 'created', defaultOrder: 'desc', empty: { none: t('l.cashout_none'), why: t('l.cashout_why') } };
}

type Listed = Pick<DataTableProps<Row>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'empty'>;
const NO_COVER = 1e12; // a wallet with no cover figure sorts after every one that has it

/** Float accounts, the least covered first. Opening one is the action; the figures behind the band are in the summary. */
export function floatAccountList({ t, rows }: { t: Tr; rows: Row[] }): Listed {
  const columns: Column<Row>[] = [
    { key: 'provider', label: t('col.provider'), text: (a) => a.providerAccountName, sortValue: (a) => a.providerAccountName, render: (a) => a.providerAccountName },
    { key: 'country', label: t('l.country'), text: (a) => a.countryCode, render: (a) => a.countryCode },
    { key: 'currency', label: t('l.currency'), text: (a) => a.currency, render: (a) => a.currency },
    { key: 'direction', label: t('col.type'), text: (a) => a.direction, render: (a) => t(`l.${a.direction}`) },
    { key: 'cover', label: t('col.cover_band'), sortValue: (a) => a.coverHours ?? NO_COVER, render: (a) => <Pill value={a.band} /> },
    { key: 'balance', label: t('col.balance'), align: 'end', render: (a) => <Amount minor={a.balance} currency={a.currency} /> },
  ];
  const summary = (a: Row) => (
    <SummaryGrid items={[
      { label: t('l.free_liquidity'), value: <Amount minor={a.freeLiquidity} currency={a.currency} /> },
      { label: t('l.open_disbursements'), value: <Amount minor={a.openDisbursements} currency={a.currency} /> },
      { label: t('l.recent_outflow'), value: <span><Amount minor={a.outflowPerHour} currency={a.currency} /> <span className="small muted">{t('l.per_hour')}</span></span> },
      { label: t('l.cover_hours'), value: a.coverHours == null ? '—' : `${a.coverHours} h` },
      { label: t('l.proposed_transfer'), value: a.proposedTransfer != null ? <Amount minor={a.proposedTransfer} currency={a.currency} /> : '—' },
    ]} />
  );
  return {
    columns, summary, rowKey: (a) => a.id, defaultSort: 'cover',
    filters: [
      ...chipBy<Row>('band', t('col.cover_band'), ['critical', 'watch', 'healthy'], (a) => a.band),
      ...chipBy<Row>('currency', t('l.currency'), distinct(rows, (a) => a.currency), (a) => a.currency),
      ...chipBy<Row>('direction', t('col.type'), [{ value: 'collection', label: t('l.collection') }, { value: 'disbursement', label: t('l.disbursement') }], (a) => a.direction),
    ],
    actions: [{ label: t('table.open'), primary: true, to: (a) => `/treasury/float/${a.id}` }],
    empty: { none: t('l.float_none'), why: t('l.float_why') },
  };
}

/** What each project holds, one row per currency; a project with no balance keeps a row saying so. */
export function projectBalanceList({ t, rows }: { t: Tr; rows: Row[] }): Listed {
  const columns: Column<Row>[] = [
    { key: 'project', label: t('col.project'), text: (r) => r.project.name, sortValue: (r) => r.project.name, render: (r) => r.project.name },
    { key: 'currency', label: t('l.currency'), text: (r) => r.currency ?? '', render: (r) => r.currency ?? <span className="muted">{t('l.no_balance')}</span> },
    { key: 'available', label: t('col.available'), align: 'end', render: (r) => (r.currency ? <Amount minor={r.available} currency={r.currency} /> : '') },
    { key: 'reserved', label: t('col.reserved'), align: 'end', render: (r) => (r.currency ? <Amount minor={r.reserved} currency={r.currency} /> : '') },
  ];
  return {
    columns, rowKey: (r) => r.project.id + (r.currency ?? ''), defaultSort: 'project',
    filters: chipBy<Row>('currency', t('l.currency'), distinct(rows, (r) => r.currency), (r) => r.currency),
    actions: [{ label: t('l.open_project'), primary: true, to: (r) => `/projects/${r.project.id}` }],
    empty: { none: t('l.balance_none'), why: t('l.balance_why') },
  };
}

/** One row per project and currency, from the endpoint's per-project lists. */
export const balanceRows = (projects: Row[]): Row[] => projects.flatMap((p) => (p.balances.length ? p.balances.map((b: Row) => ({ project: p.project, ...b })) : [{ project: p.project, currency: null }]));

/** Treasury (console spec 8): balances, float ordered by cover, transfers, cashouts, funding and adjustments. */
export function TreasuryPage() {
  const { has } = useSession();
  const [tab, setTab] = useTab(['float', 'balances', 'transfers', 'cashouts', 'funding'] as const, 'float');
  const float = useLoad(() => get<any>('/treasury/float'), [tab]);
  const balances = useLoad(() => (has('treasury.read_balances') ? get<any>('/treasury/balances') : Promise.resolve(null)), [tab]);
  const t = useT();
  const [params] = useSearchParams();
  const [transfersRev, reloadTransfers] = useReload();
  const [cashoutsRev, reloadCashouts] = useReload();
  const [transfer, setTransfer] = useState({ source_account_id: '', destination_account_id: '', amount: 0, provider_fee: 0, provider_reference: '', note: '' });
  const [cashout, setCashout] = useState({ float_account_id: '', destination: '', amount: 0, supporting_document: '', justification: '' });
  const [withdrawable, setWithdrawable] = useState<any>(null);
  const [funding, setFunding] = useState({ target: 'float', float_account_id: '', project_id: '', currency: 'XAF', amount: 0, justification: '', reference: '' });
  const [adjustment, setAdjustment] = useState({ postings: [{ account_id: '', side: 'debit', amount: 0 }, { account_id: '', side: 'credit', amount: 0 }], justification: '', reference: '' });
  const accounts = float.data?.accounts ?? [];
  const others = float.data?.other_accounts ?? [];
  const floatLabels: Accounts = accounts.map((a: any) => ({ id: a.id, label: `${a.providerAccountName} ${a.countryCode} ${a.currency} ${a.direction}` }));
  const currencies: string[] = (float.data?.coverage ?? []).map((c: any) => c.currency);
  const accountOptions = [...accounts.map((a: any) => ({ id: a.id, label: `${a.providerAccountName} ${a.countryCode} ${a.currency} ${a.direction}` })), ...others.map((a: any) => ({ id: a.id, label: `${a.type.replace(/_/g, ' ')} ${a.currency_code}${a.settlement_destination ? ` (${a.settlement_destination})` : ''}` }))];
  return (
    <>
      <h1>Treasury</h1>
      <div className="tabs">{(['float', 'balances', 'transfers', 'cashouts', 'funding'] as const).map((k) => <a key={k} href="#" className={tab === k ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab(k); }}>{k}</a>)}</div>
      {tab === 'float' && (<>
        <ErrorLine error={float.error} />
        {float.data && <>
          <ScopeNote scoped={float.data.scoped} />
          <div className="row" style={{ marginBottom: 12 }}>{float.data.coverage.map((c: any) => <div className="card" key={c.currency}><b>{c.currency}</b> coverage {c.ratio ?? '—'} {c.ratio != null && c.ratio < 1 && <Tag family="refused">below one: project balances exceed what backs them</Tag>}<br /><span className="small muted">float <Amount minor={c.float} currency={c.currency} /> · encumbered <Amount minor={c.encumbered} currency={c.currency} /></span></div>)}</div>
          <DataTable<Row> prefix="fa_" rows={accounts} {...floatAccountList({ t, rows: accounts })} />
        </>}
      </>)}
      {tab === 'balances' && (<>
        <ErrorLine error={balances.error} />
        {balances.data ? <DataTable<Row> prefix="bal_" rows={balanceRows(balances.data.projects)} {...projectBalanceList({ t, rows: balanceRows(balances.data.projects) })} /> : <NeedsPermission permission="treasury.read_balances" />}
      </>)}
      {tab === 'transfers' && (<>
        {has('treasury.read_float') ? (float.data
          ? <>{!cleanCurrency(params.get('tr_currency'), currencies) && <p className="small muted">{t('l.amount_needs_currency')}</p>}<DataTable<Row> key={transfersRev} prefix="tr_" search={false} {...transferList({ t, accounts: floatLabels, currencies, currency: cleanCurrency(params.get('tr_currency'), currencies) })} fetch={fetchPage<Row>('/treasury/transfers', { period: 'after' })} /></>
          : null) : <NeedsPermission permission="treasury.read_float" />}
        <div className="card" style={{ marginTop: 12 }}>
          <h2>Register a transfer performed at the provider</h2>
          {has('treasury.transfer') ? (
            <ConfirmedAction operationType="float_transfer.register" values={transfer} path="/treasury/transfers" label="Register transfer" onDone={reloadTransfers}
              summary={<div className="row">
                <select value={transfer.source_account_id} onChange={(e) => setTransfer({ ...transfer, source_account_id: e.target.value })}><option value="">source wallet</option>{accounts.map((a: any) => <option key={a.id} value={a.id}>{a.providerAccountName} {a.countryCode} {a.currency} {a.direction} (free {a.freeLiquidity})</option>)}</select>
                <select value={transfer.destination_account_id} onChange={(e) => setTransfer({ ...transfer, destination_account_id: e.target.value })}><option value="">destination wallet</option>{accounts.map((a: any) => <option key={a.id} value={a.id}>{a.providerAccountName} {a.countryCode} {a.currency} {a.direction} (balance {a.balance})</option>)}</select>
                <input type="number" placeholder="amount" value={transfer.amount || ''} onChange={(e) => setTransfer({ ...transfer, amount: Number(e.target.value) })} />
                <input type="number" placeholder="provider fee" value={transfer.provider_fee || ''} onChange={(e) => setTransfer({ ...transfer, provider_fee: Number(e.target.value) })} />
                <input placeholder="provider reference" value={transfer.provider_reference} onChange={(e) => setTransfer({ ...transfer, provider_reference: e.target.value })} />
                {transfer.source_account_id && transfer.destination_account_id && transfer.amount > 0 && <span className="small">Resulting: source <Amount minor={(accounts.find((a: any) => a.id === transfer.source_account_id)?.balance ?? 0) - transfer.amount} currency={accounts.find((a: any) => a.id === transfer.source_account_id)?.currency ?? ''} />, destination <Amount minor={(accounts.find((a: any) => a.id === transfer.destination_account_id)?.balance ?? 0) + transfer.amount - transfer.provider_fee} currency={accounts.find((a: any) => a.id === transfer.destination_account_id)?.currency ?? ''} /></span>}
              </div>} disabled={!transfer.source_account_id || !transfer.destination_account_id || transfer.amount <= 0} />
          ) : <NeedsPermission permission="treasury.transfer" />}
        </div>
      </>)}
      {tab === 'cashouts' && (<>
        {has('treasury.read_float') ? (float.data
          ? <>{!cleanCurrency(params.get('co_currency'), currencies) && <p className="small muted">{t('l.amount_needs_currency')}</p>}<DataTable<Row> key={cashoutsRev} prefix="co_" search={false} {...cashoutList({ t, accounts: floatLabels, currencies, currency: cleanCurrency(params.get('co_currency'), currencies) })} fetch={fetchPage<Row>('/treasury/cashouts', { period: 'after' })} /></>
          : null) : <NeedsPermission permission="treasury.read_float" />}
        <div className="card" style={{ marginTop: 12 }}>
          <h2>Initiate a cashout</h2>
          {has('treasury.cashout.initiate') ? (
            <ConfirmedAction operationType="cashout.initiate" values={cashout} path="/treasury/cashouts" label="Initiate cashout" onDone={reloadCashouts} disabled={!cashout.float_account_id || cashout.amount <= 0 || !cashout.destination || !cashout.supporting_document || !cashout.justification}
              summary={<div className="stack" style={{ display: 'grid', gap: 8 }}>
                <div className="row">
                  <select value={cashout.float_account_id} onChange={async (e) => { setCashout({ ...cashout, float_account_id: e.target.value }); setWithdrawable(e.target.value ? await get(`/treasury/cashouts/withdrawable/${e.target.value}`) : null); }}><option value="">float account</option>{accounts.map((a: any) => <option key={a.id} value={a.id}>{a.providerAccountName} {a.countryCode} {a.currency} {a.direction}</option>)}</select>
                  <input placeholder="destination (bank/cash reference)" value={cashout.destination} onChange={(e) => setCashout({ ...cashout, destination: e.target.value })} />
                  <input type="number" placeholder="amount" value={cashout.amount || ''} onChange={(e) => setCashout({ ...cashout, amount: Number(e.target.value) })} />
                </div>
                <div className="row"><input placeholder="supporting document reference" value={cashout.supporting_document} onChange={(e) => setCashout({ ...cashout, supporting_document: e.target.value })} style={{ width: 300 }} /><input placeholder="justification" value={cashout.justification} onChange={(e) => setCashout({ ...cashout, justification: e.target.value })} style={{ width: 300 }} /></div>
                {withdrawable && <p className="small">Solvency remainder <b><Amount minor={withdrawable.solvency} currency={accounts.find((a: any) => a.id === cashout.float_account_id)?.currency ?? ''} /></b> · liquidity remainder <b><Amount minor={withdrawable.liquidity} currency={accounts.find((a: any) => a.id === cashout.float_account_id)?.currency ?? ''} /></b> · <Tag family="tag">{withdrawable.binding} binds</Tag> → withdrawable <b><Amount minor={withdrawable.withdrawable} currency={accounts.find((a: any) => a.id === cashout.float_account_id)?.currency ?? ''} /></b>{cashout.amount > withdrawable.withdrawable && <span className="negative"> · exceeds the withdrawable amount</span>}</p>}
              </div>} />
          ) : <NeedsPermission permission="treasury.cashout.initiate" />}
        </div>
      </>)}
      {tab === 'funding' && (<div className="grid2">
        <div className="card">
          <h2>Funding</h2>
          <p className="small muted">Placing capital at a provider and granting a project a balance are separate acts; granting a balance without float behind it moves the coverage ratio.</p>
          {has('treasury.funding') ? (
            <ConfirmedAction operationType="funding.post" values={funding} path="/treasury/funding" label="Post funding" onDone={() => float.reload()} disabled={funding.amount <= 0 || !funding.justification || (funding.target === 'float' ? !funding.float_account_id : !funding.project_id)}
              summary={<div className="stack" style={{ display: 'grid', gap: 8 }}>
                <div className="row"><select value={funding.target} onChange={(e) => setFunding({ ...funding, target: e.target.value })}><option value="float">float account</option><option value="project">project balance</option></select>
                  {funding.target === 'float' ? <select value={funding.float_account_id} onChange={(e) => { const a = accounts.find((x: any) => x.id === e.target.value); setFunding({ ...funding, float_account_id: e.target.value, currency: a?.currency ?? funding.currency }); }}><option value="">account</option>{accounts.map((a: any) => <option key={a.id} value={a.id}>{a.providerAccountName} {a.countryCode} {a.currency} {a.direction}</option>)}</select>
                    : <select value={funding.project_id} onChange={(e) => setFunding({ ...funding, project_id: e.target.value })}><option value="">project</option>{(balances.data?.projects ?? []).map((p: any) => <option key={p.project.id} value={p.project.id}>{p.project.name}</option>)}</select>}
                  <input style={{ width: 70 }} value={funding.currency} onChange={(e) => setFunding({ ...funding, currency: e.target.value.toUpperCase() })} />
                  <input type="number" placeholder="amount" value={funding.amount || ''} onChange={(e) => setFunding({ ...funding, amount: Number(e.target.value) })} /></div>
                <div className="row"><input placeholder="justification" value={funding.justification} onChange={(e) => setFunding({ ...funding, justification: e.target.value })} style={{ width: 300 }} /><input placeholder="reference" value={funding.reference} onChange={(e) => setFunding({ ...funding, reference: e.target.value })} /></div>
              </div>} />
          ) : <NeedsPermission permission="treasury.funding" />}
        </div>
        <div className="card">
          <h2>Adjustment</h2>
          <p className="small muted">Corrects the ledger with an ordinary balanced entry; above the threshold a second approver is required.</p>
          {has('treasury.adjustment.post') ? (
            <ConfirmedAction operationType="adjustment.post" values={adjustment} path="/treasury/adjustments" label="Post adjustment" disabled={!adjustment.justification || adjustment.postings.some((p) => !p.account_id || p.amount <= 0)}
              summary={<div className="stack" style={{ display: 'grid', gap: 8 }}>
                {adjustment.postings.map((p, i) => <div className="row" key={i}><select value={p.account_id} onChange={(e) => { const ps = [...adjustment.postings]; ps[i] = { ...p, account_id: e.target.value }; setAdjustment({ ...adjustment, postings: ps }); }}><option value="">account</option>{accountOptions.map((a: any) => <option key={a.id} value={a.id}>{a.label}</option>)}</select><select value={p.side} onChange={(e) => { const ps = [...adjustment.postings]; ps[i] = { ...p, side: e.target.value }; setAdjustment({ ...adjustment, postings: ps }); }}><option>debit</option><option>credit</option></select><input type="number" value={p.amount || ''} onChange={(e) => { const ps = [...adjustment.postings]; ps[i] = { ...p, amount: Number(e.target.value) }; setAdjustment({ ...adjustment, postings: ps }); }} /></div>)}
                <input placeholder="justification" value={adjustment.justification} onChange={(e) => setAdjustment({ ...adjustment, justification: e.target.value })} />
              </div>} />
          ) : <NeedsPermission permission="treasury.adjustment.post" />}
        </div>
      </div>)}
    </>
  );
}
