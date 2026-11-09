import { useState } from 'react';
import { get, post, put } from '../lib/api';
import { useT } from '../lib/session';
import { ErrorLine, Pill, SubmitForm, useLoad } from '../components/common';
import { DataTable, type Column, type DataTableProps } from '../components/table/DataTable';

type Row = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;
type Project = { id: string; name: string; code: string };
const PROFILES = ['developer', 'finance'] as const;

/** The owner's team. An owner's row has no action: ProxiaPay changes an owner's access, and an owner never edits their own. */
export function teamList({ t, edit, reload }: { t: Tr; edit: (m: Row) => void; reload: () => void }): Pick<DataTableProps<Row>, 'columns' | 'filters' | 'actions' | 'rowKey' | 'defaultSort' | 'empty'> {
  const columns: Column<Row>[] = [
    { key: 'name', label: t('col.name'), text: (m) => m.name, sortValue: (m) => m.name, render: (m) => m.name },
    { key: 'email', label: t('col.email'), text: (m) => m.email, render: (m) => m.email },
    { key: 'profile', label: t('col.profile'), text: (m) => m.profile ?? '', render: (m) => (m.profile ? t(`team.${m.profile}`) : '—') },
    { key: 'status', label: t('col.status'), render: (m) => <Pill value={m.status} /> },
    { key: 'invitation', label: t('col.invitation'), render: (m) => t(`inv.${m.invitation}`) },
  ];
  const editable = (m: Row) => m.profile !== 'owner';
  const write = async (m: Row, path: string, body: object = {}) => { await post(`/team/${m.membership_id}${path}`, body); reload(); };
  return {
    columns, rowKey: (m) => m.membership_id, defaultSort: 'name',
    filters: [],
    actions: [
      { label: t('team.change_access'), when: editable, run: edit },
      { label: t('team.disable'), when: (m) => editable(m) && m.status === 'active', run: (m) => write(m, '/status', { status: 'disabled' }) },
      { label: t('team.enable'), when: (m) => editable(m) && m.status === 'disabled', run: (m) => write(m, '/status', { status: 'active' }) },
      { label: t('team.resend'), when: (m) => editable(m) && m.invitation !== 'accepted', run: (m) => write(m, '/resend') },
    ],
    empty: { none: t('team.none'), why: t('team.none_why') },
  };
}

/** A profile and a project selection, the same two controls to invite and to change access. */
function AccessFields({ profile, setProfile, projectIds, setProjectIds, projects, name }: { profile: string; setProfile: (p: string) => void; projectIds: string[]; setProjectIds: (ids: string[]) => void; projects: Project[]; name: string }) {
  const t = useT();
  const toggle = (id: string) => setProjectIds(projectIds.includes(id) ? projectIds.filter((p) => p !== id) : [...projectIds, id]);
  return (
    <>
      <fieldset><legend>{t('team.profile')}</legend>
        <div className="row">{PROFILES.map((p) => <label key={p} className="row"><input type="radio" name={`${name}-profile`} checked={profile === p} onChange={() => setProfile(p)} /> {t(`team.${p}`)}</label>)}</div>
      </fieldset>
      <fieldset><legend>{t('team.projects')}</legend>
        {projects.length ? <div className="row">{projects.map((p) => <label key={p.id} className="row"><input type="checkbox" checked={projectIds.includes(p.id)} onChange={() => toggle(p.id)} /> {p.name}</label>)}</div> : <p className="small muted">{t('team.no_projects')}</p>}
      </fieldset>
    </>
  );
}

export function TeamPage() {
  const t = useT();
  const { data, error, reload } = useLoad(() => get<{ members: Row[] }>('/team'));
  const projects = useLoad(() => get<{ projects: Project[] }>('/projects'));
  const list = projects.data?.projects ?? [];
  const [invite, setInvite] = useState({ name: '', email: '', profile: 'developer', project_ids: [] as string[] });
  const [editing, setEditing] = useState<{ id: string; name: string; profile: string; project_ids: string[] } | null>(null);
  const send = async () => {
    await post('/team', invite);
    setInvite({ name: '', email: '', profile: 'developer', project_ids: [] }); reload();
    // Worded by the console, not by the answer: nothing on screen says whether the address was known.
    return t('team.sent');
  };
  const save = async () => {
    await put(`/team/${editing!.id}`, { profile: editing!.profile, project_ids: editing!.project_ids });
    reload(); setEditing(null);
    return t('team.saved');
  };
  return (
    <>
      <h1>{t('team.title')}</h1>
      <ErrorLine error={error} />
      {data && <DataTable<Row> rows={data.members} {...teamList({ t, reload, edit: (m) => setEditing({ id: m.membership_id, name: m.name, profile: m.profile ?? 'developer', project_ids: m.project_ids }) })} />}
      <p className="small muted">{t('team.owner_note')}</p>
      {editing && (
        <section className="card" aria-label={t('team.change_access')} style={{ marginTop: 16, maxWidth: 520 }}>
          <h2>{t('team.change_access')}: {editing.name}</h2>
          <SubmitForm submitLabel={t('team.save')} onSubmit={save}>
            <AccessFields name="edit" profile={editing.profile} setProfile={(profile) => setEditing({ ...editing, profile })} projectIds={editing.project_ids} setProjectIds={(project_ids) => setEditing({ ...editing, project_ids })} projects={list} />
          </SubmitForm>
          <button type="button" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
        </section>
      )}
      <div className="card" style={{ marginTop: 16, maxWidth: 520 }}>
        <h2>{t('team.invite')}</h2>
        <SubmitForm submitLabel={t('team.send')} onSubmit={send}>
          <label>{t('field.name')}<input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} required /></label>
          <label>{t('field.email')}<input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} required /></label>
          <AccessFields name="invite" profile={invite.profile} setProfile={(profile) => setInvite({ ...invite, profile })} projectIds={invite.project_ids} setProjectIds={(project_ids) => setInvite({ ...invite, project_ids })} projects={list} />
        </SubmitForm>
      </div>
    </>
  );
}
