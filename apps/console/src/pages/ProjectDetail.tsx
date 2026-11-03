import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { del, get, post, put } from '../lib/api';
import { useSession, useT } from '../lib/session';
import { Amount, ConfirmedAction, Empty, ErrorLine, NeedsPermission, Pill, Tag, When, useLoad } from '../components/common';
import { DataTable, SummaryGrid, type Column, type DataTableProps, type RowAction } from '../components/table/DataTable';
import { chip, fetchPage, periodFilter, useReload, yesNo } from './list-support';
import { TransactionTable } from './Transactions';

type Row = Record<string, any>;
type Tr = (k: string, v?: Record<string, string | number>) => string;
type Lists = Pick<DataTableProps<Row>, 'columns' | 'filters' | 'actions' | 'summary' | 'rowKey' | 'defaultSort' | 'defaultOrder' | 'empty'>;
const DELIVERY_EVENTS = ['transaction.succeeded', 'transaction.failed', 'transaction.expired', 'transaction.action_required', 'transaction.undetermined', 'transaction.corrected'];

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
      { label: t('l.limits'), value: `${e.minimum_amount ?? e.route_minimum}–${e.maximum_amount ?? e.route_maximum}` },
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

/** Project detail (console spec 6.2): credentials as a rotation sequence, origins with refusals, entitlements with overrides beside the route's own, notification endpoint. */
export function ProjectDetailPage() {
  const { id } = useParams();
  const { has } = useSession();
  const t = useT();
  const [deliveriesRev, reloadDeliveries] = useReload();
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
          <DataTable<Row> bare rows={data.credentials} rowKey={(c) => c.id} defaultSort="issued" empty={{ none: t('l.credential_none'), why: t('l.credential_why') }} columns={[
            { key: 'key', label: t('col.key'), render: (c) => <span className="small"><span className="mono">{c.key}</span><br /><span className="muted">{c.scopes.join(', ')}</span></span> },
            { key: 'role', label: t('col.role'), render: (c) => <Pill value={c.role} /> },
            { key: 'status', label: t('col.status'), render: (c) => <Pill value={c.status} /> },
            { key: 'issued', label: t('col.issued'), render: (c) => <When value={c.issued_at} /> },
            // The rotation actions are code-confirmed components, so they sit in a cell of their own under the table's header.
            { key: 'actions', label: t('table.actions'), render: (c) => c.status === 'active' && has('projects.credentials') ? <div className="row">
              {c.role === 'secondary' && <ConfirmedAction operationType="credential.promote" values={{ credential_id: c.id }} path={`/projects/${id}/credentials/${c.id}/promote`} label="Promote" onDone={reload} />}
              {c.role === 'secondary' && active.length > 1 && <ConfirmedAction operationType="credential.delete" values={{ credential_id: c.id }} path={`/projects/${id}/credentials/${c.id}`} label="Delete" onDone={reload} />}
              {c.role === 'primary' && <button disabled title="The primary credential cannot be deleted; promote the secondary first.">Delete</button>}
              {active.length === 1 && c.role === 'secondary' && <button disabled title="A project keeps at least one credential.">Delete</button>}
              <ConfirmedAction operationType="credential.revoke" values={{ credential_id: c.id, reason: 'revoked from console' }} path={`/projects/${id}/credentials/${c.id}/revoke`} label="Revoke" onDone={reload} />
            </div> : null },
          ]} />
          {has('projects.credentials') ? (active.length < 2 && <ConfirmedAction operationType="credential.issue" values={{ project_id: id, scopes: ['collection', 'disbursement', 'read'] }} path={`/projects/${id}/credentials`} label={primary ? 'Issue secondary credential' : 'Issue credential'} onDone={(r: any) => { setSecretShown(`${r.key}\n${r.secret}`); reload(); }} />) : <NeedsPermission permission="projects.credentials" />}
          {secretShown && <div className="warnbox">The secret appears once, now. Copy it.<pre>{secretShown}</pre></div>}
        </div>
      </div>
      <div className="grid2">
        <div className="card" id="origins">
          <h2>Declared origins</h2>
          <DataTable<Row> prefix="org_" search={false} rows={data.origins} {...originList({ t, has, reload, id: id! })} />
          {has('projects.origins') && <form className="row" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await post(`/projects/${id}/origins`, origin); setOrigin({ cidr: '', description: '' }); reload(); } catch (x) { setErr((x as Error).message); } }}>
            <input placeholder="10.0.0.0/8" value={origin.cidr} onChange={(e) => setOrigin({ ...origin, cidr: e.target.value })} required /><input placeholder="Description" value={origin.description} onChange={(e) => setOrigin({ ...origin, description: e.target.value })} /><button>Add</button>
          </form>}
          <ErrorLine error={err} />
        </div>
        <div className="card" id="notifications">
          <h2>Notification endpoint</h2>
          {data.notification_endpoint ? <p>{data.notification_endpoint.url} <Tag family="confirmed">secret set</Tag></p> : <Empty text="No endpoint registered; the project receives no events until one is set." />}
          {has('projects.notifications') && <>
            <form className="row" onSubmit={async (e) => { e.preventDefault(); const r = await put<{ signing_secret: string }>(`/projects/${id}/notification-endpoint`, { url }); setSecretShown(r.signing_secret); reload(); }}><input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 320 }} required /><button>Set address</button></form>
            {data.notification_endpoint && <ConfirmedAction operationType="notification_endpoint.regenerate" values={{ project_id: id }} path={`/projects/${id}/notification-endpoint/regenerate-secret`} label="Regenerate secret" summary={<p className="small warnbox">Regenerating replaces the secret for <b>{p.name}</b>; its signature checks fail until it deploys the new value.</p>} onDone={(r: any) => setSecretShown(r.signing_secret)} />}
          </>}
        </div>
      </div>
      <div className="card" id="entitlements">
        <h2>Entitlements</h2>
        <DataTable<Row> prefix="ent_" rows={data.entitlements} {...entitlementList({ t, has, reload, id: id! })} />
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
      <div className="card" id="refusals">
        <h2>{t('l.refusals')}</h2>
        <DataTable<Row> prefix="ref_" search={false} {...refusalList({ t })} fetch={fetchPage<Row>(`/projects/${id}/origin-refusals`, { period: 'after' })} />
      </div>
      <div className="card" id="deliveries">
        <h2>{t('l.deliveries')}</h2>
        <DataTable<Row> key={deliveriesRev} prefix="del_" search={false} {...deliveryList({ t, has, reload: reloadDeliveries })} fetch={fetchPage<Row>(`/projects/${id}/deliveries`)} />
      </div>
      <div className="card" id="activity">
        <h2>{t('l.activity')}</h2>
        <TransactionTable fixedProject={id} prefix="act_" />
      </div>
    </>
  );
}
