import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, patch, post } from '../lib/api';
import { useSession } from '../lib/session';
import { ConfirmedAction, Empty, ErrorLine, NeedsPermission, Pill, ScopeNote, When, useLoad } from '../components/common';

/** Configuration (console spec 7.1, 7.4): countries, methods, the route list, providers with breaker state and one-action suspension. */
export function ConfigurationPage() {
  const { id: providerId } = useParams();
  const { has } = useSession();
  const [tab, setTab] = useState<'routes' | 'countries' | 'providers'>(providerId ? 'providers' : 'routes');
  const routes = useLoad(() => get<{ routes: any[] }>('/configuration/routes'));
  const countries = useLoad(() => get<any>('/configuration/countries'));
  const methods = useLoad(() => get<any>('/configuration/payment-methods'));
  const providers = useLoad(() => get<any>('/configuration/providers'));
  const [impact, setImpact] = useState<any>(null);
  const [filter, setFilter] = useState('');
  return (
    <>
      <h1>Configuration</h1>
      <div className="tabs">{(['routes', 'countries', 'providers'] as const).map((k) => <a key={k} href="#" className={tab === k ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab(k); }}>{k}</a>)}</div>
      {tab === 'routes' && (<>
        <div className="filters"><input placeholder="Filter routes (country, method, direction, currency)" value={filter} onChange={(e) => setFilter(e.target.value.toUpperCase())} style={{ width: 360 }} /></div>
        <ErrorLine error={routes.error} />
        {routes.data && <table><thead><tr><th>Country</th><th>Currency</th><th>Method</th><th>Direction</th><th className="num">Processing</th><th className="num">Platform</th><th>Bearers</th><th>Provider</th><th>Active</th><th className="num">Volume 30 d</th></tr></thead>
          <tbody>{routes.data.routes.filter((r) => !filter || `${r.country_code} ${r.currency_code} ${r.payment_method_code} ${r.direction}`.toUpperCase().includes(filter)).map((r) => <tr key={r.id}>
            <td><Link to={`/configuration/routes/${r.id}`}>{r.country_name}</Link>{!r.country_active && <span className="pill failed">country off</span>}</td><td>{r.currency_code}</td><td>{r.payment_method_name}</td><td>{r.direction}</td>
            <td className="num">{r.processing_fee_bps / 100}%{r.indicative && <span className="pill warning" title="Terms from a commercial proposal, not yet contracted">indicative</span>}</td>
            <td className={`num ${r.platform_fee_bps > 0 ? 'ok' : 'muted'}`}>{r.platform_fee_bps / 100}%</td><td className="small">{r.processing_fee_bearer} / {r.platform_fee_bearer}</td><td>{r.provider ?? '—'}</td><td><Pill value={r.active ? 'active' : 'suspended'} /></td><td className="num">{r.volume_30d}</td>
          </tr>)}</tbody></table>}
      </>)}
      {tab === 'countries' && (<>
        <ErrorLine error={countries.error} />
        {countries.data && <div className="grid2">
          <div><h2>Countries</h2><table><thead><tr><th>Code</th><th>Name</th><th>Prefix</th><th>Currencies</th><th>Active</th><th /></tr></thead>
            <tbody>{countries.data.countries.map((c: any) => <tr key={c.code}><td>{c.code} / {c.iso3}</td><td>{c.name}</td><td>{c.dialling_prefix}</td><td>{c.currencies.join(', ')}</td><td><Pill value={c.active ? 'active' : 'suspended'} /></td><td>
              {has('reference.manage') ? <button onClick={async () => { const i = await get<any>(`/configuration/countries/${c.code}/impact`); setImpact({ code: c.code, active: c.active, ...i }); }}>{c.active ? 'Deactivate…' : 'Activate…'}</button> : <NeedsPermission permission="reference.manage" />}
            </td></tr>)}</tbody></table>
            {impact && <div className="warnbox">
              {impact.active ? 'Deactivating' : 'Activating'} <b>{impact.code}</b> affects {impact.routes} routes and {impact.projects} projects; {impact.in_flight} transactions are in flight and continue to completion.
              <div className="row"><button className={impact.active ? 'danger' : 'primary'} onClick={async () => { await patch(`/configuration/countries/${impact.code}`, { active: !impact.active }); setImpact(null); countries.reload(); }}>Confirm</button><button onClick={() => setImpact(null)}>Cancel</button></div>
            </div>}
          </div>
          <div><h2>Payment methods</h2>{methods.data && <table><tbody>{methods.data.payment_methods.map((m: any) => <tr key={m.code}><td>{m.code}</td><td>{m.name}</td></tr>)}</tbody></table>}
            <h2>Currencies</h2><table><tbody>{countries.data.currencies.map((c: any) => <tr key={c.code}><td>{c.code}</td><td>{c.name}</td><td className="num">{c.exponent} decimals</td></tr>)}</tbody></table></div>
        </div>}
      </>)}
      {tab === 'providers' && (<>
        <ErrorLine error={providers.error} />
        {providers.data && <><ScopeNote scoped={providers.data.scoped} />{providers.data.providers.map((p: any) => <div className="card" key={p.id} style={{ marginBottom: 12, outline: p.id === providerId ? '2px solid var(--accent)' : undefined }}>
          <h2>{p.name} <Pill value={p.status} /> {p.breaker_state === 'open' && <span className="pill critical">breaker open · {p.failure_count} failures</span>}</h2>
          <dl className="kv">
            <dt>Provider</dt><dd>{p.provider_name} ({p.adapter_key})</dd><dt>Base address</dt><dd>{p.base_url}</dd>
            <dt>Credentials</dt><dd>{p.credentials_present ? <Pill value="present" /> : <span className="pill failed">absent</span>}</dd>
            <dt>Capabilities</dt><dd className="small">transfers {p.adapter.supportsTransfers ? 'exposed' : 'via console + reconciliation'} · listing {p.adapter.supportsListing ? 'exposed' : 'statement upload'} · test environment {p.adapter.hasTestEnvironment ? 'yes' : 'no (simulator stands in)'} · statement format {p.statement_format ?? '—'}</dd>
            <dt>Scope</dt><dd className="small">{[...new Set(p.capabilities.map((c: any) => `${c.country_code}/${c.currency_code}`))].join(', ') || '—'}</dd>
            {p.suspended_at && <><dt>Suspended</dt><dd><When value={p.suspended_at} /></dd></>}
          </dl>
          <div className="row">
            {has('providers.suspend') ? (p.status === 'suspended' ? <button onClick={async () => { await post(`/configuration/providers/${p.id}/restore`); providers.reload(); }}>Restore</button> : <button className="danger" onClick={async () => { if (confirm(`Suspend ${p.name}? It leaves selection on every route at once.`)) { await post(`/configuration/providers/${p.id}/suspend`); providers.reload(); } }}>Suspend</button>) : <NeedsPermission permission="providers.suspend" />}
            {has('providers.manage') ? <CredentialsForm id={p.id} /> : <NeedsPermission permission="providers.manage" />}
          </div>
        </div>)}</>}
      </>)}
    </>
  );
}

function CredentialsForm({ id }: { id: string }) {
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  return <ConfirmedAction operationType="provider_account.credentials" values={{ provider_account_id: id, keys: ['clientKey', 'clientSecret'].sort() }} path={`/configuration/providers/${id}/credentials`} label="Replace credentials"
    summary={<div className="row"><input placeholder="client key" value={key} onChange={(e) => setKey(e.target.value)} /><input placeholder="client secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} /></div>}
    disabled={!key || !secret} onDone={() => { setKey(''); setSecret(''); }} />;
}

export { Empty as _E };
