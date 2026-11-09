import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get } from '../lib/api';
import { useT } from '../lib/session';
import { ConfirmedAction, Empty, ErrorLine, Pill, When, useLoad } from '../components/common';
import { DataTable, type Column, type DataTableProps } from '../components/table/DataTable';

type Row = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;

/** A language choice, for the person an invitation is written to. */
function LanguageSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  return <label>{t('field.language')}<select value={value} onChange={(e) => onChange(e.target.value)}>{['en', 'fr'].map((l) => <option key={l} value={l}>{t(`lang.${l}`)}</option>)}</select></label>;
}

export function clientList({ t }: { t: Tr }): Pick<DataTableProps<Row>, 'columns' | 'actions' | 'rowKey' | 'defaultSort' | 'empty' | 'filters'> {
  const columns: Column<Row>[] = [
    { key: 'name', label: t('col.name'), text: (c) => c.name, sortValue: (c) => c.name, render: (c) => <Link to={`/oversight/clients/${c.id}`}>{c.name}</Link> },
    { key: 'status', label: t('col.status'), text: (c) => c.status, render: (c) => <Pill value={c.status} /> },
    { key: 'members', label: t('cl.members'), align: 'end', sortValue: (c) => c.members, render: (c) => c.members },
    { key: 'projects', label: t('cl.projects'), align: 'end', sortValue: (c) => c.projects, render: (c) => c.projects },
    { key: 'created', label: t('col.created'), sortValue: (c) => Date.parse(c.created_at), render: (c) => <When value={c.created_at} /> },
  ];
  return {
    columns, rowKey: (c) => c.id, defaultSort: 'name', filters: [],
    actions: [{ label: t('table.open'), primary: true, to: (c) => `/oversight/clients/${c.id}` }],
    empty: { none: t('cl.none'), why: t('cl.none_why') },
  };
}

/** Oversight, Clients: every client, and the form that creates one together with its first owner's invitation. */
export function Clients() {
  const t = useT();
  const { data, error, reload } = useLoad(() => get<{ clients: Row[] }>('/oversight/clients'));
  const [form, setForm] = useState({ name: '', owner_name: '', owner_email: '', language: 'en' });
  const filled = !!form.name.trim() && !!form.owner_name.trim() && form.owner_email.includes('@');
  return (
    <>
      <ErrorLine error={error} />
      {data && <DataTable<Row> rows={data.clients} {...clientList({ t })} />}
      <div className="card" style={{ marginTop: 16, maxWidth: 520 }}>
        <h2>{t('cl.new')}</h2>
        <div className="stack">
          <label>{t('field.client')}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>{t('field.owner_name')}<input value={form.owner_name} onChange={(e) => setForm({ ...form, owner_name: e.target.value })} /></label>
          <label>{t('field.owner_email')}<input type="email" value={form.owner_email} onChange={(e) => setForm({ ...form, owner_email: e.target.value })} /></label>
          <LanguageSelect value={form.language} onChange={(language) => setForm({ ...form, language })} />
          <ConfirmedAction operationType="client.create" values={form} path="/oversight/clients" label={t('cl.create')} disabled={!filled} done={() => t('cl.created')}
            onDone={() => { setForm({ name: '', owner_name: '', owner_email: '', language: form.language }); reload(); }} />
        </div>
      </div>
    </>
  );
}

/** A client with its members, its projects, its status and the form to invite another owner. */
export function ClientDetail() {
  const { id } = useParams();
  return <ClientView key={id} id={id!} />;
}

function ClientView({ id }: { id: string }) {
  const t = useT();
  const { data, error, reload } = useLoad(() => get<Row>(`/oversight/clients/${id}`), [id]);
  const [owner, setOwner] = useState({ name: '', email: '', language: 'en' });
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  const base = `/oversight/clients/${id}`;
  const next = data.status === 'active' ? 'disabled' : 'active';
  const columns: Column<Row>[] = [
    { key: 'name', label: t('col.name'), text: (m) => m.name, sortValue: (m) => m.name, render: (m) => m.name },
    { key: 'email', label: t('col.email'), text: (m) => m.email, render: (m) => m.email },
    { key: 'profile', label: t('col.profile'), render: (m) => (m.profile ? t(`team.${m.profile}`) : '—') },
    { key: 'status', label: t('col.status'), render: (m) => <Pill value={m.status} /> },
    { key: 'invitation', label: t('col.invitation'), render: (m) => t(`inv.${m.invitation}`) },
    // Code-confirmed components cannot be row actions, so they sit in a cell of their own, as the credential rotation does.
    { key: 'actions', label: t('table.actions'), render: (m) => (
      <div className="row">
        <ConfirmedAction operationType="membership.status" values={{ membership_id: m.membership_id, status: m.status === 'disabled' ? 'active' : 'disabled' }} path={`${base}/memberships/${m.membership_id}/status`} label={m.status === 'disabled' ? t('team.enable') : t('team.disable')} onDone={reload} />
        {m.invitation !== 'accepted' && <ConfirmedAction operationType="membership.resend" values={{ membership_id: m.membership_id }} path={`${base}/memberships/${m.membership_id}/resend`} label={t('team.resend')} onDone={reload} />}
        <ConfirmedAction operationType="administrator.disable" values={{ administrator_id: m.administrator_id }} path={`${base}/accounts/${m.administrator_id}/disable`} label={t('cl.disable_account')} onDone={reload} />
      </div>
    ) },
  ];
  return (
    <>
      <p className="small"><Link to="/oversight/clients">{t('cl.back')}</Link></p>
      <h2>{data.name} <Pill value={data.status} /></h2>
      <ConfirmedAction operationType="client.status" values={{ client_id: id, status: next }} path={`${base}/status`} label={data.status === 'active' ? t('cl.disable') : t('cl.enable')} onDone={reload} />
      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('cl.members')}</h2>
        <DataTable<Row> bare rows={data.members} rowKey={(m) => m.membership_id} defaultSort="name" columns={columns} empty={{ none: t('team.none'), why: '' }} />
      </div>
      <div className="card">
        <h2>{t('cl.projects')}</h2>
        {data.projects.length ? <ul className="stack">{data.projects.map((p: Row) => <li key={p.id}><Link to={`/projects/${p.id}`}>{p.name}</Link> <span className="small muted mono">{p.code}</span> <Pill value={p.status} /></li>)}</ul> : <Empty text={t('cl.project_none')} />}
      </div>
      <div className="card" style={{ maxWidth: 520 }}>
        <h2>{t('cl.invite_owner')}</h2>
        <div className="stack">
          <label>{t('field.name')}<input value={owner.name} onChange={(e) => setOwner({ ...owner, name: e.target.value })} /></label>
          <label>{t('field.email')}<input type="email" value={owner.email} onChange={(e) => setOwner({ ...owner, email: e.target.value })} /></label>
          <LanguageSelect value={owner.language} onChange={(language) => setOwner({ ...owner, language })} />
          <ConfirmedAction operationType="client.invite_owner" values={{ client_id: id, ...owner }} path={`${base}/owners`} label={t('cl.invite_owner_submit')} disabled={!owner.name.trim() || !owner.email.includes('@')} done={() => t('cl.invited')}
            onDone={() => { setOwner({ name: '', email: '', language: owner.language }); reload(); }} />
        </div>
      </div>
    </>
  );
}
