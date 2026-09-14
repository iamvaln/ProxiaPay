import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { useSession } from '../lib/session';
import { Amount, ConfirmedAction, Empty, ErrorLine, NeedsPermission, Pill, ScopeNote, When, useLoad } from '../components/common';

/** Treasury (console spec 8): balances, float ordered by cover, transfers, cashouts, funding and adjustments. */
export function TreasuryPage() {
  const { has } = useSession();
  const [tab, setTab] = useState<'float' | 'balances' | 'transfers' | 'cashouts' | 'funding'>('float');
  const float = useLoad(() => get<any>('/treasury/float'), [tab]);
  const balances = useLoad(() => (has('treasury.read_balances') ? get<any>('/treasury/balances') : Promise.resolve(null)), [tab]);
  const transfers = useLoad(() => (has('treasury.read_float') ? get<any>('/treasury/transfers') : Promise.resolve(null)), [tab]);
  const cashouts = useLoad(() => (has('treasury.read_float') ? get<any>('/treasury/cashouts') : Promise.resolve(null)), [tab]);
  const [transfer, setTransfer] = useState({ source_account_id: '', destination_account_id: '', amount: 0, provider_fee: 0, provider_reference: '', note: '' });
  const [cashout, setCashout] = useState({ float_account_id: '', destination: '', amount: 0, supporting_document: '', justification: '' });
  const [withdrawable, setWithdrawable] = useState<any>(null);
  const [funding, setFunding] = useState({ target: 'float', float_account_id: '', project_id: '', currency: 'XAF', amount: 0, justification: '', reference: '' });
  const [adjustment, setAdjustment] = useState({ postings: [{ account_id: '', side: 'debit', amount: 0 }, { account_id: '', side: 'credit', amount: 0 }], justification: '', reference: '' });
  const accounts = float.data?.accounts ?? [];
  const others = float.data?.other_accounts ?? [];
  const accountOptions = [...accounts.map((a: any) => ({ id: a.id, label: `${a.providerAccountName} ${a.countryCode} ${a.currency} ${a.direction}` })), ...others.map((a: any) => ({ id: a.id, label: `${a.type.replace(/_/g, ' ')} ${a.currency_code}${a.settlement_destination ? ` (${a.settlement_destination})` : ''}` }))];
  return (
    <>
      <h1>Treasury</h1>
      <div className="tabs">{(['float', 'balances', 'transfers', 'cashouts', 'funding'] as const).map((k) => <a key={k} href="#" className={tab === k ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab(k); }}>{k}</a>)}</div>
      {tab === 'float' && (<>
        <ErrorLine error={float.error} />
        {float.data && <>
          <ScopeNote scoped={float.data.scoped} />
          <div className="row" style={{ marginBottom: 12 }}>{float.data.coverage.map((c: any) => <div className="card" key={c.currency}><b>{c.currency}</b> coverage {c.ratio ?? '—'} {c.ratio != null && c.ratio < 1 && <span className="pill critical">below one: project balances exceed what backs them</span>}<br /><span className="small muted">float <Amount minor={c.float} currency={c.currency} /> · encumbered <Amount minor={c.encumbered} currency={c.currency} /></span></div>)}</div>
          {accounts.length === 0 ? <Empty text="No float account yet; one appears with the first collection or funding at a provider." /> : (
            <table><thead><tr><th>Account</th><th className="num">Wallet balance</th><th className="num">Open disbursements</th><th className="num">Free liquidity</th><th className="num">Cover</th><th>Band</th><th className="num">Proposed transfer</th></tr></thead>
              <tbody>{accounts.map((a: any) => <tr key={a.id}><td><Link to={`/treasury/float/${a.id}`}>{a.providerAccountName} · {a.countryCode} · {a.currency} · {a.direction}</Link></td><td className="num"><Amount minor={a.balance} currency={a.currency} /></td><td className="num"><Amount minor={a.openDisbursements} currency={a.currency} /></td><td className="num"><Amount minor={a.freeLiquidity} currency={a.currency} /></td><td className="num">{a.coverHours == null ? '—' : `${a.coverHours} h`}</td><td><Pill value={a.band} /></td><td className="num">{a.proposedTransfer != null ? <Amount minor={a.proposedTransfer} currency={a.currency} /> : '—'}</td></tr>)}</tbody></table>
          )}
        </>}
      </>)}
      {tab === 'balances' && (<>
        <ErrorLine error={balances.error} />
        {balances.data ? (balances.data.projects.length === 0 ? <Empty /> : <table><thead><tr><th>Project</th><th>Currency</th><th className="num">Available</th><th className="num">Reserved</th></tr></thead>
          <tbody>{balances.data.projects.flatMap((p: any) => p.balances.length ? p.balances.map((b: any) => <tr key={p.project.id + b.currency}><td><Link to={`/projects/${p.project.id}`}>{p.project.name}</Link></td><td>{b.currency}</td><td className="num"><Amount minor={b.available} currency={b.currency} /></td><td className="num"><Amount minor={b.reserved} currency={b.currency} /></td></tr>) : [<tr key={p.project.id}><td><Link to={`/projects/${p.project.id}`}>{p.project.name}</Link></td><td colSpan={3} className="muted">no balance</td></tr>])}</tbody></table>) : <NeedsPermission permission="treasury.read_balances" />}
      </>)}
      {tab === 'transfers' && (<>
        {transfers.data && (transfers.data.transfers.length === 0 ? <Empty text="No transfer registered. Register one after moving funds in the provider's console; reconciliation confirms it." /> : <table><thead><tr><th>Registered</th><th>Source → destination</th><th className="num">Amount</th><th className="num">Fee</th><th>Path</th><th>Status</th><th>Confirmed by run</th><th>By</th></tr></thead>
          <tbody>{transfers.data.transfers.map((t: any) => <tr key={t.id}><td><When value={t.created_at} /></td><td className="small">{t.source_account_id.slice(0, 8)} → {t.destination_account_id.slice(0, 8)}</td><td className="num"><Amount minor={t.amount} currency={t.currency_code} /></td><td className="num"><Amount minor={t.provider_fee} currency={t.currency_code} /></td><td>{t.execution_path}</td><td><Pill value={t.status} /></td><td className="small">{t.confirming_run_id ? <Link to={`/reconciliation/runs/${t.confirming_run_id}`}>{t.confirming_run_id.slice(0, 8)}</Link> : '—'}</td><td>{t.initiator}</td></tr>)}</tbody></table>)}
        <div className="card" style={{ marginTop: 12 }}>
          <h2>Register a transfer performed at the provider</h2>
          {has('treasury.transfer') ? (
            <ConfirmedAction operationType="float_transfer.register" values={transfer} path="/treasury/transfers" label="Register transfer" onDone={() => transfers.reload()}
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
        {cashouts.data && (cashouts.data.cashouts.length === 0 ? <Empty text="No cashout yet." /> : <table><thead><tr><th>Initiated</th><th>Destination</th><th className="num">Amount</th><th>Status</th><th>Initiator</th><th>Approver</th><th className="num">Solvency / liquidity remainder</th></tr></thead>
          <tbody>{cashouts.data.cashouts.map((c: any) => <tr key={c.id}><td><When value={c.created_at} /></td><td>{c.destination_reference}</td><td className="num"><Amount minor={c.amount} currency={c.currency_code} /></td><td><Pill value={c.status} /></td><td>{c.initiator}</td><td>{c.approver ?? '—'}</td><td className="num small"><Amount minor={c.solvency_remainder} currency={c.currency_code} /> / <Amount minor={c.liquidity_remainder} currency={c.currency_code} /></td></tr>)}</tbody></table>)}
        <div className="card" style={{ marginTop: 12 }}>
          <h2>Initiate a cashout</h2>
          {has('treasury.cashout.initiate') ? (
            <ConfirmedAction operationType="cashout.initiate" values={cashout} path="/treasury/cashouts" label="Initiate cashout" onDone={() => cashouts.reload()} disabled={!cashout.float_account_id || cashout.amount <= 0 || !cashout.destination || !cashout.supporting_document || !cashout.justification}
              summary={<div className="stack" style={{ display: 'grid', gap: 8 }}>
                <div className="row">
                  <select value={cashout.float_account_id} onChange={async (e) => { setCashout({ ...cashout, float_account_id: e.target.value }); setWithdrawable(e.target.value ? await get(`/treasury/cashouts/withdrawable/${e.target.value}`) : null); }}><option value="">float account</option>{accounts.map((a: any) => <option key={a.id} value={a.id}>{a.providerAccountName} {a.countryCode} {a.currency} {a.direction}</option>)}</select>
                  <input placeholder="destination (bank/cash reference)" value={cashout.destination} onChange={(e) => setCashout({ ...cashout, destination: e.target.value })} />
                  <input type="number" placeholder="amount" value={cashout.amount || ''} onChange={(e) => setCashout({ ...cashout, amount: Number(e.target.value) })} />
                </div>
                <div className="row"><input placeholder="supporting document reference" value={cashout.supporting_document} onChange={(e) => setCashout({ ...cashout, supporting_document: e.target.value })} style={{ width: 300 }} /><input placeholder="justification" value={cashout.justification} onChange={(e) => setCashout({ ...cashout, justification: e.target.value })} style={{ width: 300 }} /></div>
                {withdrawable && <p className="small">Solvency remainder <b><Amount minor={withdrawable.solvency} currency={accounts.find((a: any) => a.id === cashout.float_account_id)?.currency ?? ''} /></b> · liquidity remainder <b><Amount minor={withdrawable.liquidity} currency={accounts.find((a: any) => a.id === cashout.float_account_id)?.currency ?? ''} /></b> · <span className="pill primary">{withdrawable.binding} binds</span> → withdrawable <b><Amount minor={withdrawable.withdrawable} currency={accounts.find((a: any) => a.id === cashout.float_account_id)?.currency ?? ''} /></b>{cashout.amount > withdrawable.withdrawable && <span className="negative"> · exceeds the withdrawable amount</span>}</p>}
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
