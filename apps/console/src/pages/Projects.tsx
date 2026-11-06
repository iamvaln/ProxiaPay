import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, ErrorLine, NeedsPermission, Pill, ScopeNote, SubmitForm, When, useLoad } from '../components/common';
import { DataTable, SummaryGrid, type Column, type DataTableProps } from '../components/table/DataTable';
import { chipBy, distinct } from './list-support';

type Row = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;

/** The projects: transactions over 30 days sort the list, and the value over 30 days (one figure per currency, since amounts only add inside one) sits in the summary. */
export function projectList({ t, rows }: { t: Tr; rows: Row[] }): Pick<DataTableProps<Row>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'empty'> {
  const columns: Column<Row>[] = [
    { key: 'name', label: t('col.name'), text: (p) => p.name, sortValue: (p) => p.name, render: (p) => <Link to={`/projects/${p.id}`}>{p.name}</Link> },
    { key: 'code', label: t('col.code'), mono: true, text: (p) => p.code, render: (p) => p.code },
    { key: 'status', label: t('col.status'), text: (p) => p.status, render: (p) => <Pill value={p.status} /> },
    { key: 'volume', label: t('col.volume_30d'), align: 'end', sortValue: (p) => p.volume_30d, render: (p) => p.volume_30d },
    { key: 'created', label: t('col.created'), sortValue: (p) => Date.parse(p.created_at), render: (p) => <When value={p.created_at} /> },
  ];
  const summary = (p: Row) => (
    <SummaryGrid items={[
      { label: t('l.value_30d'), value: p.value_30d?.length ? p.value_30d.map((v: Row) => <div key={v.currency}><Amount minor={v.value} currency={v.currency} /></div>) : <span className="muted">—</span> },
      { label: t('l.balances'), value: p.balances.length ? p.balances.map((b: Row) => <div key={b.currency}><Amount minor={b.available} currency={b.currency} /> <span className="small muted">(+<Amount minor={b.reserved} currency={b.currency} /> {t('l.reserved')})</span></div>) : <span className="muted">—</span> },
      { label: t('l.routes_granted'), value: p.routes_granted },
      { label: t('l.credentials_active'), value: p.credentials_active },
    ]} />
  );
  return {
    columns, summary, rowKey: (p) => p.id, defaultSort: 'name',
    filters: chipBy<Row>('status', t('col.status'), distinct(rows, (p) => p.status), (p) => p.status),
    actions: [{ label: t('table.open'), primary: true, to: (p) => `/projects/${p.id}` }],
    empty: { none: t('l.project_none'), why: t('l.project_why') },
  };
}

export function ProjectsPage() {
  const { has } = useSession();
  const t = useT();
  const hint = useId();
  const { data, error, reload } = useLoad(() => get<any>('/projects'));
  const [form, setForm] = useState({ code: '', name: '' });
  const create = async () => {
    const p = await post<{ code: string }>('/projects', form);
    setForm({ code: '', name: '' }); reload();
    return t('proj.created', { code: p.code });
  };
  return (
    <>
      <h1>{t('nav.projects')}</h1>
      <ErrorLine error={error} />
      {data && <ScopeNote scoped={data.scoped} />}
      {data && <DataTable<Row> rows={data.projects} {...projectList({ t, rows: data.projects })} />}
      <div className="card" style={{ marginTop: 16, maxWidth: 520 }}>
        <h2>{t('proj.new')}</h2>
        {has('projects.manage') ? (
          <SubmitForm submitLabel={t('proj.create')} onSubmit={create}>
            {/* The API takes lowercase only, so the field writes what it will accept. */}
            <label>{t('field.code')}<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toLowerCase() })} pattern="[a-z0-9][a-z0-9\-]{1,31}" aria-describedby={hint} required /></label>
            <p id={hint} className="small muted">{t('proj.code_hint')}</p>
            <label>{t('field.name')}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          </SubmitForm>
        ) : <NeedsPermission permission="projects.manage" />}
      </div>
    </>
  );
}
