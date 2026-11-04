import { renderToStaticMarkup as html } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DataTable, type DataTableProps } from '../components/table/DataTable';
import { clientRows } from '../components/table/client-rows';
import type { TableState } from '../components/table/table-state';
import { t as translate } from '../lib/i18n';
import { projectList } from './Projects';
import { countryList, routeList, decidesCountry } from './Configuration';
import { balanceRows, floatAccountList, projectBalanceList } from './Treasury';
import { entitlementList, originList } from './ProjectDetail';
import { approvalList } from './Approvals';
import { administratorList, roleList } from './Oversight';

const fr = (k: string, v?: Record<string, string | number>) => translate('fr', k, v);
const wrap = (el: React.ReactNode) => html(<MemoryRouter>{el}</MemoryRouter>);
const none = () => undefined;
const state = (patch: Partial<TableState> = {}): TableState => ({ q: '', filters: {}, sort: '', order: 'asc', page: 1, pageSize: 100, ...patch });
const run = <T,>(rows: T[], cfg: { columns: any[]; filters?: any[] }, patch: Partial<TableState> = {}) => clientRows(rows, state(patch), cfg.columns, cfg.filters).rows;

const route = (o: Record<string, unknown> = {}) => ({ id: 'r1', country_code: 'CM', country_name: 'Cameroun', country_active: true, currency_code: 'XAF', payment_method_code: 'MOMO', payment_method_name: 'Mobile money', direction: 'collection', processing_fee_bps: 150, platform_fee_bps: 50, processing_fee_bearer: 'counterparty', platform_fee_bearer: 'project', minimum_amount: 100, maximum_amount: 500000, active: true, indicative: false, provider: 'MTN CM', volume_30d: 10, ...o });
const ROUTES = [
  route(),
  route({ id: 'r2', country_code: 'BF', country_name: 'Burkina Faso', currency_code: 'XOF', payment_method_code: 'OM', payment_method_name: 'Orange Money', direction: 'disbursement', provider: 'Orange BF', indicative: true, active: false, volume_30d: 40 }),
  route({ id: 'r3', country_code: 'BF', country_name: 'Burkina Faso', currency_code: 'XOF', provider: 'Orange BF', volume_30d: 5 }),
];

describe('routes', () => {
  const cfg = routeList({ t: fr, rows: ROUTES });
  it('are found by country name', () => {
    expect(run(ROUTES, cfg, { q: 'burkina' }).map((r) => r.id)).toEqual(['r2', 'r3']);
    expect(run(ROUTES, cfg, { q: 'BF' }).map((r) => r.id)).toEqual(['r2', 'r3']);
    expect(run(ROUTES, cfg, { q: 'orange' })).toHaveLength(2);
  });

  it('filter on every column the spec names', () => {
    expect(cfg.filters!.map((f) => f.key)).toEqual(['country', 'method', 'direction', 'currency', 'provider', 'active', 'indicative']);
    const ids = (key: string, value: string) => run(ROUTES, cfg, { filters: { [key]: value } }).map((r) => r.id);
    expect(ids('country', 'BF')).toEqual(['r2', 'r3']);
    expect(ids('method', 'OM')).toEqual(['r2']);
    expect(ids('direction', 'collection')).toEqual(['r1', 'r3']);
    expect(ids('currency', 'XAF')).toEqual(['r1']);
    expect(ids('provider', 'MTN CM')).toEqual(['r1']);
    expect(ids('active', 'no')).toEqual(['r2']);
    expect(ids('indicative', 'yes')).toEqual(['r2']);
  });

  it('sort by country, method and volume, the country first', () => {
    expect(cfg.defaultSort).toBe('country');
    expect(run(ROUTES, cfg, { sort: 'volume', order: 'desc' }).map((r) => r.id)).toEqual(['r2', 'r1', 'r3']);
    expect(run(ROUTES, cfg, { sort: 'country' })[0]!.country_name).toBe('Burkina Faso');
  });

  it('open the route, and unfold fees, limits and terms', () => {
    expect(cfg.actions![0]!.to!(ROUTES[0]!)).toBe('/configuration/routes/r1');
    const out = wrap(<>{cfg.summary!(ROUTES[1]!)}</>);
    expect(out).toContain('indicatif');
    expect(out).toContain('100');
    expect(out).toMatch(/500,000<\/span> <span class="amount-currency">XOF/);
    const usd = wrap(<>{cfg.summary!(route({ currency_code: 'USD', minimum_amount: 150, maximum_amount: 12345 }))}</>);
    expect(usd).toContain('1.50');
    expect(usd).toContain('123.45');
  });
});

describe('projects', () => {
  const projects = [
    { id: 'a', name: 'Alpha', code: 'alpha', status: 'active', volume_30d: 3, value_30d: [{ currency: 'XAF', value: 3000 }], balances: [], routes_granted: 1, credentials_active: 1, created_at: '2026-10-01T00:00:00Z' },
    { id: 'b', name: 'Beta', code: 'beta', status: 'suspended', volume_30d: 90, value_30d: [{ currency: 'XAF', value: 9 }, { currency: 'XOF', value: 1 }], balances: [{ currency: 'XAF', available: 5, reserved: 1 }], routes_granted: 2, credentials_active: 2, created_at: '2026-09-01T00:00:00Z' },
  ];
  const cfg = projectList({ t: fr, rows: projects });
  it('sort by 30-day volume, and by name first', () => {
    expect(cfg.defaultSort).toBe('name');
    expect(run(projects, cfg, { sort: 'volume', order: 'desc' }).map((p) => p.id)).toEqual(['b', 'a']);
    expect(run(projects, cfg, { sort: 'created' }).map((p) => p.id)).toEqual(['b', 'a']);
  });
  it('keep each currency’s value apart in the summary', () => {
    const out = wrap(<>{cfg.summary!(projects[1]!)}</>);
    expect(out).toContain('XAF');
    expect(out).toContain('XOF');
    expect(out).toContain('Valeur sur 30 jours');
  });
  it('filter by status and explain an empty list', () => {
    expect(run(projects, cfg, { filters: { status: 'suspended' } }).map((p) => p.id)).toEqual(['b']);
    expect(wrap(<DataTable rows={[]} {...cfg} />)).toContain('Aucun projet');
  });
});

describe('approvals', () => {
  const mine = { id: 'q1', type: 'cashout', summary: 'Cashout 5 000 XAF', amount: 5000, currency_code: 'XAF', initiator_name: 'Ada', own: false, can_act: true, justification: 'Month end', subject: { amount: 5000 }, created_at: '2026-11-01T00:00:00Z' };
  const cfg = approvalList({ t: fr, rows: [mine], reload: none });
  it('keep their code-confirmed decision in the summary', () => {
    const out = wrap(<>{cfg.summary!(mine)}</>);
    // The panel speaks the session's language (English outside a provider), as the ConfirmedAction inside it does.
    expect(out).toContain('<button class="primary">Approve</button>');
    expect(out).toContain('Decline');
    expect(out).toContain('Reason for declining');
    expect(out).toContain('Month end');
    expect(cfg.actions!.map((a) => [a.label, a.opens])).toEqual([['Approuver', true], ['Refuser', true]]);
  });
  it('offer no decision on one’s own request, or without the permission', () => {
    for (const r of [{ ...mine, own: true }, { ...mine, can_act: false }]) {
      expect(cfg.actions!.every((a) => !a.when!(r))).toBe(true);
      const out = wrap(<>{cfg.summary!(r)}</>);
      expect(out).not.toContain('Reason for declining');
      expect(out).not.toContain('>Approve<');
    }
    expect(cfg.actions!.every((a) => a.when!(mine))).toBe(true);
  });
  it('are ordered by the longest wait, and filtered by type', () => {
    const older = { ...mine, id: 'q2', type: 'role_change', created_at: '2026-10-01T00:00:00Z' };
    expect(run([mine, older], cfg, { sort: 'waiting', order: 'desc' }).map((r) => r.id)).toEqual(['q2', 'q1']);
    expect(run([mine, older], cfg, { filters: { type: 'role_change' } }).map((r) => r.id)).toEqual(['q2']);
  });
});

describe('countries', () => {
  const cm = { code: 'CM', iso3: 'CMR', name: 'Cameroun', dialling_prefix: '+237', currencies: ['XAF'], active: true };
  const bf = { ...cm, code: 'BF', iso3: 'BFA', name: 'Burkina Faso', currencies: ['XOF'], active: false };
  it('open their row for Désactiver or Activer, with the permission, one for each state', () => {
    const cfg = countryList({ t: fr, has: () => true, done: none });
    const labels = (c: typeof cm) => cfg.actions!.filter((a) => a.when!(c)).map((a) => [a.label, a.opens]);
    expect(labels(cm)).toEqual([['Désactiver', true]]);
    expect(labels(bf)).toEqual([['Activer', true]]);
    const without = countryList({ t: fr, has: () => false, done: none });
    expect(without.actions!.every((a) => !a.when!(cm) && !a.when!(bf))).toBe(true);
  });
  it('offer a decision only when the opened action matches the country’s current state', () => {
    expect(decidesCountry(cm, 'Désactiver', fr)).toBe(true);
    expect(decidesCountry({ ...cm, active: false }, 'Désactiver', fr)).toBe(false); // it landed: no stale reactivation
    expect(decidesCountry(bf, 'Activer', fr)).toBe(true);
    expect(decidesCountry(bf, undefined, fr)).toBe(false);
    const cfg = countryList({ t: fr, has: () => true, done: none });
    const panel = (c: typeof cm, open?: string) => (cfg.summary!(c, open) as any).props.items[1].value.props.decision;
    expect(panel({ ...cm, active: false }, 'Désactiver')).toBe(false);
    expect(panel(cm, 'Désactiver')).toBe(true);
  });
  it('hold the impact warning in the summary', () => {
    const cfg = countryList({ t: fr, has: () => true, done: none });
    expect(wrap(<>{cfg.summary!(cm, 'Désactiver')}</>)).toContain('Impact');
    expect(run([cm, bf], cfg, { filters: { active: 'no' } }).map((c) => c.code)).toEqual(['BF']);
  });
});

describe('treasury lists', () => {
  const acc = (id: string, over: Record<string, unknown>) => ({ id, providerAccountName: 'MTN', countryCode: 'CM', currency: 'XAF', direction: 'disbursement', band: 'healthy', balance: 10, openDisbursements: 1, freeLiquidity: 9, outflowPerHour: 2, coverHours: 10, proposedTransfer: null, ...over });
  const accounts = [acc('a', { coverHours: 30 }), acc('b', { coverHours: 5, band: 'critical' }), acc('c', { direction: 'collection', coverHours: null })];
  const cfg = floatAccountList({ t: fr, rows: accounts });
  it('float accounts are ordered by cover, the least covered first, those without a figure last', () => {
    expect(run(accounts, cfg, { sort: cfg.defaultSort }).map((a) => a.id)).toEqual(['b', 'a', 'c']);
    expect(run(accounts, cfg, { filters: { band: 'critical' } }).map((a) => a.id)).toEqual(['b']);
    expect(cfg.filters!.map((f) => f.key)).toEqual(['band', 'currency', 'direction']);
  });
  it('project balances give a project with none a row of its own', () => {
    const rows = balanceRows([{ project: { id: 'p1', name: 'Shop' }, balances: [{ currency: 'XAF', available: 1, reserved: 0 }] }, { project: { id: 'p2', name: 'Idle' }, balances: [] }]);
    expect(rows).toHaveLength(2);
    const bal = projectBalanceList({ t: fr, rows });
    expect(run(rows, bal, { filters: { currency: 'XAF' } }).map((r) => r.project.id)).toEqual(['p1']);
    expect(wrap(<DataTable rows={rows} {...bal} />)).toContain('aucun solde');
    expect(bal.actions![0]!.to!(rows[0]!)).toBe('/projects/p1');
  });
});

describe('a project’s lists', () => {
  const ent = { id: 'e1', route_id: 'r1', country_code: 'CM', payment_method_code: 'MOMO', direction: 'collection', currency_code: 'XAF', active: true, sequence: 2, minimum_amount: null, maximum_amount: null, route_minimum: 100, route_maximum: 900, count_24h: 5, count_30d: 50, processing_fee_bps: 120, route_processing_fee_bps: 150, platform_fee_bps: null, route_platform_fee_bps: 50, processing_fee_bearer: null, route_processing_fee_bearer: 'project', platform_fee_bearer: null, route_platform_fee_bearer: 'project', history: [{ sequence: 1, valid_from: '2026-10-01T00:00:00Z', author: 'Ada', note: 'seed' }] };
  it('entitlements can be deactivated only while active, and by who may', () => {
    const d = entitlementList({ t: fr, has: () => true, reload: none, id: 'p' }).actions![0]!;
    expect(d.label).toBe('Désactiver');
    expect(d.when!(ent)).toBe(true);
    expect(d.when!({ ...ent, active: false })).toBe(false);
    expect(entitlementList({ t: fr, has: () => false, reload: none, id: 'p' }).actions![0]!.when!(ent)).toBe(false);
  });
  it('entitlements unfold limits, velocity, overrides beside the route’s rates, and history', () => {
    const out = wrap(<>{entitlementList({ t: fr, has: () => true, reload: none, id: 'p' }).summary!(ent)}</>);
    const usd = wrap(<>{entitlementList({ t: fr, has: () => true, reload: none, id: 'p' }).summary!({ ...ent, currency_code: 'USD', minimum_amount: 150, route_maximum: 12345 })}</>);
    expect(usd).toContain('1.50');
    expect(usd).toContain('123.45');
    for (const s of ['5/24h', '1.2%', 'Historique des versions', 'seed']) expect(out).toContain(s);
  });
  it('origins are removed through the permission, the latest first', () => {
    const cfg = originList({ t: fr, has: (p) => p === 'projects.origins', reload: none, id: 'p' });
    expect(cfg.actions![0]).toMatchObject({ label: 'Retirer' });
    expect(cfg.actions![0]!.opens).toBeUndefined();
    expect(cfg.actions![0]!.when!({})).toBe(true);
    expect(originList({ t: fr, has: () => false, reload: none, id: 'p' }).actions![0]!.when!({})).toBe(false);
    expect([cfg.defaultSort, cfg.defaultOrder]).toEqual(['added', 'desc']);
    const rows = [{ id: '1', cidr: '10.0.0.0/8', description: '', created_at: '2026-01-01T00:00:00Z' }, { id: '2', cidr: '10.1.0.0/16', description: 'office', created_at: '2026-06-01T00:00:00Z' }];
    expect(run(rows, cfg, { sort: 'added', order: 'desc' }).map((o) => o.id)).toEqual(['2', '1']);
  });
});

describe('administrators and roles', () => {
  const admin = (id: string, o: Record<string, unknown> = {}) => ({ id, name: id, email: `${id}@x.io`, status: 'active', language: 'fr', timezone: 'Africa/Douala', last_sign_in_at: null, totp_enrolled_at: '2026-01-01T00:00:00Z', locked_until: null, assignments: [{ id: `as-${id}`, role_name: 'Operator', scope_type: 'all', scopes: [] }], ...o });
  const rows = [admin('me'), admin('ada'), admin('bob', { status: 'disabled', assignments: [] })];
  const cfg = administratorList({ t: fr, me: 'me', reload: none }, rows);
  it('can be disabled or re-enabled by someone else, never by themselves, and the change opens the summary', () => {
    const labels = (a: Record<string, unknown>) => cfg.actions!.filter((x) => x.when!(a)).map((x) => [x.label, x.opens]);
    expect(labels(rows[0]!)).toEqual([]);
    expect(labels(rows[1]!)).toEqual([['Désactiver', true]]);
    expect(labels(rows[2]!)).toEqual([['Réactiver', true]]);
  });
  it('keep the code-confirmed status change and role removal in the summary, and none for oneself', () => {
    const other = wrap(<>{cfg.summary!(rows[1]!)}</>);
    expect(other).toContain('Désactiver');
    expect(other).toContain('×');
    expect(other).toContain('Africa/Douala');
    const self = wrap(<>{cfg.summary!(rows[0]!)}</>);
    expect(self).not.toContain('×');
    expect(self).toContain('Vous ne pouvez pas modifier');
  });
  it('filter by status and by role', () => {
    expect(cfg.filters!.map((f) => f.key)).toEqual(['status', 'role']);
    expect(run(rows, cfg, { filters: { status: 'disabled' } }).map((a) => a.id)).toEqual(['bob']);
    expect(run(rows, cfg, { filters: { role: 'Operator' } }).map((a) => a.id)).toEqual(['me', 'ada']);
  });
  it('roles are found by member, list their permissions, and edit through Modifier', () => {
    const role = { id: 'ro', name: 'Auditor', description: 'Reads', seeded: true, permissions: ['oversight.audit', 'projects.read'], administrators: [{ name: 'Ada' }] };
    const edited: unknown[] = [];
    const rc = roleList({ t: fr, edit: (r) => edited.push(r) });
    expect(run([role], rc, { q: 'ada' })).toHaveLength(1);
    expect(wrap(<>{rc.summary!(role)}</>)).toContain('oversight.audit');
    void rc.actions![0]!.run!(role);
    expect(edited).toEqual([role]);
    expect(rc.actions![0]!.opens).toBeUndefined();
  });
});

describe('the bare tables', () => {
  const bindings = [{ id: 'b1', priority: 1, name: 'First' }, { id: 'b2', priority: 2, name: 'Second' }, { id: 'b3', priority: 3, name: 'Third' }];
  const props: DataTableProps<any> = { bare: true, rows: bindings, rowKey: (b: any) => b.id, defaultSort: 'priority', columns: [{ key: 'priority', label: '#', sortValue: (b: any) => 4 - b.priority, render: (b: any) => b.priority }, { key: 'name', label: 'Nom', render: (b: any) => b.name }], empty: { none: 'Aucun.', why: 'Parce que.' } };
  it('route bindings keep priority order and offer no sort', () => {
    const out = wrap(<DataTable<any> {...props} />);
    expect(out.indexOf('First')).toBeLessThan(out.indexOf('Second'));
    expect(out.indexOf('Second')).toBeLessThan(out.indexOf('Third'));
    expect(out).not.toContain('class="sort"');
    expect(out).not.toContain('aria-sort');
    expect(out).not.toContain('role="search"');
    expect(out).not.toContain('class="dt-foot"');
  });
  it('say what would appear when empty', () => {
    expect(wrap(<DataTable<any> {...props} rows={[]} />)).toContain('Aucun. Parce que.');
  });
});
