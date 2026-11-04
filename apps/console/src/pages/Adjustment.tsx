import { useState } from 'react';
import { get } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { ConfirmedAction, ErrorLine, NeedsPermission, useLoad } from '../components/common';

const emptyAdjustment = { postings: [{ account_id: '', side: 'debit', amount: 0 }, { account_id: '', side: 'credit', amount: 0 }], justification: '', reference: '' };

/**
 * A free-standing ledger adjustment (console spec 8): an ordinary balanced entry, sent to a second
 * administrator above the threshold. A discrepancy is corrected from its own page instead.
 */
export function AdjustmentForm() {
  const t = useT();
  const { has } = useSession();
  const [adjustment, setAdjustment] = useState(emptyAdjustment);
  const allowed = has('treasury.adjustment.post');
  const float = useLoad(() => (allowed ? get<any>('/treasury/float') : Promise.resolve(null)), [allowed]);
  const accountOptions = [
    ...(float.data?.accounts ?? []).map((a: any) => ({ id: a.id, label: `${a.providerAccountName} ${a.countryCode} ${a.currency} ${a.direction}` })),
    ...(float.data?.other_accounts ?? []).map((a: any) => ({ id: a.id, label: `${a.type.replace(/_/g, ' ')} ${a.currency_code}${a.settlement_destination ? ` (${a.settlement_destination})` : ''}` })),
  ];
  const setPosting = (i: number, patch: Partial<(typeof emptyAdjustment)['postings'][number]>) =>
    setAdjustment({ ...adjustment, postings: adjustment.postings.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <div className="card" style={{ maxWidth: 700 }}>
      <h2>{t('adj.title')}</h2>
      <p className="small muted">{t('adj.why')}</p>
      <p className="small muted">{t('adj.discrepancy_first')}</p>
      {!allowed ? <NeedsPermission permission="treasury.adjustment.post" /> : (<>
        <ErrorLine error={float.error} />
        <ConfirmedAction operationType="adjustment.post" values={adjustment} path="/treasury/adjustments" label={t('adj.post')}
          done={(r) => ((r as { status?: string })?.status === 'pending_approval' ? t('common.sent_for_approval') : t('adj.posted'))}
          onDone={() => { setAdjustment(emptyAdjustment); float.reload(); }} disabled={!adjustment.justification || adjustment.postings.some((p) => !p.account_id || p.amount <= 0)}
          summary={<div className="stack" style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
            {adjustment.postings.map((p, i) => (
              <div className="row" key={i}>
                <select aria-label={t('adj.account')} value={p.account_id} onChange={(e) => setPosting(i, { account_id: e.target.value })}><option value="">{t('adj.account')}</option>{accountOptions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
                <select aria-label={t('adj.side')} value={p.side} onChange={(e) => setPosting(i, { side: e.target.value })}><option value="debit">{t('adj.debit')}</option><option value="credit">{t('adj.credit')}</option></select>
                <input type="number" min={1} placeholder={t('fund.amount')} aria-label={t('fund.amount')} style={{ width: 120 }} value={p.amount || ''} onChange={(e) => setPosting(i, { amount: Number(e.target.value) })} />
              </div>
            ))}
            <input placeholder={t('fund.justification')} aria-label={t('fund.justification')} value={adjustment.justification} onChange={(e) => setAdjustment({ ...adjustment, justification: e.target.value })} />
          </div>} />
      </>)}
    </div>
  );
}
