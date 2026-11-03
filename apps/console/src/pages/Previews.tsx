import { Link, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { useT } from '../lib/session';
import { Amount, Pill, When } from '../components/common';
import { DataTable, SummaryGrid, type Column, type DataTableProps, type Filter, type RowAction } from '../components/table/DataTable';
import { chip, fetchPage, periodFilter, type Paged, useReference, type Reference } from './list-support';

type Preview = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;

export function previewList({ t, ref }: { t: Tr; ref: Reference }): Pick<DataTableProps<Preview>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'defaultOrder' | 'empty'> {
  const columns: Column<Preview>[] = [
    { key: 'reference', label: t('col.reference'), mono: true, render: (r) => r.reference },
    { key: 'project', label: t('col.project'), render: (r) => r.project_name },
    { key: 'route', label: t('col.route'), render: (r) => `${r.country_code} · ${r.payment_method_code} · ${t(`l.${r.direction}`)}` },
    { key: 'amount', label: t('col.amount'), align: 'end', render: (r) => <Amount minor={r.requested_amount} currency={r.currency_code} /> },
    { key: 'payer', label: t('col.payer'), render: (r) => r.msisdn_masked },
    { key: 'status', label: t('col.status'), render: (r) => <Pill value={r.status} /> },
    { key: 'created', label: t('col.created'), sortKey: 'created', render: (r) => <When value={r.created_at} /> },
  ];
  const filters: Filter<Preview>[] = [
    ...chip<Preview>('status', t('col.status'), ['open', 'confirmed', 'expired']),
    ...chip<Preview>('project', t('col.project'), ref.projects.map((p) => ({ value: p.id, label: p.name }))),
    periodFilter<Preview>(t),
  ];
  const actions: RowAction<Preview>[] = [
    { label: t('l.open_transaction'), primary: true, when: (r) => !!r.transaction_reference, to: (r) => `/transactions/${r.transaction_reference}` },
  ];
  const summary = (r: Preview) => (
    <SummaryGrid items={[
      { label: t('l.charged'), value: <Amount minor={r.charged_amount} currency={r.currency_code} /> },
      { label: t('l.expiry'), value: <When value={r.expires_at} /> },
      { label: t('l.payer_action'), value: r.payer_action },
      { label: t('l.project_reference'), value: <span className="mono">{r.project_reference}</span> },
    ]} />
  );
  return { columns, filters, actions, summary, rowKey: (r) => r.id, defaultSort: 'created', defaultOrder: 'desc', empty: { none: t('l.preview_none'), why: t('l.preview_why') } };
}

/** Previews (console spec 5.3): the unconfirmed ones are the value of this screen. */
export function PreviewsPage() {
  const t = useT();
  const ref = useReference();
  const [params] = useSearchParams();
  const msisdn = params.get('msisdn') ?? undefined;
  // The panel rides on every page the table fetches.
  type Panel = { repeat_unconfirmed: { msisdn_masked: string; n: number }[]; repeat_capped: boolean };
  const [panel, setPanel] = useState<Panel | null>(null);
  const load = fetchPage<Preview>('/previews', { period: 'created_after', extra: { msisdn } });
  const fetchWithPanel = async (s: Parameters<typeof load>[0]) => { const res = (await load(s)) as Paged<Preview> & Panel; setPanel(res); return res; };
  return (
    <>
      <h1>{t('txn.previews')}</h1>
      {panel && panel.repeat_unconfirmed.length > 0 && (
        <div className="warnbox">{t('l.repeat_title')} {panel.repeat_unconfirmed.map((r) => <span key={r.msisdn_masked}><Link to={`/transactions/previews?msisdn=${encodeURIComponent(r.msisdn_masked)}`}>{r.msisdn_masked}</Link> ({r.n}) </span>)}
          {panel.repeat_capped && <span className="small muted">{t('l.first_20')}</span>}</div>
      )}
      {msisdn && <p className="small">{t('l.payer')} : <b>{msisdn}</b> · <Link to="/transactions/previews">{t('table.clear_filters')}</Link></p>}
      {ref.ready ? <DataTable<Preview> key={msisdn ?? ''} {...previewList({ t, ref })} searchLabel={t('l.search_reference')} fetch={fetchWithPanel} /> : <p className="muted">{t('common.loading')}</p>}
    </>
  );
}
