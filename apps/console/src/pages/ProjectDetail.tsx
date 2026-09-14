import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { del, get, post, put } from '../lib/api';
import { useSession } from '../lib/session';
import { Amount, ConfirmedAction, Empty, ErrorLine, NeedsPermission, Pill, When, useLoad } from '../components/common';

/** Project detail (console spec 6.2): credentials as a rotation sequence, origins with refusals, entitlements with overrides beside the route's own, notification endpoint. */
export function ProjectDetailPage() {
  const { id } = useParams();
  const { has } = useSession();
  const { data, error, reload } = useLoad(() => get<any>(`/projects/${id}`), [id]);
  const [origin, setOrigin] = useState({ cidr: '', description: '' });
  const [url, setUrl] = useState('');
  const [secretShown, setSecretShown] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [grant, setGrant] = useState<any>({ route_id: '', count_24h: 5000, value_24h: 20000000, count_30d: 100000, value_30d: 400000000, note: '', accept_shortfall: false });
  const routes = useLoad(() => get<{ routes: any[] }>('/configuration/routes'), []);
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  const p = data.project;
  const active = data.credentials.filter((c: any) => c.status === 'active');
  const primary = active.find((c: any) => c.role === 'primary');
  const secondary = active.find((c: any) => c.role === 'secondary');
  const stage = !primary ? 'none' : secondary ? 'both' : 'primary';
  return (
    <>
      <h1>{p.name} <Pill value={p.status} /></h1>
      <div className="grid2">
        <div className="card">
          <dl className="kv"><dt>Code</dt><dd>{p.code}</dd><dt>Created</dt><dd><When value={p.created_at} /></dd><dt>Balances</dt><dd>{data.balances.length ? data.balances.map((b: any) => <div key={b.currency}><Amount minor={b.available} currency={b.currency} /> available · <Amount minor={b.reserved} currency={b.currency} /> reserved</div>) : '—'}</dd></dl>
        </div>
        <div className="card" id="credentials">
          <h2>Credentials</h2>
          <p className="small muted">Rotation: <b className={stage === 'none' ? 'negative' : ''}>{stage === 'none' ? 'no working credential' : stage === 'primary' ? 'one primary; issue a secondary to begin a rotation' : 'primary and secondary both authenticate; promote the secondary, then delete the retired one'}</b></p>
          <table><thead><tr><th>Key</th><th>Role</th><th>Status</th><th>Issued</th><th /></tr></thead>
            <tbody>{data.credentials.map((c: any) => <tr key={c.id}><td className="small">{c.key}<br /><span className="muted">{c.scopes.join(', ')}</span></td><td><Pill value={c.role} /></td><td><Pill value={c.status} /></td><td><When value={c.issued_at} /></td><td>
              {c.status === 'active' && has('projects.credentials') && <div className="row">
                {c.role === 'secondary' && <ConfirmedAction operationType="credential.promote" values={{ credential_id: c.id }} path={`/projects/${id}/credentials/${c.id}/promote`} label="Promote" onDone={reload} />}
                {c.role === 'secondary' && active.length > 1 && <ConfirmedAction operationType="credential.delete" values={{ credential_id: c.id }} path={`/projects/${id}/credentials/${c.id}`} label="Delete" onDone={reload} />}
                {c.role === 'primary' && <button disabled title="The primary credential cannot be deleted; promote the secondary first.">Delete</button>}
                {active.length === 1 && c.role === 'secondary' && <button disabled title="A project keeps at least one credential.">Delete</button>}
                <ConfirmedAction operationType="credential.revoke" values={{ credential_id: c.id, reason: 'revoked from console' }} path={`/projects/${id}/credentials/${c.id}/revoke`} label="Revoke" onDone={reload} />
              </div>}
            </td></tr>)}</tbody></table>
          {has('projects.credentials') ? (active.length < 2 && <ConfirmedAction operationType="credential.issue" values={{ project_id: id, scopes: ['collection', 'disbursement', 'read'] }} path={`/projects/${id}/credentials`} label={primary ? 'Issue secondary credential' : 'Issue credential'} onDone={(r: any) => { setSecretShown(`${r.key}\n${r.secret}`); reload(); }} />) : <NeedsPermission permission="projects.credentials" />}
          {secretShown && <div className="warnbox">The secret appears once, now. Copy it.<pre>{secretShown}</pre></div>}
        </div>
      </div>
      <div className="grid2">
        <div className="card" id="origins">
          <h2>Declared origins</h2>
          {data.origins.length === 0 ? <Empty text="No origin declared. Production requires at least one; sandbox does not." /> : <table><tbody>{data.origins.map((o: any) => <tr key={o.id}><td>{o.cidr}</td><td className="muted">{o.description}</td><td>{has('projects.origins') && <button onClick={async () => { await del(`/projects/${id}/origins/${o.id}`); reload(); }}>Remove</button>}</td></tr>)}</tbody></table>}
          {has('projects.origins') && <form className="row" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await post(`/projects/${id}/origins`, origin); setOrigin({ cidr: '', description: '' }); reload(); } catch (x) { setErr((x as Error).message); } }}>
            <input placeholder="10.0.0.0/8" value={origin.cidr} onChange={(e) => setOrigin({ ...origin, cidr: e.target.value })} required /><input placeholder="Description" value={origin.description} onChange={(e) => setOrigin({ ...origin, description: e.target.value })} /><button>Add</button>
          </form>}
          {data.origin_refusals.length > 0 && <><h3>Recent refusals on origin</h3><table><tbody>{data.origin_refusals.map((r: any) => <tr key={r.id}><td>{r.origin_address}</td><td className="small muted">{r.credential_key}</td><td><When value={r.occurred_at} /></td></tr>)}</tbody></table></>}
          <ErrorLine error={err} />
        </div>
        <div className="card" id="notifications">
          <h2>Notification endpoint</h2>
          {data.notification_endpoint ? <p>{data.notification_endpoint.url} <span className="pill active">secret set</span></p> : <Empty text="No endpoint registered; the project receives no events until one is set." />}
          {has('projects.notifications') && <>
            <form className="row" onSubmit={async (e) => { e.preventDefault(); const r = await put<{ signing_secret: string }>(`/projects/${id}/notification-endpoint`, { url }); setSecretShown(r.signing_secret); reload(); }}><input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 320 }} required /><button>Set address</button></form>
            {data.notification_endpoint && <ConfirmedAction operationType="notification_endpoint.regenerate" values={{ project_id: id }} path={`/projects/${id}/notification-endpoint/regenerate-secret`} label="Regenerate secret" summary={<p className="small warnbox">Regenerating replaces the secret for <b>{p.name}</b>; its signature checks fail until it deploys the new value.</p>} onDone={(r: any) => setSecretShown(r.signing_secret)} />}
          </>}
          <h3>Recent deliveries</h3>
          {data.deliveries.length === 0 ? <Empty /> : <table><tbody>{data.deliveries.map((d: any) => <tr key={d.id}><td><Link to={`/transactions/${d.transaction_reference}`}>{d.transaction_reference}</Link></td><td>{d.event_type}</td><td><Pill value={d.status} /></td><td className="num">{d.attempt}</td><td><When value={d.created_at} /></td></tr>)}</tbody></table>}
        </div>
      </div>
      <div className="card" id="entitlements">
        <h2>Entitlements</h2>
        {data.entitlements.length === 0 ? <Empty text="No route granted. Grant one below; the project sees it in its settings at once." /> : (
          <table><thead><tr><th>Route</th><th>Active</th><th>Limits</th><th>Velocity</th><th>Processing</th><th>Platform</th><th>Bearers</th><th>Version</th></tr></thead>
            <tbody>{data.entitlements.map((e: any) => <tr key={e.id}>
              <td><Link to={`/configuration/routes/${e.route_id}`}>{e.country_code} · {e.payment_method_code} · {e.direction} · {e.currency_code}</Link></td>
              <td><Pill value={e.active ? 'active' : 'suspended'} /></td>
              <td className="small">{e.minimum_amount ?? e.route_minimum}–{e.maximum_amount ?? e.route_maximum}</td>
              <td className="small">{e.count_24h}/24h · {e.count_30d}/30d</td>
              <td className="small">{e.processing_fee_bps != null ? <><b>{e.processing_fee_bps / 100}%</b> <span className="muted">(route {e.route_processing_fee_bps / 100}%)</span></> : `${e.route_processing_fee_bps / 100}%`}</td>
              <td className="small">{e.platform_fee_bps != null ? <><b>{e.platform_fee_bps / 100}%</b> <span className="muted">(route {e.route_platform_fee_bps / 100}%)</span></> : `${e.route_platform_fee_bps / 100}%`}</td>
              <td className="small">{e.processing_fee_bearer ?? e.route_processing_fee_bearer} / {e.platform_fee_bearer ?? e.route_platform_fee_bearer}</td>
              <td className="small">#{e.sequence} <details><summary>history</summary>{e.history.map((h: any) => <div key={h.sequence}>#{h.sequence} <When value={h.valid_from} /> {h.author ? `by ${h.author}` : ''}: {h.note}</div>)}</details>
                {has('projects.entitlements') && e.active && <button onClick={async () => { const note = prompt('Note for deactivation'); if (note) { await post(`/projects/${id}/entitlements/${e.id}/deactivate`, { note }); reload(); } }}>Deactivate</button>}</td>
            </tr>)}</tbody></table>
        )}
        {has('projects.entitlements') && routes.data && (
          <form className="stack" style={{ marginTop: 12 }} onSubmit={async (e) => { e.preventDefault(); setErr(null); try { const body = { ...grant, processing_fee_bps: grant.processing_fee_bps === '' || grant.processing_fee_bps == null ? null : Number(grant.processing_fee_bps), platform_fee_bps: grant.platform_fee_bps === '' || grant.platform_fee_bps == null ? null : Number(grant.platform_fee_bps), processing_fee_bearer: grant.processing_fee_bearer || null, platform_fee_bearer: grant.platform_fee_bearer || null }; await post(`/projects/${id}/entitlements`, body); reload(); } catch (x: any) { setErr(x.details?.warning ? `${x.message} Shortfall per 10,000: ${x.details.warning.shortfall_per_10000} (${x.details.warning.binding_provider} expects ${x.details.warning.expected_fee_bps / 100}%). Tick "accept shortfall" to proceed deliberately.` : x.message); } }}>
            <h3>Grant or amend a route</h3>
            <label>Route<select value={grant.route_id} onChange={(e) => setGrant({ ...grant, route_id: e.target.value })} required><option value="">—</option>{routes.data.routes.map((r) => <option key={r.id} value={r.id}>{r.country_code} · {r.payment_method_code} · {r.direction} · {r.currency_code}</option>)}</select></label>
            <div className="row">
              <label>Count 24h<input type="number" value={grant.count_24h} onChange={(e) => setGrant({ ...grant, count_24h: Number(e.target.value) })} /></label>
              <label>Value 24h<input type="number" value={grant.value_24h} onChange={(e) => setGrant({ ...grant, value_24h: Number(e.target.value) })} /></label>
              <label>Count 30d<input type="number" value={grant.count_30d} onChange={(e) => setGrant({ ...grant, count_30d: Number(e.target.value) })} /></label>
              <label>Value 30d<input type="number" value={grant.value_30d} onChange={(e) => setGrant({ ...grant, value_30d: Number(e.target.value) })} /></label>
            </div>
            <div className="row">
              <label>Processing bps override<input type="number" placeholder="inherit" value={grant.processing_fee_bps ?? ''} onChange={(e) => setGrant({ ...grant, processing_fee_bps: e.target.value })} /></label>
              <label>Platform bps override<input type="number" placeholder="inherit" value={grant.platform_fee_bps ?? ''} onChange={(e) => setGrant({ ...grant, platform_fee_bps: e.target.value })} /></label>
              <label>Processing bearer<select value={grant.processing_fee_bearer ?? ''} onChange={(e) => setGrant({ ...grant, processing_fee_bearer: e.target.value })}><option value="">inherit</option><option value="counterparty">counterparty</option><option value="project">project</option></select></label>
              <label>Platform bearer<select value={grant.platform_fee_bearer ?? ''} onChange={(e) => setGrant({ ...grant, platform_fee_bearer: e.target.value })}><option value="">inherit</option><option value="counterparty">counterparty</option><option value="project">project</option></select></label>
            </div>
            <label>Note<input value={grant.note} onChange={(e) => setGrant({ ...grant, note: e.target.value })} required /></label>
            <label className="row"><input type="checkbox" checked={grant.accept_shortfall} onChange={(e) => setGrant({ ...grant, accept_shortfall: e.target.checked })} /> Accept a processing rate below the expected provider fee</label>
            <ErrorLine error={err} />
            <button className="primary">Commit new version</button>
          </form>
        )}
      </div>
      <div className="card">
        <h2>Activity</h2>
        {data.activity.length === 0 ? <Empty /> : <table><tbody>{data.activity.map((a: any) => <tr key={a.reference}><td><Link to={`/transactions/${a.reference}`}>{a.reference}</Link></td><td>{a.direction}</td><td>{a.country_code} · {a.payment_method_code}</td><td className="num"><Amount minor={a.requested_amount} currency={a.currency_code} /></td><td><Pill value={a.state} /></td><td><When value={a.created_at} /></td></tr>)}</tbody></table>}
      </div>
    </>
  );
}
