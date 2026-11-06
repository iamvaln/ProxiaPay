import { resolveLimits, resolveTerms, type EntitlementVersionRow, type RouteVersionRow } from '../routes/route-resolver';
import type { ApiTransaction } from '../transactions/transaction-reader';

/**
 * What a client account is shown (client accounts spec, goal 5): what the client is charged, and nothing of
 * what ProxiaPay pays or earns. Each mapper builds its object from a list of fields and never spreads its
 * input, so a field added to a platform response stays out of the client's until someone adds it here.
 */

export interface ClientBalance { currency: string; available: number; reserved: number }

export interface ClientTransactionDetail {
  reference: string;
  project_reference: string;
  project: { id: string; code: string; name: string };
  direction: string;
  state: string;
  created_at: string;
  terminal_at: string | null;
  country: string;
  payment_method: string;
  payment_method_name: string;
  currency: string;
  requested_amount: number;
  charged_amount: number;
  processing_fee: number;
  platform_fee: number;
  processing_fee_bearer: string;
  platform_fee_bearer: string;
  msisdn_masked: string;
  failure_reason: string | null;
  attempts: { started_at: Date; ended_at: Date | null; state: string; failure_reason: string | null; operator_reference: string | null }[];
  notifications: { event_type: string; status: string; attempts: number; last_attempt_at: Date | null }[];
}

export interface ClientRoute {
  country: string;
  payment_method: string;
  payment_method_name: string;
  direction: string;
  currency: string;
  active: boolean;
  fees: { processing_bps: number; processing_fixed: number; processing_bearer: string; platform_bps: number; platform_fixed: number; platform_bearer: string };
  limits: { minimum_amount: number; maximum_amount: number; count_24h: number; value_24h: number; count_30d: number; value_30d: number };
}

export interface ClientProjectDetail {
  project: { id: string; code: string; name: string; status: string; created_at: Date };
  credentials: { id: string; key: string; scopes: string[]; role: string; status: string; issued_at: Date }[];
  origins: { id: string; cidr: string; description: string; created_at: Date }[];
  notification_endpoint: { url: string } | null;
  routes: ClientRoute[];
  balances: ClientBalance[];
  /** No route is open yet: ProxiaPay has still to grant one (production) or every grant is closed. */
  waiting_for_routes: boolean;
}

/** The parts of the platform's transaction detail a client view is built from. */
interface PlatformTransactionDetail {
  transaction: ApiTransaction;
  project: { id: string; code: string; name: string };
  amounts: { requested: number; charged: number; processing_fee: number; platform_fee: number; processing_fee_bearer: string; platform_fee_bearer: string };
  attempts: { started_at: Date; ended_at: Date | null; state: string; failure_reason: string | null; operator_reference: string | null }[];
  payer: { masked: string };
  notifications: { event_type: string; status: string; attempts: { attempted_at: Date }[] }[];
}

/** The parts of the platform's project detail a client view is built from; its entitlements are not among them. */
interface PlatformProjectDetail {
  project: { id: string; code: string; name: string; status: string; created_at: Date };
  balances: ClientBalance[];
  credentials: { id: string; key: string; scopes: string[]; role: string; status: string; issued_at: Date }[];
  origins: { id: string; cidr: string; description: string; created_at: Date }[];
  notification_endpoint: { url: string } | null;
}

/** One grant of the project with the route it opens, as `EntitlementService.termsForProject` reads them. */
export interface GrantedRoute {
  country_code: string;
  payment_method_code: string;
  payment_method_name: string;
  direction: string;
  currency_code: string;
  country_active: boolean;
  routeVersion: RouteVersionRow;
  entitlementVersion: EntitlementVersionRow;
}

export function clientBalances(rows: ClientBalance[]): ClientBalance[] {
  return rows.map((b) => ({ currency: b.currency, available: b.available, reserved: b.reserved }));
}

/** `route` carries the payment method's display name, which the platform detail does not. */
export function clientTransactionDetail(d: PlatformTransactionDetail, route: { payment_method_name: string }): ClientTransactionDetail {
  const t = d.transaction;
  return {
    reference: t.reference, project_reference: t.project_reference, project: { id: d.project.id, code: d.project.code, name: d.project.name },
    direction: t.direction, state: t.state, created_at: t.created_at, terminal_at: t.terminal_at,
    country: t.route.country, payment_method: t.route.payment_method, payment_method_name: route.payment_method_name, currency: t.currency,
    requested_amount: d.amounts.requested, charged_amount: d.amounts.charged, processing_fee: d.amounts.processing_fee, platform_fee: d.amounts.platform_fee,
    processing_fee_bearer: d.amounts.processing_fee_bearer, platform_fee_bearer: d.amounts.platform_fee_bearer, msisdn_masked: d.payer.masked,
    failure_reason: t.failure_reason,
    attempts: d.attempts.map((a) => ({ started_at: a.started_at, ended_at: a.ended_at, state: a.state, failure_reason: a.failure_reason, operator_reference: a.operator_reference })),
    notifications: d.notifications.map((n) => ({
      event_type: n.event_type, status: n.status, attempts: n.attempts.length,
      last_attempt_at: n.attempts.reduce<Date | null>((last, a) => (last === null || a.attempted_at > last ? a.attempted_at : last), null),
    })),
  };
}

/** The client's own terms on each route, resolved exactly as `/v1/settings` resolves them, so the console and the API agree. */
export function clientRoute(g: GrantedRoute): ClientRoute {
  const terms = resolveTerms(g.routeVersion, g.entitlementVersion);
  const limits = resolveLimits(g.routeVersion, g.entitlementVersion);
  return {
    country: g.country_code, payment_method: g.payment_method_code, payment_method_name: g.payment_method_name, direction: g.direction, currency: g.currency_code,
    active: g.country_active && g.routeVersion.active && g.entitlementVersion.active,
    fees: {
      processing_bps: terms.processing.bps, processing_fixed: terms.processing.fixed, processing_bearer: terms.processingBearer,
      platform_bps: terms.platform.bps, platform_fixed: terms.platform.fixed, platform_bearer: terms.platformBearer,
    },
    limits: { minimum_amount: limits.minimum, maximum_amount: limits.maximum, count_24h: limits.count24h, value_24h: limits.value24h, count_30d: limits.count30d, value_30d: limits.value30d },
  };
}

export function clientProjectDetail(d: PlatformProjectDetail, granted: GrantedRoute[]): ClientProjectDetail {
  const routes = granted.map(clientRoute);
  return {
    project: { id: d.project.id, code: d.project.code, name: d.project.name, status: d.project.status, created_at: d.project.created_at },
    credentials: d.credentials.map((c) => ({ id: c.id, key: c.key, scopes: c.scopes, role: c.role, status: c.status, issued_at: c.issued_at })),
    origins: d.origins.map((o) => ({ id: o.id, cidr: o.cidr, description: o.description, created_at: o.created_at })),
    notification_endpoint: d.notification_endpoint ? { url: d.notification_endpoint.url } : null,
    routes,
    balances: clientBalances(d.balances),
    waiting_for_routes: !routes.some((r) => r.active),
  };
}

/** A row of the projects list, without who created the project. */
export function clientProjectSummary(p: {
  id: string; code: string; name: string; status: string; created_at: Date;
  volume_30d: number; value_30d: { currency: string; value: number }[]; balances: ClientBalance[]; routes_granted: number; credentials_active: number;
}) {
  return {
    id: p.id, code: p.code, name: p.name, status: p.status, created_at: p.created_at, volume_30d: p.volume_30d,
    value_30d: p.value_30d.map((v) => ({ currency: v.currency, value: v.value })), balances: clientBalances(p.balances), routes_granted: p.routes_granted, credentials_active: p.credentials_active,
  };
}

/** The transaction list's columns a client sees: the platform's, without the provider's account and reference. */
export const CLIENT_TRANSACTION_COLUMNS = ['id', 'reference', 'project_reference', 'direction', 'state', 'reconciliation_status', 'currency_code', 'requested_amount', 'charged_amount', 'settled_amount',
  'failure_reason', 'created_at', 'terminal_at', 'msisdn_masked', 'processing_fee', 'platform_fee', 'processing_fee_bearer', 'platform_fee_bearer', 'project_name', 'project_id', 'country_code', 'payment_method_code',
  'operator_reference'] as const;

export function clientTransactionRow<R extends Record<(typeof CLIENT_TRANSACTION_COLUMNS)[number], unknown>>(row: R): Pick<R, (typeof CLIENT_TRANSACTION_COLUMNS)[number]> {
  const out = {} as Pick<R, (typeof CLIENT_TRANSACTION_COLUMNS)[number]>;
  for (const c of CLIENT_TRANSACTION_COLUMNS) out[c] = row[c];
  return out;
}
