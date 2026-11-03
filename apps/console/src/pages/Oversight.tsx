import { useState } from 'react';
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { get, post, put } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, ConfirmedAction, Empty, ErrorLine, NeedsPermission, Pill, ScopeNote, Tag, When, useLoad } from '../components/common';
import { DataTable, SummaryGrid, type Column, type DataTableProps, type RowAction } from '../components/table/DataTable';
import { chip, fetchPage, periodFilter, useAdministrators, useReload } from './list-support';
import { pct } from '../lib/format';

/** Oversight (console spec 10): alerts, health, reporting, export verification, administrators, roles, audit and authentication history. */
export function OversightPage() {
  const { has } = useSession();
  const tabs = [
    ['alerts', 'Alerts', has('oversight.alerts.read')], ['health', 'Health', has('oversight.reports')], ['reports', 'Reporting', has('oversight.reports')], ['exports', 'Export verification', has('oversight.verify_export')],
    ['administrators', 'Administrators', has('admin.administrators')], ['roles', 'Roles', has('admin.roles')], ['audit', 'Audit', has('oversight.audit')], ['auth-history', 'Authentication history', has('oversight.auth_history')],
  ] as const;
  return (
    <>
      <h1>Oversight</h1>
      <div className="tabs">{tabs.filter((t) => t[2]).map(([k, label]) => <NavLink key={k} to={`/oversight/${k}`}>{label}</NavLink>)}</div>
      <Routes>
        <Route path="alerts" element={<Alerts />} /><Route path="alerts/:id" element={<AlertDetail />} /><Route path="health" element={<Health />} /><Route path="reports" element={<Reports />} />
        <Route path="exports" element={<Exports />} /><Route path="administrators" element={<Administrators />} /><Route path="roles" element={<Roles />} /><Route path="roles/:id" element={<Roles />} />
        <Route path="audit" element={<Audit />} /><Route path="auth-history" element={<AuthHistory />} /><Route path="*" element={<Alerts />} />
      </Routes>
    </>
  );
}

type Row = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;
type Lists = Pick<DataTableProps<Row>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'defaultOrder' | 'empty'>;
const ALERT_CATEGORIES = ['treasury', 'service_health', 'reconciliation', 'security'];

export function exportList({ t }: { t: Tr }): Lists {
  const columns: Column<Row>[] = [
    { key: 'id', label: t('col.export_reference'), mono: true, render: (x) => x.id },
    { key: 'subject', label: t('col.subject'), render: (x) => x.subject },
    { key: 'by', label: t('col.requested_by'), render: (x) => x.requested_by },
    { key: 'rows', label: t('col.rows'), align: 'end', render: (x) => x.row_count },
    { key: 'created', label: t('col.created'), sortKey: 'created', render: (x) => <When value={x.created_at} /> },
  ];
  const summary = (x: Row) => (
    <SummaryGrid items={[
      { label: t('l.filters_recorded'), value: <code className="small">{JSON.stringify(x.filters)}</code> },
      { label: t('l.environment'), value: x.environment },
      { label: t('l.signature'), value: <span className="mono small">{x.signature}</span> },
    ]} />
  );
  return { columns, filters: [...chip<Row>('subject', t('col.subject'), ['transactions', 'report']), periodFilter<Row>(t)], summary, rowKey: (x) => x.id, defaultSort: 'created', defaultOrder: 'desc', empty: { none: t('l.export_none'), why: t('l.export_why') } };
}

export function alertList({ t, has, reload }: { t: Tr; has: (p: string) => boolean; reload: () => void }): Lists {
  const columns: Column<Row>[] = [
    { key: 'severity', label: t('col.severity'), sortKey: 'severity', render: (a) => <Pill value={a.severity} /> },
    { key: 'title', label: t('col.title'), render: (a) => <Link to={`/oversight/alerts/${a.id}`}>{a.title}</Link> },
    { key: 'subject', label: t('col.subject'), render: (a) => <span className="small">{a.subject_type} {a.subject_reference}</span> },
    { key: 'raised', label: t('col.raised'), sortKey: 'raised', render: (a) => <When value={a.raised_at} /> },
    { key: 'occurrences', label: t('col.occurrences'), align: 'end', render: (a) => a.occurrence_count },
    { key: 'status', label: t('col.status'), render: (a) => <Pill value={a.status} /> },
  ];
  const actions: RowAction<Row>[] = [
    { label: t('table.open'), primary: true, to: (a) => `/oversight/alerts/${a.id}` },
    { label: t('l.acknowledge'), when: (a) => a.status === 'open' && has('oversight.alerts.acknowledge'), run: async (a) => { await post(`/oversight/alerts/${a.id}/acknowledge`); reload(); } },
    { label: t('l.act'), when: (a) => !!a.action_reference, to: (a) => a.action_reference },
  ];
  const summary = (a: Row) => (
    <SummaryGrid items={[
      { label: t('l.category'), value: a.category.replace(/_/g, ' ') },
      { label: t('l.last_seen'), value: <When value={a.last_seen_at} /> },
      { label: t('l.acknowledged_at'), value: a.acknowledged_at ? <When value={a.acknowledged_at} /> : '—' },
      { label: t('l.addresses'), value: a.action_reference ? <Link to={a.action_reference}>{a.action_reference}</Link> : '—' },
    ]} />
  );
  return {
    columns, actions, summary, rowKey: (a) => a.id, defaultSort: 'raised', defaultOrder: 'desc',
    filters: [...chip<Row>('status', t('col.status'), ['open', 'acknowledged', 'cleared']), ...chip<Row>('severity', t('col.severity'), ['informational', 'warning', 'critical']), ...chip<Row>('category', t('l.category'), ALERT_CATEGORIES), periodFilter<Row>(t)],
    empty: { none: t('l.alert_none'), why: t('l.alert_why') },
  };
}

function Alerts() {
  const t = useT();
  const { has } = useSession();
  const [rev, reload] = useReload();
  return <DataTable<Row> key={rev} search={false} {...alertList({ t, has, reload })} fetch={fetchPage<Row>('/oversight/alerts', { period: 'after' })} />;
}

export function alertDeliveryList({ t }: { t: Tr }): Lists {
  const columns: Column<Row>[] = [
    { key: 'sent', label: t('col.sent'), sortKey: 'sent', render: (d) => <When value={d.sent_at} /> },
    { key: 'kind', label: t('col.kind'), render: (d) => d.kind },
    { key: 'to', label: t('col.recipient'), render: (d) => `${d.channel} ${d.address}` },
    { key: 'status', label: t('col.status'), render: (d) => <Pill value={d.status} /> },
  ];
  const summary = (d: Row) => <SummaryGrid items={[{ label: t('l.response'), value: d.response || '—' }]} />;
  return { columns, filters: [], summary, rowKey: (d) => d.id, defaultSort: 'sent', defaultOrder: 'desc', empty: { none: t('l.alert_delivery_none'), why: t('l.alert_delivery_why') } };
}

function AlertDetail() {
  const { id } = useParams();
  const t = useT();
  const { data, error } = useLoad(() => get<any>(`/oversight/alerts/${id}`), [id]);
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  const a = data.alert;
  return (<div className="card"><h2>{a.title} <Pill value={a.severity} /> <Pill value={a.status} /></h2>
    <dl className="kv"><dt>Condition</dt><dd><pre>{JSON.stringify(a.detail, null, 2)}</pre></dd><dt>Occurrences</dt><dd>{a.occurrence_count} · first <When value={a.raised_at} /> · last <When value={a.last_seen_at} /></dd><dt>Acknowledged</dt><dd>{a.acknowledged_at ? <When value={a.acknowledged_at} /> : '—'}</dd><dt>Cleared</dt><dd>{a.cleared_at ? <When value={a.cleared_at} /> : '—'}</dd><dt>Addresses it</dt><dd><Link to={a.action_reference}>{a.action_reference}</Link></dd></dl>
    <h3>{t('l.deliveries')}</h3><DataTable<Row> search={false} {...alertDeliveryList({ t })} fetch={fetchPage<Row>(`/oversight/alerts/${id}/deliveries`)} /></div>);
}

function Health() {
  const { data, error } = useLoad(() => get<any>('/oversight/health'));
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  const table = (rows: any[], dim: string) => (rows.length === 0 ? <Empty /> : <table><thead><tr><th>{dim}</th><th className="num">Current hour</th><th className="num">Baseline (7 d)</th><th className="num">Sample</th><th /></tr></thead><tbody>{rows.map((m) => <tr key={m.key}><td className="small">{m.key}</td><td className={`num ${m.departed ? 'negative' : ''}`}>{pct(m.current)}</td><td className="num muted">{pct(m.baseline)}</td><td className="num">{m.sample}</td><td>{m.departed && <Link to={`/transactions?state=failed&${dim === 'project' ? 'project' : dim === 'route' ? '' : 'provider_account'}=${m.key}`}>departed → transactions</Link>}</td></tr>)}</tbody></table>);
  return (<div className="cards">
    <div className="card"><h2>Counters</h2><dl className="kv">{Object.entries(data.counters).map(([k, v]) => <><dt key={k}>{k.replace(/_/g, ' ')}</dt><dd key={`${k}v`}>{String(v)}</dd></>)}</dl></div>
    <div className="card"><h2>Success rate per route</h2>{table(data.success_rates.route, 'route')}</div>
    <div className="card"><h2>Success rate per provider account</h2>{table(data.success_rates.provider_account, 'provider_account')}</div>
    <div className="card"><h2>Success rate per project</h2>{table(data.success_rates.project, 'project')}</div>
    <div className="card"><h2>Failure reasons</h2>{data.failure_reasons.length === 0 ? <Empty /> : <table><thead><tr><th>Reason</th><th className="num">Last hour</th><th className="num">Baseline per hour</th></tr></thead><tbody>{data.failure_reasons.map((r: any) => <tr key={r.reason}><td>{r.reason}</td><td className="num">{r.recent}</td><td className="num muted">{r.baseline_per_hour}</td></tr>)}</tbody></table>}</div>
  </div>);
}

function Reports() {
  const { has } = useSession();
  const [rows, setRows] = useState('country');
  const [cols, setCols] = useState('none');
  const qs = `rows=${rows}&cols=${cols}`;
  const { data, error } = useLoad(() => get<any>(`/oversight/reports?${qs}`), [qs]);
  return (<>
    <div className="filters">
      <select value={rows} onChange={(e) => setRows(e.target.value)}>{['project', 'direction', 'country', 'payment_method', 'provider_account', 'currency', 'day', 'month'].map((r) => <option key={r} value={r}>rows: {r.replace(/_/g, ' ')}</option>)}</select>
      <select value={cols} onChange={(e) => setCols(e.target.value)}><option value="none">columns: none</option><option value="direction">columns: direction</option><option value="currency">columns: currency</option></select>
      {has('oversight.export') && <button onClick={async () => { const r = await get<{ csv: string; export_id: string }>(`/oversight/reports/export?${qs}`); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })); a.download = `report-${r.export_id}.csv`; a.click(); }}>Export CSV</button>}
    </div>
    <p className="small muted">Last 30 days. Figures read the terms recorded on each transaction. Margin is processing fees less actual provider fees; platform revenue is reported alongside, not within it.</p>
    <ErrorLine error={error} />
    {data && <ScopeNote scoped={data.scoped} />}
    {data && (data.data.length === 0 ? <Empty /> : <table><thead><tr><th>{rows}</th>{cols !== 'none' && <th>{cols}</th>}<th>Currency</th><th className="num">Volume</th><th className="num">Value</th><th className="num">Success</th><th className="num">Processing fees</th><th className="num">Provider fees</th><th className="num">Margin</th><th className="num">Platform revenue</th><th className="num">Refunds</th></tr></thead>
      <tbody>{data.data.map((r: any, i: number) => <tr key={i}><td>{r.row_key}</td>{cols !== 'none' && <td>{r.col_key}</td>}<td>{r.currency}</td><td className="num">{r.volume}</td><td className="num"><Amount minor={r.value} currency={r.currency} /></td><td className="num">{pct(r.success_rate)}</td><td className="num"><Amount minor={r.processing_fees} currency={r.currency} /></td><td className="num"><Amount minor={r.provider_fees} currency={r.currency} /></td><td className={`num ${r.negative_margin ? 'negative' : ''}`}><Amount minor={r.margin} currency={r.currency} /></td><td className="num"><Amount minor={r.platform_revenue} currency={r.currency} /></td><td className="num">{r.refunds}</td></tr>)}</tbody></table>)}
  </>);
}

function Exports() {
  const [exportId, setExportId] = useState('');
  const [content, setContent] = useState('');
  const [result, setResult] = useState<any>(null);
  const t = useT();
  return (<>
  <div className="grid2">
    <div className="card"><h2>Verify an export</h2>
      <form className="stack" onSubmit={async (e) => { e.preventDefault(); setResult(await post('/oversight/exports/verify', { export_id: exportId || undefined, content: content || undefined })); }}>
        <label>Export record identifier<input value={exportId} onChange={(e) => setExportId(e.target.value)} placeholder="or upload the file" /></label>
        <label>File<input type="file" accept=".csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then(setContent); }} /></label>
        <button className="primary">Verify</button>
      </form>
      {result && (result.known ? <div className="warnbox">Produced by <b>{result.record.requested_by}</b> on <When value={result.record.at} /> in <b>{result.record.environment}</b>, subject {result.record.subject}, {result.record.row_count} rows, filters <code>{JSON.stringify(result.record.filters)}</code>.{result.rows_unchanged === null ? ' Upload the file to check the rows.' : result.rows_unchanged ? <b className="ok"> Rows unchanged since.</b> : <b className="negative"> Rows differ from what was produced.</b>}</div> : <p className="error">No export matches.</p>)}
    </div>
  </div>
  <div className="card"><h2>{t('l.export_history')}</h2><DataTable<Row> {...exportList({ t })} searchLabel={t('l.search_export')} fetch={fetchPage<Row>('/oversight/exports', { period: 'after' })} /></div>
  </>);
}

function Administrators() {
  const { me } = useSession();
  const { data, error, reload } = useLoad(() => get<any>('/oversight/administrators'));
  const roles = useLoad(() => get<any>('/oversight/roles').catch(() => null));
  const [form, setForm] = useState({ name: '', email: '', password: '', language: 'en' });
  const [assign, setAssign] = useState({ administrator_id: '', role_id: '', scope_type: 'all' });
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  return (<>
    <table><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Roles and scope</th><th>Language</th><th>Last sign-in</th><th /></tr></thead>
      <tbody>{data.administrators.map((a: any) => <tr key={a.id}><td>{a.name}{a.id === me?.administrator.id && <span className="small muted"> (you)</span>}</td><td>{a.email}</td><td><Pill value={a.status} />{!a.totp_enrolled_at && <span className="small muted"> · no authenticator</span>}{a.locked_until && new Date(a.locked_until) > new Date() && <Tag family="refused">locked</Tag>}</td>
        <td>{a.assignments.map((x: any) => <div key={x.id}>{x.role_name} <span className="small muted">{x.scope_type}{x.scopes.length ? `: ${x.scopes.map((s: any) => (s.project_id ?? s.provider_account_id).slice(0, 8)).join(', ')}` : ''}</span> {a.id !== me?.administrator.id && <ConfirmedAction operationType="role.change" values={{ kind: 'assignment_remove', assignment_id: x.id }} path="/oversight/roles/changes" label="×" onDone={reload} />}</div>)}</td>
        <td>{a.language}</td><td><When value={a.last_sign_in_at} /></td>
        <td>{a.id === me?.administrator.id ? <span className="small muted">You cannot alter your own status or roles.</span> : <ConfirmedAction operationType="administrator.amend" values={{ id: a.id, status: a.status === 'active' ? 'disabled' : 'active' }} path={`/oversight/administrators/${a.id}`} method="PATCH" label={a.status === 'active' ? 'Disable' : 'Enable'} onDone={reload} />}</td></tr>)}</tbody></table>
    <div className="grid2" style={{ marginTop: 16 }}>
      <div className="card"><h2>New administrator</h2>
        <ConfirmedAction operationType="administrator.create" values={{ name: form.name, email: form.email, language: form.language, password: form.password }} path="/oversight/administrators" label="Create" disabled={!form.name || !form.email || form.password.length < 12} onDone={() => { setForm({ name: '', email: '', password: '', language: 'en' }); reload(); }}
          summary={<div className="stack" style={{ display: 'grid', gap: 6 }}><input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><input placeholder="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /><input placeholder="initial password (12+ characters)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /><select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}><option value="en">English</option><option value="fr">Français</option></select></div>} />
      </div>
      <div className="card"><h2>Assign a role</h2>
        <ConfirmedAction operationType="role.change" values={{ kind: 'assignment_add', ...assign }} path="/oversight/roles/changes" label="Assign" disabled={!assign.administrator_id || !assign.role_id} onDone={reload}
          summary={<div className="row"><select value={assign.administrator_id} onChange={(e) => setAssign({ ...assign, administrator_id: e.target.value })}><option value="">administrator</option>{data.administrators.filter((a: any) => a.id !== me?.administrator.id).map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select><select value={assign.role_id} onChange={(e) => setAssign({ ...assign, role_id: e.target.value })}><option value="">role</option>{(roles.data?.roles ?? []).map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select><select value={assign.scope_type} onChange={(e) => setAssign({ ...assign, scope_type: e.target.value })}><option value="all">scope: all</option></select></div>} />
        <p className="small muted">Assignments carrying treasury or administration permissions go to a second approver.</p>
      </div>
    </div>
  </>);
}

function Roles() {
  const { data, error, reload } = useLoad(() => get<any>('/oversight/roles'));
  const [editing, setEditing] = useState<any>(null);
  const [impact, setImpact] = useState<any>(null);
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  const domains = [...new Set(Object.keys(data.permissions).map((k) => k.split('.')[0]))];
  return (<div className="grid2">
    <div><table><thead><tr><th>Role</th><th>Description</th><th className="num">Permissions</th><th>Administrators</th><th /></tr></thead>
      <tbody>{data.roles.map((r: any) => <tr key={r.id}><td>{r.name}{r.seeded && <span className="small muted"> (seeded)</span>}</td><td className="small">{r.description}</td><td className="num">{r.permissions.length}</td><td className="small">{r.administrators.map((a: any) => a.name).join(', ') || '—'}</td><td><button onClick={() => { setEditing({ kind: 'role_permissions', role_id: r.id, name: r.name, description: r.description, permissions: [...r.permissions] }); setImpact(null); }}>Edit</button></td></tr>)}</tbody></table>
      <button style={{ marginTop: 8 }} onClick={() => setEditing({ kind: 'role_permissions', name: '', description: '', permissions: [] })}>New role</button></div>
    {editing && <div className="card">
      <h2>{editing.role_id ? `Edit ${editing.name}` : 'New role'}</h2>
      <input placeholder="name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /> <input placeholder="description" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} style={{ width: 300 }} />
      {domains.map((d) => <div key={d}><h3>{d}</h3>{Object.entries(data.permissions).filter(([k]) => k.startsWith(`${d}.`)).map(([k, desc]) => <label key={k} className="row"><input type="checkbox" checked={editing.permissions.includes(k)} onChange={(e) => setEditing({ ...editing, permissions: e.target.checked ? [...editing.permissions, k] : editing.permissions.filter((p: string) => p !== k) })} /> <span>{desc as string} <span className="small muted">{k}</span></span></label>)}</div>)}
      <div className="row" style={{ marginTop: 8 }}><button onClick={async () => setImpact(await post('/oversight/roles/impact', editing))}>Show who this affects</button><button onClick={() => setEditing(null)}>Cancel</button></div>
      {impact && <div className="warnbox">{impact.granted?.length ? <p>Grants: {impact.granted.join(', ')}</p> : null}{impact.removed?.length ? <p>Removes: {impact.removed.join(', ')}</p> : null}<p>Affects: {impact.administrators?.map((a: any) => a.name).join(', ') || 'nobody yet'}</p>{impact.requires_approval && <p className="small">Carries treasury or administration permissions: a second approver is required.</p>}
        <ConfirmedAction operationType="role.change" values={editing} path="/oversight/roles/changes" label="Commit" onDone={() => { setEditing(null); setImpact(null); reload(); }} /></div>}
    </div>}
  </div>);
}

export function auditList({ t, admins }: { t: Tr; admins: { id: string; name: string }[] }): Lists {
  const columns: Column<Row>[] = [
    { key: 'when', label: t('col.when'), sortKey: 'when', render: (r) => <When value={r.occurred_at} /> },
    { key: 'actor', label: t('col.actor'), render: (r) => r.actor_name ?? <span className="muted">{t('l.system')}</span> },
    { key: 'action', label: t('col.action'), render: (r) => r.action },
    { key: 'subject', label: t('col.subject'), render: (r) => <span className="small">{r.subject_type} {r.subject_id}</span> },
  ];
  const diff = (v: unknown) => <pre className="small" style={{ maxWidth: 360, maxHeight: 160 }}>{v ? JSON.stringify(v, null, 1) : '—'}</pre>;
  const summary = (r: Row) => (
    <SummaryGrid items={[
      { label: t('l.before'), value: diff(r.prior_state) },
      { label: t('l.after'), value: diff(r.new_state) },
      { label: t('l.approver'), value: r.approver_name ?? '—' },
    ]} />
  );
  return {
    columns, summary, rowKey: (r) => String(r.id), defaultSort: 'when', defaultOrder: 'desc',
    filters: [...chip<Row>('actor', t('col.actor'), admins.map((a) => ({ value: a.id, label: a.name }))), ...chip<Row>('subject_type', t('l.subject_type'), AUDIT_SUBJECTS), periodFilter<Row>(t)],
    empty: { none: t('l.audit_none'), why: t('l.audit_why') },
  };
}
const AUDIT_SUBJECTS = ['transaction', 'project', 'project_credential', 'operation_confirmation', 'discrepancy', 'float_account', 'provider_account', 'administrator', 'role', 'ledger_entry', 'float_transfer', 'approval_request', 'reconciliation_run', 'payer', 'entitlement', 'country', 'cashout', 'route', 'payment_method', 'currency', 'alert_policy', 'alert_group', 'adjustment'];

function Audit() {
  const t = useT();
  const admins = useAdministrators();
  return <DataTable<Row> key={admins.length} search={false} {...auditList({ t, admins })} fetch={fetchPage<Row>('/oversight/audit', { period: 'after' })} />;
}

export function authHistoryList({ t, admins }: { t: Tr; admins: { id: string; name: string }[] }): Lists {
  const columns: Column<Row>[] = [
    { key: 'when', label: t('col.when'), sortKey: 'when', render: (e) => <When value={e.occurred_at} /> },
    { key: 'administrator', label: t('col.administrator'), render: (e) => <>{e.email_presented}{!e.administrator_id && <span className="small muted"> ({t('l.no_such_admin')})</span>}</> },
    { key: 'event', label: t('col.event'), render: (e) => e.reason || '—' },
    { key: 'outcome', label: t('col.outcome'), render: (e) => <Pill value={e.outcome === 'success' ? 'succeeded' : e.outcome === 'locked' ? 'critical' : 'failed'} /> },
    { key: 'address', label: t('col.address'), mono: true, render: (e) => e.origin_address },
  ];
  const summary = (e: Row) => <SummaryGrid items={[{ label: t('l.client'), value: e.client_description || '—' }, { label: t('col.outcome'), value: e.outcome.replace(/_/g, ' ') }]} />;
  return {
    columns, summary, rowKey: (e) => String(e.id), defaultSort: 'when', defaultOrder: 'desc',
    filters: [...chip<Row>('administrator', t('col.administrator'), admins.map((a) => ({ value: a.id, label: a.name }))), ...chip<Row>('outcome', t('col.outcome'), ['success', 'failure', 'locked', 'second_factor_failure']), periodFilter<Row>(t)],
    empty: { none: t('l.auth_none'), why: t('l.auth_why') },
  };
}

function AuthHistory() {
  const t = useT();
  const admins = useAdministrators();
  return <DataTable<Row> key={admins.length} search={false} {...authHistoryList({ t, admins })} fetch={fetchPage<Row>('/oversight/authentication-history', { period: 'after' })} />;
}

export { put as _put };
