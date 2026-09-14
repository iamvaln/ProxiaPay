import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { useSession } from '../lib/session';
import { Amount, Empty, ErrorLine, NeedsPermission, Pill, ScopeNote, useLoad } from '../components/common';

export function ProjectsPage() {
  const { has } = useSession();
  const { data, error, reload } = useLoad(() => get<any>('/projects'));
  const [form, setForm] = useState({ code: '', name: '' });
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <h1>Projects</h1>
      <ErrorLine error={error} />
      {data && <ScopeNote scoped={data.scoped} />}
      {data && (data.projects.length === 0 ? <Empty text="No project yet. Create one, issue it a credential and grant it routes." /> : (
        <table><thead><tr><th>Name</th><th>Status</th><th className="num">Transactions (30 d)</th><th className="num">Value (30 d)</th><th>Balances</th><th className="num">Routes</th></tr></thead>
          <tbody>{data.projects.map((p: any) => <tr key={p.id}><td><Link to={`/projects/${p.id}`}>{p.name}</Link><br /><span className="small muted">{p.code}</span></td><td><Pill value={p.status} /></td><td className="num">{p.volume_30d}</td><td className="num">{p.value_30d}</td><td>{p.balances.map((b: any) => <div key={b.currency}><Amount minor={b.available} currency={b.currency} /> <span className="small muted">(+<Amount minor={b.reserved} currency={b.currency} /> reserved)</span></div>)}</td><td className="num">{p.routes_granted}</td></tr>)}</tbody></table>
      ))}
      <div className="card" style={{ marginTop: 16, maxWidth: 520 }}>
        <h2>New project</h2>
        {has('projects.manage') ? (
          <form className="stack" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await post('/projects', form); setForm({ code: '', name: '' }); reload(); } catch (x) { setErr((x as Error).message); } }}>
            <label>Code<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} pattern="[a-z0-9][a-z0-9-]{1,31}" required /></label>
            <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
            <ErrorLine error={err} />
            <button className="primary">Create</button>
          </form>
        ) : <NeedsPermission permission="projects.manage" />}
      </div>
    </>
  );
}
