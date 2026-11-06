import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { del, get, post, put, type ApiError } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, ConfirmedAction, Empty, ErrorLine, NeedsPermission, Pill, SubmitForm, Tag, When, useLoad } from '../components/common';
import { SecretOnce } from '../components/SecretOnce';
import { DataTable, SummaryGrid, type Column, type DataTableProps, type RowAction } from '../components/table/DataTable';
import { chip, fetchPage, periodFilter, useReload, useTab, yesNo } from './list-support';
import { TransactionTable } from './Transactions';

type Row = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;
type Lists = Pick<DataTableProps<Row>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'defaultOrder' | 'empty'>;
const DELIVERY_EVENTS = ['transaction.succeeded', 'transaction.failed', 'transaction.expired', 'transaction.action_required', 'transaction.undetermined', 'transaction.corrected'];

/** A project's transactions, for an administrator who may read them. */
export function ProjectActivity({ id }: { id: string }) {
  const { has } = useSession();
  return has('transactions.read') ? <TransactionTable fixedProject={id} prefix="act_" /> : <NeedsPermission permission="transactions.read" />;
}

/** Requests refused for coming from an address the project has not declared. */
export function refusalList({ t }: { t: Tr }): Lists {
  const columns: Column<Row>[] = [
    { key: 'when', label: t('col.when'), sortKey: 'when', render: (r) => <When value={r.occurred_at} /> },
    { key: 'address', label: t('col.address'), mono: true, render: (r) => r.origin_address },
    { key: 'credential', label: t('col.credential'), mono: true, render: (r) => r.credential_key },
  ];
  return { columns, filters: [periodFilter<Row>(t)], rowKey: (r) => String(r.id), defaultSort: 'when', defaultOrder: 'desc', empty: { none: t('l.refusal_none'), why: t('l.refusal_why') } };
}

/** Notifications sent to the project's endpoint; a failed one can be replayed from here. */
export function deliveryList({ t, has, reload }: { t: Tr; has: (p: string) => boolean; reload: () => void }): Lists & Pick<DataTableProps<Row>, 'actions'> {
  const columns: Column<Row>[] = [
    { key: 'event', label: t('col.event'), render: (d) => d.event_type },
    { key: 'transaction', label: t('col.transaction'), mono: true, render: (d) => <Link to={`/transactions/${d.transaction_reference}`}>{d.transaction_reference}</Link> },
    { key: 'status', label: t('col.status'), render: (d) => <Pill value={d.status} /> },
    { key: 'attempts', label: t('col.attempts'), align: 'end', render: (d) => d.attempt },
    { key: 'attempted', label: t('col.last_attempt'), sortKey: 'attempted', render: (d) => <When value={d.created_at} /> },
  ];
  const actions: RowAction<Row>[] = [
    { label: t('l.replay'), when: () => has('transactions.replay_notification'), run: async (d) => { await post(`/transactions/${d.transaction_reference}/notifications/${d.id}/replay`); reload(); } },
  ];
  const summary = (d: Row) => (
    <SummaryGrid items={[
      { label: t('l.next_retry'), value: d.next_attempt_at ? <When value={d.next_attempt_at} /> : '—' },
      { label: t('l.delivered_at'), value: d.delivered_at ? <When value={d.delivered_at} /> : '—' },
      { label: t('l.event_id'), value: <span className="mono small">{d.event_id}</span> },
      ...(d.replayed_from ? [{ label: t('l.replayed_from'), value: <span className="mono small">{d.replayed_from}</span> }] : []),
    ]} />
  );
  return {
    columns, actions, summary, rowKey: (d) => d.id, defaultSort: 'attempted', defaultOrder: 'desc',
    filters: [...chip<Row>('status', t('col.status'), ['pending', 'delivered', 'exhausted']), ...chip<Row>('event', t('col.event'), DELIVERY_EVENTS)],
    empty: { none: t('l.delivery_none'), why: t('l.delivery_why') },
  };
}

type Listed = Pick<DataTableProps<Row>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'defaultOrder' | 'empty'>;
const pct = (bps: number | null | undefined) => `${(bps ?? 0) / 100}%`;

/** The routes a project is granted. Overrides show beside the route's own rates; deactivating asks for a note, as it always did. */
export function entitlementList({ t, has, reload, id }: { t: Tr; has: (p: string) => boolean; reload: () => void; id: string }): Listed {
  const name = (e: Row) => `${e.country_code} · ${e.payment_method_code} · ${e.direction} · ${e.currency_code}`;
  const columns: Column<Row>[] = [
    { key: 'route', label: t('col.route'), text: name, sortValue: name, render: (e) => <Link to={`/configuration/routes/${e.route_id}`}>{name(e)}</Link> },
    { key: 'active', label: t('col.active'), render: (e) => <Pill value={e.active ? 'active' : 'suspended'} /> },
    { key: 'version', label: t('col.version'), align: 'end', sortValue: (e) => e.sequence ?? 0, render: (e) => `#${e.sequence}` },
  ];
  const override = (own: number | null | undefined, route: number) => (own != null ? <><b>{pct(own)}</b> <span className="muted">({t('l.route_own')} {pct(route)})</span></> : pct(route));
  const summary = (e: Row) => (
    <SummaryGrid items={[
      { label: t('l.limits'), value: <><Amount minor={e.minimum_amount ?? e.route_minimum} currency={e.currency_code} />–<Amount minor={e.maximum_amount ?? e.route_maximum} currency={e.currency_code} /></> },
      { label: t('l.velocity'), value: `${e.count_24h}/24h · ${e.count_30d}/30d` },
      { label: t('l.processing_fee'), value: override(e.processing_fee_bps, e.route_processing_fee_bps) },
      { label: t('l.platform_fee'), value: override(e.platform_fee_bps, e.route_platform_fee_bps) },
      { label: t('l.bearers'), value: `${e.processing_fee_bearer ?? e.route_processing_fee_bearer} / ${e.platform_fee_bearer ?? e.route_platform_fee_bearer}` },
      { label: t('l.version_history'), value: <div className="small">{e.history.map((h: Row) => <div key={h.sequence}>#{h.sequence} <When value={h.valid_from} /> {h.author ? `${t('l.by')} ${h.author}` : ''}: {h.note}</div>)}</div> },
    ]} />
  );
  return {
    columns, summary, rowKey: (e) => e.id, defaultSort: 'route',
    filters: yesNo<Row>('active', t('col.active'), t, (e) => !!e.active),
    actions: [{ label: t('l.deactivate'), when: (e) => has('projects.entitlements') && !!e.active, run: async (e) => { const note = prompt(t('l.deactivation_note')); if (note) { await post(`/projects/${id}/entitlements/${e.id}/deactivate`, { note }); reload(); } } }],
    empty: { none: t('l.entitlement_none'), why: t('l.entitlement_why') },
  };
}

/** The addresses a project may call from, the latest declared first. */
export function originList({ t, has, reload, id }: { t: Tr; has: (p: string) => boolean; reload: () => void; id: string }): Listed {
  const columns: Column<Row>[] = [
    { key: 'cidr', label: t('col.address_range'), mono: true, text: (o) => o.cidr, render: (o) => o.cidr },
    { key: 'description', label: t('col.description'), text: (o) => o.description, render: (o) => o.description || <span className="muted">—</span> },
    { key: 'added', label: t('col.added'), sortValue: (o) => Date.parse(o.created_at), render: (o) => <When value={o.created_at} /> },
  ];
  return {
    columns, rowKey: (o) => o.id, defaultSort: 'added', defaultOrder: 'desc', filters: [],
    actions: [{ label: t('l.remove'), when: () => has('projects.origins'), run: async (o) => { await del(`/projects/${id}/origins/${o.id}`); reload(); } }],
    empty: { none: t('l.origin_none'), why: t('l.origin_why') },
  };
}

const TABS = ['overview', 'keys', 'origins', 'routes', 'deliveries', 'activity'] as const;
type Secret = { label: string; value: string }[];
type Project = Record<string, any>;

/** Status, code, creation and balances. */
function OverviewTab({ data }: { data: Project }) {
  const t = useT();
  const p = data.project;
  return (
    <div className="card" id="overview">
      <dl className="kv">
        <dt>{t('col.status')}</dt><dd><Pill value={p.status} /></dd>
        <dt>{t('col.code')}</dt><dd className="mono">{p.code}</dd>
        <dt>{t('pd.created')}</dt><dd><When value={p.created_at} /></dd>
        <dt>{t('l.balances')}</dt><dd>{data.balances.length ? data.balances.map((b: Row) => <div key={b.currency}><Amount minor={b.available} currency={b.currency} /> {t('pd.available')} · <Amount minor={b.reserved} currency={b.currency} /> {t('l.reserved')}</div>) : '—'}</dd>
      </dl>
    </div>
  );
}

/** Credentials as a rotation sequence, and the notification endpoint; each shows its own secret, once. */
function KeysTab({ data, id, reload, credentialSecret, setCredentialSecret, signingSecret, setSigningSecret }: {
  data: Project; id: string; reload: () => void; credentialSecret: Secret | null; setCredentialSecret: (s: Secret | null) => void; signingSecret: Secret | null; setSigningSecret: (s: Secret | null) => void;
}) {
  const { has } = useSession();
  const t = useT();
  const [url, setUrl] = useState('');
  const p = data.project;
  const active = data.credentials.filter((c: Row) => c.status === 'active');
  const primary = active.find((c: Row) => c.role === 'primary');
  const secondary = active.find((c: Row) => c.role === 'secondary');
  const stage = !primary ? 'none' : secondary ? 'both' : 'primary';
  const signing = (r: { signing_secret: string }) => setSigningSecret([{ label: t('secret.signing'), value: r.signing_secret }]);
  return (
    <div className="grid2">
      <div className="card" id="credentials">
        <h2>{t('pd.credentials')}</h2>
        <p className="small muted">{t('pd.rotation')} <b className={stage === 'none' ? 'negative' : ''}>{t(`pd.rotation_${stage}`)}</b></p>
        <DataTable<Row> bare rows={data.credentials} rowKey={(c) => c.id} defaultSort="issued" empty={{ none: t('l.credential_none'), why: t('l.credential_why') }} columns={[
          { key: 'key', label: t('col.key'), render: (c) => <span className="small"><span className="mono">{c.key}</span><br /><span className="muted">{c.scopes.join(', ')}</span></span> },
          { key: 'role', label: t('col.role'), render: (c) => <Pill value={c.role} /> },
          { key: 'status', label: t('col.status'), render: (c) => <Pill value={c.status} /> },
          { key: 'issued', label: t('col.issued'), render: (c) => <When value={c.issued_at} /> },
          // The rotation actions are code-confirmed components, so they sit in a cell of their own under the table's header.
          { key: 'actions', label: t('table.actions'), render: (c) => c.status === 'active' && has('projects.credentials') ? <div className="row">
            {c.role === 'secondary' && <ConfirmedAction operationType="credential.promote" values={{ credential_id: c.id }} path={`/projects/${id}/credentials/${c.id}/promote`} label={t('pd.promote')} onDone={reload} />}
            {c.role === 'secondary' && active.length > 1 && <ConfirmedAction operationType="credential.delete" values={{ credential_id: c.id }} path={`/projects/${id}/credentials/${c.id}`} method="DELETE" label={t('pd.delete')} onDone={reload} />}
            {c.role === 'primary' && <button disabled title={t('pd.delete_primary')}>{t('pd.delete')}</button>}
            {active.length === 1 && c.role === 'secondary' && <button disabled title={t('pd.delete_last')}>{t('pd.delete')}</button>}
            <ConfirmedAction operationType="credential.revoke" values={{ credential_id: c.id, reason: 'revoked from console' }} path={`/projects/${id}/credentials/${c.id}/revoke`} label={t('pd.revoke')} onDone={reload} />
          </div> : null },
        ]} />
        {has('projects.credentials') ? (active.length < 2 && <ConfirmedAction operationType="credential.issue" values={{ project_id: id, scopes: ['collection', 'disbursement', 'read'] }} path={`/projects/${id}/credentials`} label={primary ? t('pd.issue_secondary') : t('pd.issue')} onDone={(r: any) => { setCredentialSecret([{ label: t('secret.key'), value: r.key }, { label: t('secret.secret'), value: r.secret }]); reload(); }} />) : <NeedsPermission permission="projects.credentials" />}
        {credentialSecret && <SecretOnce items={credentialSecret} onDismiss={() => setCredentialSecret(null)} />}
      </div>
      <div className="card" id="notifications">
        <h2>{t('pd.endpoint')}</h2>
        {data.notification_endpoint ? <p>{data.notification_endpoint.url} <Tag family="confirmed">{t('pd.secret_set')}</Tag></p> : <Empty text={t('pd.endpoint_none')} />}
        {has('projects.notifications') && <>
          <SubmitForm className="row" submitLabel={t('pd.set_address')} onSubmit={async () => { signing(await put<{ signing_secret: string }>(`/projects/${id}/notification-endpoint`, { url })); setUrl(''); reload(); return t('pd.endpoint_set'); }}>
            <input aria-label={t('field.url')} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 320 }} required />
          </SubmitForm>
          {data.notification_endpoint && <ConfirmedAction operationType="notification_endpoint.regenerate" values={{ project_id: id }} path={`/projects/${id}/notification-endpoint/regenerate-secret`} label={t('pd.regenerate')} summary={<p className="small warnbox">{t('pd.regenerate_warning', { name: p.name })}</p>} onDone={(r: any) => signing(r)} />}
        </>}
        {signingSecret && <SecretOnce items={signingSecret} onDismiss={() => setSigningSecret(null)} />}
      </div>
    </div>
  );
}

/** Declared origins, and the requests refused for coming from elsewhere. */
function OriginsTab({ data, id, reload }: { data: Project; id: string; reload: () => void }) {
  const { has } = useSession();
  const t = useT();
  const [origin, setOrigin] = useState({ cidr: '', description: '' });
  return (
    <>
      <div className="card" id="origins">
        <h2>{t('pd.origins')}</h2>
        <DataTable<Row> prefix="org_" search={false} rows={data.origins} {...originList({ t, has, reload, id })} />
        {has('projects.origins') && (
          <SubmitForm className="row" submitLabel={t('pd.add')} onSubmit={async () => { await post(`/projects/${id}/origins`, origin); const cidr = origin.cidr; setOrigin({ cidr: '', description: '' }); reload(); return t('pd.origin_added', { cidr }); }}>
            <input aria-label={t('field.cidr')} placeholder="10.0.0.0/8" value={origin.cidr} onChange={(e) => setOrigin({ ...origin, cidr: e.target.value })} required />
            <input aria-label={t('field.description')} placeholder={t('field.description')} value={origin.description} onChange={(e) => setOrigin({ ...origin, description: e.target.value })} />
          </SubmitForm>
        )}
      </div>
      <div className="card" id="refusals">
        <h2>{t('l.refusals')}</h2>
        <DataTable<Row> prefix="ref_" search={false} {...refusalList({ t })} fetch={fetchPage<Row>(`/projects/${id}/origin-refusals`, { period: 'after' })} />
      </div>
    </>
  );
}

const EMPTY_GRANT = { route_id: '', count_24h: '', value_24h: '', count_30d: '', value_30d: '', processing_fee_bps: '', platform_fee_bps: '', processing_fee_bearer: '', platform_fee_bearer: '', note: '', accept_shortfall: false };
const BEARERS = ['counterparty', 'project'] as const;

/**
 * Grants a route or amends its grant with a new version. The limits start empty, since any figure here would be
 * someone else's; an empty override inherits the route's own value, shown as the placeholder.
 */
function GrantForm({ id, routes, reload }: { id: string; routes: Row[]; reload: () => void }) {
  const t = useT();
  const { lang } = useSession();
  const [grant, setGrant] = useState(EMPTY_GRANT);
  const set = (patch: Partial<typeof EMPTY_GRANT>) => setGrant((g) => ({ ...g, ...patch }));
  const route = routes.find((r) => r.id === grant.route_id);
  const percent = (bps: number) => (bps / 100).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: 2 });
  const inheritBps = (bps: number | null | undefined) => (route && bps != null ? t('grant.inherit_bps', { bps, pct: percent(bps) }) : t('grant.inherit'));
  const inheritBearer = (b: string | null | undefined) => (route && b ? t('grant.inherit_bearer', { bearer: t(`grant.bearer_${b}`) }) : t('grant.inherit'));
  const orNull = (v: string) => (v === '' ? null : Number(v));
  const submit = async () => {
    const body = {
      ...grant, count_24h: Number(grant.count_24h), value_24h: Number(grant.value_24h), count_30d: Number(grant.count_30d), value_30d: Number(grant.value_30d),
      processing_fee_bps: orNull(grant.processing_fee_bps), platform_fee_bps: orNull(grant.platform_fee_bps),
      processing_fee_bearer: grant.processing_fee_bearer || null, platform_fee_bearer: grant.platform_fee_bearer || null,
    };
    try {
      const r = await post<{ sequence: number }>(`/projects/${id}/entitlements`, body);
      setGrant(EMPTY_GRANT); reload();
      return t('grant.committed', { sequence: r.sequence });
    } catch (x) {
      const w = (x as ApiError).details?.warning as Row | undefined;
      if (w) throw new Error(t('grant.shortfall', { provider: w.binding_provider, pct: percent(w.expected_fee_bps), shortfall: w.shortfall_per_10000 }));
      throw x;
    }
  };
  const limit = (key: 'count_24h' | 'value_24h' | 'count_30d' | 'value_30d') => (
    <label>{t(`field.${key}`)}<input type="number" min={0} step={1} value={grant[key]} onChange={(e) => set({ [key]: e.target.value })} required /></label>
  );
  const bearer = (key: 'processing_fee_bearer' | 'platform_fee_bearer') => (
    <label>{t(`field.${key}`)}<select value={grant[key]} onChange={(e) => set({ [key]: e.target.value })}><option value="">{inheritBearer(route?.[key])}</option>{BEARERS.map((b) => <option key={b} value={b}>{t(`grant.bearer_${b}`)}</option>)}</select></label>
  );
  return (
    <div style={{ marginTop: 12 }}>
      <h3>{t('grant.title')}</h3>
      <SubmitForm submitLabel={t('grant.submit')} onSubmit={submit}>
        <label>{t('field.route_id')}<select value={grant.route_id} onChange={(e) => set({ route_id: e.target.value })} required><option value="">—</option>{routes.map((r) => <option key={r.id} value={r.id}>{r.country_code} · {r.payment_method_code} · {r.direction} · {r.currency_code}</option>)}</select></label>
        <div className="row">{limit('count_24h')}{limit('value_24h')}{limit('count_30d')}{limit('value_30d')}</div>
        <div className="row">
          <label>{t('field.processing_fee_bps')}<input type="number" min={0} step={1} placeholder={inheritBps(route?.processing_fee_bps)} value={grant.processing_fee_bps} onChange={(e) => set({ processing_fee_bps: e.target.value })} /></label>
          <label>{t('field.platform_fee_bps')}<input type="number" min={0} step={1} placeholder={inheritBps(route?.platform_fee_bps)} value={grant.platform_fee_bps} onChange={(e) => set({ platform_fee_bps: e.target.value })} /></label>
          {bearer('processing_fee_bearer')}{bearer('platform_fee_bearer')}
        </div>
        <label>{t('field.note')}<input value={grant.note} onChange={(e) => set({ note: e.target.value })} required /></label>
        <label className="row"><input type="checkbox" checked={grant.accept_shortfall} onChange={(e) => set({ accept_shortfall: e.target.checked })} /> {t('grant.accept_shortfall')}</label>
      </SubmitForm>
    </div>
  );
}

/** Project detail (console spec 6.2), one tab per concern; the tab lives in the URL beside the tables' state. */
export function ProjectDetailPage() {
  const { id } = useParams();
  const { has } = useSession();
  const t = useT();
  const [tab, setTab] = useTab(TABS, 'overview');
  const [deliveriesRev, reloadDeliveries] = useReload();
  const { data, error, reload } = useLoad(() => get<any>(`/projects/${id}`), [id]);
  const routes = useLoad(() => get<{ routes: any[] }>('/configuration/routes'), []);
  // Two secrets, two states: the signing secret and a new credential never share, so neither replaces the other.
  const [credentialSecret, setCredentialSecret] = useState<Secret | null>(null);
  const [signingSecret, setSigningSecret] = useState<Secret | null>(null);
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  const p = data.project;
  return (
    <>
      <h1>{p.name} <Pill value={p.status} /></h1>
      <div className="tabs">{TABS.map((k) => <a key={k} href="#" className={tab === k ? 'active' : ''} aria-current={tab === k ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setTab(k); }}>{t(`l.tab_${k}`)}</a>)}</div>
      {tab === 'overview' && <OverviewTab data={data} />}
      {tab === 'keys' && <KeysTab data={data} id={id!} reload={reload} credentialSecret={credentialSecret} setCredentialSecret={setCredentialSecret} signingSecret={signingSecret} setSigningSecret={setSigningSecret} />}
      {tab === 'origins' && <OriginsTab data={data} id={id!} reload={reload} />}
      {tab === 'routes' && (
        <div className="card" id="entitlements">
          <h2>{t('pd.entitlements')}</h2>
          <DataTable<Row> prefix="ent_" rows={data.entitlements} {...entitlementList({ t, has, reload, id: id! })} />
          {has('projects.entitlements') && routes.data && <GrantForm id={id!} routes={routes.data.routes} reload={reload} />}
        </div>
      )}
      {tab === 'deliveries' && (
        <div className="card" id="deliveries">
          <h2>{t('l.deliveries')}</h2>
          <DataTable<Row> key={deliveriesRev} prefix="del_" search={false} {...deliveryList({ t, has, reload: reloadDeliveries })} fetch={fetchPage<Row>(`/projects/${id}/deliveries`)} />
        </div>
      )}
      {tab === 'activity' && (
        <div className="card" id="activity">
          <h2>{t('l.activity')}</h2>
          <ProjectActivity id={id!} />
        </div>
      )}
    </>
  );
}
