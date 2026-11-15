import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { CONFIG, type AppConfig } from '../config/config';
import { DB_TOKEN, type Db, type Executor } from '../db/database';
import { formatAmount, subtract } from '../money/money';
import type { ProjectPrincipal } from '../project-auth/project-auth.service';
import { RouteResolver, resolveLimits } from '../routes/route-resolver';

export const LINK_UNAVAILABLE_MESSAGE = 'This link is no longer available';
export const METHOD_UNAVAILABLE_MESSAGE = 'This payment method is not available on this link.';

/** What the payment page shows: the project's face and what each method charges, never an internal id or ProxiaPay's economics. */
export interface PublicLinkView {
  code: string;
  project_name: string;
  title: string;
  description: string | null;
  amount_type: 'fixed' | 'free';
  amount: number | null;
  minimum_amount: number;
  currency: string;
  exponent: number;
  sandbox: boolean;
  brand: { logo_url: string | null; primary_color: string; secondary_color: string | null };
  countries: { code: string; name: string; dialling_prefix: string }[];
  methods: { key: string; country: string; name: string; minimum_amount: number; maximum_amount: number; charged_amount?: number }[];
}

/** A link as the public surface reads it: only once it is known to be payable. */
export interface OpenLink {
  id: string; code: string; project_id: string; project_code: string; project_name: string; project_active: boolean;
  title: string; description: string | null; amount_type: 'fixed' | 'free'; amount: number | null; minimum_amount: number; currency_code: string; exponent: number;
  single_use: boolean; logo_asset_id: string | null; primary_color: string; secondary_color: string | null;
}

/** A method the payer can use right now; `routeId` stays on the server. */
export interface UsableMethod {
  key: string; routeId: string; country: string; countryName: string; diallingPrefix: string; paymentMethod: string; name: string;
  /** The effective floor: the higher of the route's (as the entitlement narrows it) and, on a free link, the link's minimum. */
  minimum: number;
  maximum: number;
}

/**
 * The project a link pays into, as the preview and confirmation services see a caller. They read only
 * `projectId` and `scopes`; a link has no credential or token, so those stay empty.
 */
export function linkPrincipal(link: { project_id: string; project_code: string }): ProjectPrincipal {
  return { projectId: link.project_id, projectCode: link.project_code, scopes: ['collection'], credentialId: '', credentialKey: '', tokenId: '' };
}

/** The plain refusal a payer sees for an amount outside what the link and method take, or null when it fits. */
export function amountRefusal(method: Pick<UsableMethod, 'minimum' | 'maximum'>, amount: number, currency: string, exponent: number): PlatformError | null {
  if (amount < method.minimum) return new PlatformError('FIELD_INVALID', `The amount must be at least ${formatAmount(method.minimum, exponent)} ${currency}.`, { field: 'amount' });
  if (amount > method.maximum) return new PlatformError('FIELD_INVALID', `The amount must be at most ${formatAmount(method.maximum, exponent)} ${currency}.`, { field: 'amount' });
  return null;
}

const unavailable = () => new PlatformError('LINK_UNAVAILABLE', LINK_UNAVAILABLE_MESSAGE);
const methodUnavailable = () => new PlatformError('FIELD_INVALID', METHOD_UNAVAILABLE_MESSAGE, { field: 'method' });
const CODE = /^[0-9A-Za-z]{10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The payment link as the public page reads it: no session, no credential, one neutral answer for any link that cannot be paid. */
@Injectable()
export class PublicLinkService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'PROXIAPAY_ENV'>,
    private readonly resolver: RouteResolver,
  ) {}

  /** An unknown, disabled, completed or expired link all answer the same, so the page reveals nothing about which. */
  async open(exec: Executor, code: string): Promise<OpenLink> {
    if (!CODE.test(code)) throw unavailable();
    const row = await exec.selectFrom('payment_link as l')
      .innerJoin('project as p', 'p.id', 'l.project_id')
      .innerJoin('currency as cur', 'cur.code', 'l.currency_code')
      .select(['l.id', 'l.code', 'l.project_id', 'p.code as project_code', 'p.name as project_name', 'p.status as project_status', 'l.title', 'l.description', 'l.amount_type', 'l.amount',
        'l.minimum_amount', 'l.currency_code', 'cur.exponent', 'l.single_use', 'l.status', 'l.expires_at', 'l.logo_asset_id', 'l.primary_color', 'l.secondary_color'])
      .where('l.code', '=', code).executeTakeFirst();
    if (!row || row.status !== 'active' || (row.expires_at && row.expires_at.getTime() <= Date.now())) throw unavailable();
    return {
      id: row.id, code: row.code, project_id: row.project_id, project_code: row.project_code, project_name: row.project_name, project_active: row.project_status === 'active',
      title: row.title, description: row.description, amount_type: row.amount_type as OpenLink['amount_type'], amount: row.amount, minimum_amount: row.minimum_amount,
      currency_code: row.currency_code, exponent: row.exponent, single_use: row.single_use, logo_asset_id: row.logo_asset_id, primary_color: row.primary_color, secondary_color: row.secondary_color,
    };
  }

  /**
   * The link's methods a payer can use now: the route's open version, its country, the project's entitlement and the
   * project itself all active, and nothing for the payer to type or open. A method whose floor passes its maximum is dropped.
   */
  async methods(exec: Executor, link: OpenLink): Promise<UsableMethod[]> {
    if (!link.project_active) return [];
    const rows = await exec.selectFrom('payment_link_route as lr')
      .innerJoin('route as r', 'r.id', 'lr.route_id')
      .innerJoin('route_version as rv', (j) => j.onRef('rv.route_id', '=', 'r.id').on('rv.valid_to', 'is', null))
      .innerJoin('country as c', 'c.code', 'r.country_code')
      .innerJoin('payment_method as pm', 'pm.code', 'r.payment_method_code')
      .innerJoin('entitlement as e', (j) => j.onRef('e.route_id', '=', 'r.id').on('e.project_id', '=', link.project_id))
      .innerJoin('entitlement_version as ev', (j) => j.onRef('ev.entitlement_id', '=', 'e.id').on('ev.valid_to', 'is', null))
      .select(['lr.id as key', 'r.id as route_id', 'r.country_code', 'c.name as country_name', 'c.dialling_prefix', 'r.payment_method_code', 'pm.name',
        'rv.minimum_amount as rv_min', 'rv.maximum_amount as rv_max', 'ev.minimum_amount as ev_min', 'ev.maximum_amount as ev_max', 'ev.count_24h', 'ev.value_24h', 'ev.count_30d', 'ev.value_30d'])
      .where('lr.link_id', '=', link.id)
      .where('r.direction', '=', 'collection').where('r.currency_code', '=', link.currency_code)
      .where('rv.active', '=', true).where('rv.otp_required', '=', false).where('rv.browser_required', '=', false)
      .where('c.active', '=', true).where('ev.active', '=', true)
      .orderBy('r.country_code').orderBy('pm.name').execute();
    return rows.flatMap((r) => {
      const limits = resolveLimits({ minimum_amount: r.rv_min, maximum_amount: r.rv_max }, { minimum_amount: r.ev_min, maximum_amount: r.ev_max, count_24h: r.count_24h, value_24h: r.value_24h, count_30d: r.count_30d, value_30d: r.value_30d });
      const minimum = link.amount_type === 'free' ? Math.max(limits.minimum, link.minimum_amount) : limits.minimum;
      if (minimum > limits.maximum) return [];
      return [{ key: r.key, routeId: r.route_id, country: r.country_code, countryName: r.country_name, diallingPrefix: r.dialling_prefix, paymentMethod: r.payment_method_code, name: r.name, minimum, maximum: limits.maximum }];
    });
  }

  /** What the payer is charged for an amount on a method, priced as a preview prices it; null when the route refuses it. */
  private async charged(exec: Executor, link: OpenLink, method: UsableMethod, amount: number): Promise<number | null> {
    try {
      const resolution = await this.resolver.resolve(exec, { projectId: link.project_id, direction: 'collection', country: method.country, currency: link.currency_code, paymentMethod: method.paymentMethod, amount });
      return this.resolver.computeFigures(resolution, amount, undefined).chargedAmount;
    } catch (e) {
      if (e instanceof PlatformError) return null;
      throw e;
    }
  }

  async view(code: string): Promise<PublicLinkView> {
    const link = await this.open(this.db, code);
    const usable = await this.methods(this.db, link);
    const methods: PublicLinkView['methods'] = [];
    for (const m of usable) {
      const entry = { key: m.key, country: m.country, name: m.name, minimum_amount: m.minimum, maximum_amount: m.maximum };
      if (link.amount_type === 'free') { methods.push(entry); continue; }
      // A fixed amount the method no longer takes (an entitlement narrowed since) leaves the method off the page.
      if (link.amount! < m.minimum || link.amount! > m.maximum) continue;
      const charged = await this.charged(this.db, link, m, link.amount!);
      if (charged !== null) methods.push({ ...entry, charged_amount: charged });
    }
    const offered = usable.filter((m) => methods.some((x) => x.key === m.key));
    const countries = [...new Map(offered.map((m) => [m.country, { code: m.country, name: m.countryName, dialling_prefix: m.diallingPrefix }])).values()];
    return {
      code: link.code, project_name: link.project_name, title: link.title, description: link.description, amount_type: link.amount_type, amount: link.amount,
      minimum_amount: link.minimum_amount, currency: link.currency_code, exponent: link.exponent, sandbox: this.config.PROXIAPAY_ENV === 'sandbox',
      brand: { logo_url: link.logo_asset_id ? `/pay-api/v1/assets/${link.logo_asset_id}` : null, primary_color: link.primary_color, secondary_color: link.secondary_color },
      countries, methods,
    };
  }

  /** The charge for an amount on one of the link's methods, computed as a preview would, creating nothing. */
  async quote(code: string, body: unknown): Promise<{ charged_amount: number; fees_borne_by_payer: number }> {
    const link = await this.open(this.db, code);
    const input = (typeof body === 'object' && body !== null ? body : {}) as { method?: unknown; amount?: unknown };
    const method = typeof input.method === 'string' && UUID.test(input.method) ? (await this.methods(this.db, link)).find((m) => m.key === input.method) : undefined;
    if (!method) throw methodUnavailable();
    const amount = this.amountOf(link, input.amount);
    const refusal = amountRefusal(method, amount, link.currency_code, link.exponent);
    if (refusal) throw refusal;
    const charged = await this.charged(this.db, link, method, amount);
    if (charged === null) throw methodUnavailable();
    return { charged_amount: charged, fees_borne_by_payer: subtract(charged, amount) };
  }

  /** A fixed link's amount is its own; a free link's is the payer's, a positive whole number of minor units. */
  amountOf(link: OpenLink, given: unknown): number {
    if (link.amount_type === 'fixed') {
      if (given !== undefined && given !== link.amount) throw new PlatformError('FIELD_INVALID', 'This link has a set amount.', { field: 'amount' });
      return link.amount!;
    }
    if (typeof given !== 'number' || !Number.isSafeInteger(given) || given <= 0) throw new PlatformError('FIELD_INVALID', 'Enter the amount to pay.', { field: 'amount' });
    return given;
  }

  /** A logo, only while an active link or a project's brand shows it: an asset nothing shows any more is not served. */
  async asset(id: string): Promise<{ bytes: Buffer; content_type: string }> {
    const row = await this.db.selectFrom('brand_asset as a').select(['a.bytes', 'a.content_type']).where('a.id', '=', id)
      .where((eb) => eb.or([
        eb.exists(eb.selectFrom('project_brand as b').select('b.project_id').whereRef('b.logo_asset_id', '=', 'a.id')),
        eb.exists(eb.selectFrom('payment_link as l').select('l.id').whereRef('l.logo_asset_id', '=', 'a.id').where('l.status', '=', 'active')
          .where((w) => w.or([w('l.expires_at', 'is', null), w('l.expires_at', '>', sql<Date>`now()`)]))),
      ])).executeTakeFirst();
    if (!row) throw new PlatformError('NOT_FOUND', 'No such resource.');
    return row;
  }
}
