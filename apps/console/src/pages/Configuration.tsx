import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get, patch, post } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, ConfirmedAction, Empty, ErrorLine, NeedsPermission, Pill, ScopeNote, Tag, When, useLoad } from '../components/common';
import { DataTable, SummaryGrid, type Column, type DataTableProps } from '../components/table/DataTable';
import { chipBy, distinct, yesNo } from './list-support';

type Row = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;
type Lists = Pick<DataTableProps<Row>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'empty'>;

/** The route list. A route is found by its country's name as well as its code, and every column but the dates is a chip. */
export function routeList({ t, rows }: { t: Tr; rows: Row[] }): Lists {
  const columns: Column<Row>[] = [
    { key: 'country', label: t('l.country'), text: (r) => `${r.country_name} ${r.country_code}`, sortValue: (r) => r.country_name, render: (r) => <>{r.country_name}{!r.country_active && <Tag family="refused">{t('l.country_off')}</Tag>}</> },
    { key: 'method', label: t('l.method'), text: (r) => `${r.payment_method_name} ${r.payment_method_code}`, sortValue: (r) => r.payment_method_code, render: (r) => r.payment_method_name },
    { key: 'direction', label: t('col.type'), text: (r) => r.direction, render: (r) => t(`l.${r.direction}`) },
    { key: 'currency', label: t('l.currency'), text: (r) => r.currency_code, render: (r) => r.currency_code },
    { key: 'provider', label: t('col.provider'), text: (r) => r.provider ?? '', render: (r) => r.provider ?? '—' },
    { key: 'active', label: t('col.active'), render: (r) => <Pill value={r.active ? 'active' : 'suspended'} /> },
    { key: 'volume', label: t('col.volume_30d'), align: 'end', sortValue: (r) => r.volume_30d, render: (r) => r.volume_30d },
  ];
  const summary = (r: Row) => (
    <SummaryGrid items={[
      { label: t('l.processing_fee'), value: <>{r.processing_fee_bps / 100}% <span className="small muted">({r.processing_fee_bearer})</span></> },
      { label: t('l.platform_fee'), value: <>{r.platform_fee_bps / 100}% <span className="small muted">({r.platform_fee_bearer})</span></> },
      { label: t('l.limits'), value: <><Amount minor={r.minimum_amount} currency={r.currency_code} /> – <Amount minor={r.maximum_amount} currency={r.currency_code} /></> },
      { label: t('l.terms'), value: r.indicative ? <Tag family="checking" title={t('l.indicative_hint')}>{t('l.indicative')}</Tag> : t('l.contracted') },
      { label: t('col.volume_30d'), value: r.volume_30d },
    ]} />
  );
  return {
    columns, summary, rowKey: (r) => r.id, defaultSort: 'country',
    filters: [
      ...chipBy<Row>('country', t('l.country'), [...new Map(rows.map((r) => [r.country_code, { value: r.country_code, label: r.country_name }])).values()], (r) => r.country_code),
      ...chipBy<Row>('method', t('l.method'), distinct(rows, (r) => r.payment_method_code), (r) => r.payment_method_code),
      ...chipBy<Row>('direction', t('col.type'), [{ value: 'collection', label: t('l.collection') }, { value: 'disbursement', label: t('l.disbursement') }], (r) => r.direction),
      ...chipBy<Row>('currency', t('l.currency'), distinct(rows, (r) => r.currency_code), (r) => r.currency_code),
      ...chipBy<Row>('provider', t('col.provider'), distinct(rows, (r) => r.provider), (r) => r.provider),
      ...yesNo<Row>('active', t('col.active'), t, (r) => !!r.active),
      ...yesNo<Row>('indicative', t('l.indicative'), t, (r) => !!r.indicative),
    ],
    actions: [{ label: t('table.open'), primary: true, to: (r) => `/configuration/routes/${r.id}` }],
    empty: { none: t('l.route_none'), why: t('l.route_why') },
  };
}

/**
 * The country's impact, as the warning always showed it. Opened by Activer or Désactiver it carries Confirm, which is the
 * same PATCH as before; opened by the toggle alone it only informs.
 */
export function CountryPanel({ c, can, decision, done }: { c: Row; can: boolean; decision: boolean; done: () => void }) {
  const t = useT();
  const [impact, setImpact] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    get<Row>(`/configuration/countries/${c.code}/impact`).then((i) => { if (live) setImpact(i); }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [c.code]);
  return (
    <div className="warnbox">
      <ErrorLine error={error} />
      {impact
        ? t(c.active ? 'l.country_impact_off' : 'l.country_impact_on', { code: c.code, routes: impact.routes, projects: impact.projects, in_flight: impact.in_flight })
        : !error && t('common.loading')}
      {decision && can && impact && (
        <div className="row"><button className={c.active ? 'danger' : 'primary'} onClick={async () => { try { await patch(`/configuration/countries/${c.code}`, { active: !c.active }); done(); } catch (e) { setError((e as Error).message); } }}>{t('common.confirm')}</button></div>
      )}
    </div>
  );
}

/** The decision is offered only for the action that was opened and only while it still applies: once a change lands, the row's opposite change is not on offer. */
export const decidesCountry = (c: Row, open: string | undefined, t: Tr) => open === t(c.active ? 'l.deactivate' : 'l.activate');

/** Countries: Activer or Désactiver unfolds the impact warning with its Confirm. */
export function countryList({ t, has, done }: { t: Tr; has: (p: string) => boolean; done: () => void }): Lists {
  const columns: Column<Row>[] = [
    { key: 'name', label: t('col.name'), text: (c) => `${c.name} ${c.iso3}`, sortValue: (c) => c.name, render: (c) => c.name },
    { key: 'code', label: t('col.code'), mono: true, text: (c) => c.code, render: (c) => `${c.code} / ${c.iso3}` },
    { key: 'currency', label: t('l.currency'), text: (c) => c.currencies.join(' '), render: (c) => c.currencies.join(', ') },
    { key: 'active', label: t('col.active'), render: (c) => <Pill value={c.active ? 'active' : 'suspended'} /> },
  ];
  const manage = (c: Row) => has('reference.manage') && !!c;
  return {
    columns, rowKey: (c) => c.code, defaultSort: 'name',
    filters: yesNo<Row>('active', t('col.active'), t, (c) => !!c.active),
    actions: [
      { label: t('l.deactivate'), opens: true, when: (c) => manage(c) && c.active },
      { label: t('l.activate'), opens: true, when: (c) => manage(c) && !c.active },
    ],
    summary: (c, open) => (
      <SummaryGrid items={[
        { label: t('l.dialling_prefix'), value: c.dialling_prefix },
        { label: t('l.impact'), value: <CountryPanel c={c} can={has('reference.manage')} decision={decidesCountry(c, open, t)} done={done} /> },
      ]} />
    ),
    empty: { none: t('l.country_none'), why: t('l.country_why') },
  };
}

const methodColumns = (t: Tr): Column<Row>[] => [{ key: 'code', label: t('col.code'), mono: true, render: (m) => m.code }, { key: 'name', label: t('col.name'), render: (m) => m.name }];
const currencyColumns = (t: Tr): Column<Row>[] => [{ key: 'code', label: t('col.code'), mono: true, render: (c) => c.code }, { key: 'name', label: t('col.name'), render: (c) => c.name }, { key: 'exponent', label: t('col.decimals'), align: 'end', render: (c) => c.exponent }];

/** Configuration (console spec 7.1, 7.4): countries, methods, the route list, providers with breaker state and one-action suspension. */
export function ConfigurationPage() {
  const { id: providerId } = useParams();
  const { has } = useSession();
  const [tab, setTab] = useState<'routes' | 'countries' | 'providers'>(providerId ? 'providers' : 'routes');
  const routes = useLoad(() => get<{ routes: any[] }>('/configuration/routes'));
  const countries = useLoad(() => get<any>('/configuration/countries'));
  const methods = useLoad(() => get<any>('/configuration/payment-methods'));
  const providers = useLoad(() => get<any>('/configuration/providers'));
  const t = useT();
  return (
    <>
      <h1>Configuration</h1>
      <div className="tabs">{(['routes', 'countries', 'providers'] as const).map((k) => <a key={k} href="#" className={tab === k ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab(k); }}>{k}</a>)}</div>
      {tab === 'routes' && (<>
        <ErrorLine error={routes.error} />
        {routes.data && <DataTable<Row> prefix="rt_" rows={routes.data.routes} {...routeList({ t, rows: routes.data.routes })} searchLabel={t('l.search_routes')} />}
      </>)}
      {tab === 'countries' && (<>
        <ErrorLine error={countries.error} />
        {countries.data && <div className="grid2">
          <div><h2>{t('l.countries')}</h2>
            <DataTable<Row> prefix="ct_" rows={countries.data.countries} {...countryList({ t, has, done: countries.reload })} />
          </div>
          <div><h2>{t('l.payment_methods')}</h2>{methods.data && <DataTable<Row> bare rows={methods.data.payment_methods} columns={methodColumns(t)} rowKey={(m) => m.code} defaultSort="code" empty={{ none: t('l.method_none'), why: t('l.method_why') }} />}
            <h2>{t('l.currencies')}</h2><DataTable<Row> bare rows={countries.data.currencies} columns={currencyColumns(t)} rowKey={(c) => c.code} defaultSort="code" empty={{ none: t('l.currency_none'), why: t('l.currency_why') }} /></div>
        </div>}
      </>)}
      {tab === 'providers' && (<>
        <ErrorLine error={providers.error} />
        {providers.data && <><ScopeNote scoped={providers.data.scoped} />{providers.data.providers.map((p: any) => <div className="card" key={p.id} style={{ marginBottom: 12, outline: p.id === providerId ? '2px solid var(--ink)' : undefined }}>
          <h2>{p.name} <Pill value={p.status} /> {p.breaker_state === 'open' && <Tag family="refused">breaker open · {p.failure_count} failures</Tag>}</h2>
          <dl className="kv">
            <dt>Provider</dt><dd>{p.provider_name} ({p.adapter_key})</dd><dt>Base address</dt><dd>{p.base_url}</dd>
            <dt>Credentials</dt><dd>{p.credentials_present ? <Pill value="present" /> : <Tag family="refused">absent</Tag>}</dd>
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
