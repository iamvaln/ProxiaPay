import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { CONFIG, type AppConfig } from '../config/config';
import { DB_TOKEN, type Db, type Tx } from '../db/database';
import { nonEmpty } from '../http/validation';
import { resolveLimits, type EntitlementVersionRow } from '../routes/route-resolver';
import { COLOR_FORMAT_MESSAGE, COLOR_MESSAGE, isHexColor, isUsableColor } from './brand';
import { BrandService } from './brand.service';

/** The entitlement's velocity columns, read with its amounts so the limits resolve as at payment time. */
const VELOCITY = ['ev.count_24h', 'ev.value_24h', 'ev.count_30d', 'ev.value_30d'] as const;
/** A route's limits as narrowed by the project's entitlement, from one row read with both. */
const limitsOf = (r: { route_minimum: number; route_maximum: number; entitlement_minimum: number | null; entitlement_maximum: number | null } & Pick<EntitlementVersionRow, 'count_24h' | 'value_24h' | 'count_30d' | 'value_30d'>) =>
  resolveLimits({ minimum_amount: r.route_minimum, maximum_amount: r.route_maximum }, { minimum_amount: r.entitlement_minimum, maximum_amount: r.entitlement_maximum, count_24h: r.count_24h, value_24h: r.value_24h, count_30d: r.count_30d, value_30d: r.value_30d });

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CODE_LENGTH = 10;

/** Ten base62 characters from the system's random source; bytes above 247 are dropped so no character is likelier than another. */
export function newLinkCode(): string {
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const b of randomBytes(CODE_LENGTH * 2)) if (b < 248 && code.length < CODE_LENGTH) code += BASE62[b % 62];
  }
  return code;
}

const amountOf = z.number({ error: 'must be an integer' }).int('must be an integer in minor units').positive('must be positive').max(Number.MAX_SAFE_INTEGER);

export const linkInputSchema = z.object({
  title: nonEmpty(120),
  description: z.string().trim().max(500).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  amount_type: z.enum(['fixed', 'free']),
  amount: amountOf.optional(),
  minimum_amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  route_ids: z.array(z.string().uuid()).min(1),
  single_use: z.boolean().optional(),
  expires_at: z.string().datetime().refine((v) => new Date(v).getTime() > Date.now(), 'must be in the future').optional(),
  brand: z.object({ logo_asset_id: z.string().uuid().nullish(), primary_color: z.string().optional(), secondary_color: z.string().nullish() }).optional(),
});
export type LinkInput = z.infer<typeof linkInputSchema>;

export interface LinkEntry {
  id: string; code: string; url: string; title: string; amount_type: string; amount: number | null; minimum_amount: number; currency: string;
  single_use: boolean; expires_at: Date | null; status: string;
  methods: { country: string; payment_method: string; payment_method_name: string }[];
  payments: { count: number; succeeded: number; total_collected: number; last_at: Date | null };
}

/** A project's payment links: made over routes the payer can complete on a phone alone, and read with what they collected. */
@Injectable()
export class LinksService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'PAYLINK_BASE_URL'>,
    private readonly audit: AuditService,
    private readonly brand: BrandService,
  ) {}

  private urlOf(code: string): string {
    return `${this.config.PAYLINK_BASE_URL!.replace(/\/+$/, '')}/${code}`;
  }

  async create(tx: Tx, projectId: string, input: LinkInput, actorId: string): Promise<{ id: string; code: string; url: string }> {
    if (!this.config.PAYLINK_BASE_URL) throw new PlatformError('RULE_VIOLATION', 'Payment links are not configured on this platform.');
    if (input.amount_type === 'fixed' && input.amount === undefined) throw new PlatformError('AMOUNT_INVALID', 'A fixed link needs an amount.', { field: 'amount' });
    if (input.amount_type === 'free' && input.amount !== undefined) throw new PlatformError('FIELD_INVALID', 'A link where the payer chooses the amount takes no amount.', { field: 'amount' });
    const routeIds = [...new Set(input.route_ids)];
    await this.checkRoutes(tx, projectId, input, routeIds);
    const brand = await this.brandFor(tx, projectId, input.brand);

    const values = {
      project_id: projectId, title: input.title, description: input.description || null, currency_code: input.currency, amount_type: input.amount_type,
      amount: input.amount_type === 'fixed' ? input.amount! : null, minimum_amount: input.minimum_amount, single_use: input.single_use ?? false,
      expires_at: input.expires_at ? new Date(input.expires_at) : null, logo_asset_id: brand.logo_asset_id, primary_color: brand.primary_color, secondary_color: brand.secondary_color, created_by: actorId,
    };
    // A taken code is not an error: the insert skips it and a new one is drawn.
    let link: { id: string; code: string } | undefined;
    for (let attempt = 0; !link && attempt < 5; attempt++) {
      link = await tx.insertInto('payment_link').values({ ...values, code: newLinkCode() }).onConflict((oc) => oc.column('code').doNothing()).returning(['id', 'code']).executeTakeFirst();
    }
    if (!link) throw new PlatformError('RULE_VIOLATION', 'A link code could not be drawn. Try again.');
    await tx.insertInto('payment_link_route').values(routeIds.map((route_id) => ({ link_id: link!.id, route_id }))).execute();
    await this.audit.record(tx, { actorId, action: 'payment_link.create', subjectType: 'payment_link', subjectId: link.id, next: { project_id: projectId, code: link.code, title: input.title, currency: input.currency, amount_type: input.amount_type, amount: values.amount, minimum_amount: input.minimum_amount, single_use: values.single_use, expires_at: values.expires_at, route_ids: routeIds, brand } });
    return { id: link.id, code: link.code, url: this.urlOf(link.code) };
  }

  /** Every route must be an active collection route of the project in the link's currency with no step for the payer beyond their phone, and the amounts must fit every one. */
  private async checkRoutes(tx: Tx, projectId: string, input: LinkInput, routeIds: string[]) {
    const bad = (message: string) => new PlatformError('FIELD_INVALID', message, { field: 'route_ids' });
    const rows = await tx.selectFrom('route as r')
      .innerJoin('route_version as rv', (j) => j.onRef('rv.route_id', '=', 'r.id').on('rv.valid_to', 'is', null))
      .innerJoin('entitlement as e', (j) => j.onRef('e.route_id', '=', 'r.id').on('e.project_id', '=', projectId))
      .innerJoin('entitlement_version as ev', (j) => j.onRef('ev.entitlement_id', '=', 'e.id').on('ev.valid_to', 'is', null))
      .select(['r.id', 'r.direction', 'r.currency_code', 'rv.active as route_active', 'rv.otp_required', 'rv.browser_required', 'rv.minimum_amount as route_minimum', 'rv.maximum_amount as route_maximum',
        'ev.active as entitlement_active', 'ev.minimum_amount as entitlement_minimum', 'ev.maximum_amount as entitlement_maximum', ...VELOCITY])
      .where('r.id', 'in', routeIds).execute();
    for (const id of routeIds) {
      const r = rows.find((x) => x.id === id);
      if (!r) throw bad('Every route must be one this project is entitled to.');
      if (r.direction !== 'collection') throw bad('A link takes collection routes only.');
      if (r.currency_code !== input.currency) throw bad(`Every route must be in ${input.currency}.`);
      if (!r.route_active || !r.entitlement_active) throw bad('Every route must be active.');
      if (r.otp_required || r.browser_required) throw bad('A link cannot use a route where the payer must type a code or open a page.');
    }
    for (const r of rows) {
      const limits = limitsOf(r);
      if (input.amount_type === 'fixed' && (input.amount! < limits.minimum || input.amount! > limits.maximum)) throw new PlatformError('AMOUNT_INVALID', `The amount must be between ${limits.minimum} and ${limits.maximum} on every route.`, { field: 'amount' });
      if (input.amount_type === 'free' && input.minimum_amount > limits.maximum) throw new PlatformError('AMOUNT_INVALID', `The minimum cannot be above ${limits.maximum}, the most a route takes.`, { field: 'minimum_amount' });
    }
  }

  /** What the page is painted with: the brand named in the request over the project's own, each part falling back to it. */
  private async brandFor(tx: Tx, projectId: string, given: LinkInput['brand']) {
    const base = await this.brand.get(projectId);
    if (!given) return base;
    const logo = given.logo_asset_id === undefined ? base.logo_asset_id : given.logo_asset_id;
    if (logo && !(await tx.selectFrom('brand_asset').select('id').where('id', '=', logo).where('project_id', '=', projectId).executeTakeFirst())) throw new PlatformError('FIELD_INVALID', 'That logo does not belong to this project.', { field: 'brand.logo_asset_id' });
    const primary = given.primary_color ?? base.primary_color;
    const secondary = given.secondary_color === undefined ? base.secondary_color : given.secondary_color;
    for (const [field, value] of [['brand.primary_color', primary], ['brand.secondary_color', secondary]] as const) {
      if (value === null) continue;
      if (!isHexColor(value)) throw new PlatformError('FIELD_INVALID', COLOR_FORMAT_MESSAGE, { field });
      if (!isUsableColor(value)) throw new PlatformError('FIELD_INVALID', COLOR_MESSAGE, { field });
    }
    return { logo_asset_id: logo ?? null, primary_color: primary, secondary_color: secondary };
  }

  /** The routes a link can be made over: the project's active collection routes with no step for the payer beyond their phone. Method names only, never a provider. */
  async usableRoutes(projectId: string): Promise<{ id: string; country: string; payment_method: string; payment_method_name: string; currency: string; exponent: number; minimum_amount: number; maximum_amount: number }[]> {
    const rows = await this.db.selectFrom('route as r')
      .innerJoin('route_version as rv', (j) => j.onRef('rv.route_id', '=', 'r.id').on('rv.valid_to', 'is', null))
      .innerJoin('entitlement as e', (j) => j.onRef('e.route_id', '=', 'r.id').on('e.project_id', '=', projectId))
      .innerJoin('entitlement_version as ev', (j) => j.onRef('ev.entitlement_id', '=', 'e.id').on('ev.valid_to', 'is', null))
      .innerJoin('payment_method as pm', 'pm.code', 'r.payment_method_code')
      // The currency's decimals, so the console converts what an owner types without guessing them.
      .innerJoin('currency as c', 'c.code', 'r.currency_code')
      .select(['r.id', 'r.country_code', 'r.payment_method_code', 'pm.name', 'r.currency_code', 'c.exponent', 'rv.minimum_amount as route_minimum', 'rv.maximum_amount as route_maximum', 'ev.minimum_amount as entitlement_minimum', 'ev.maximum_amount as entitlement_maximum', ...VELOCITY])
      .where('r.direction', '=', 'collection').where('rv.active', '=', true).where('ev.active', '=', true).where('rv.otp_required', '=', false).where('rv.browser_required', '=', false)
      .orderBy('r.country_code').orderBy('r.payment_method_code').execute();
    return rows.map((r) => {
      const limits = limitsOf(r);
      return { id: r.id, country: r.country_code, payment_method: r.payment_method_code, payment_method_name: r.name, currency: r.currency_code, exponent: r.exponent, minimum_amount: Number(limits.minimum), maximum_amount: Number(limits.maximum) };
    });
  }

  async disable(tx: Tx, projectId: string, linkId: string, actorId: string): Promise<{ id: string; status: string }> {
    const link = await tx.selectFrom('payment_link').select(['id', 'status']).where('id', '=', linkId).where('project_id', '=', projectId).forUpdate().executeTakeFirst();
    if (!link) throw new PlatformError('NOT_FOUND', 'No such payment link.');
    if (link.status === 'completed') throw new PlatformError('RULE_VIOLATION', 'This link has been paid and is closed.');
    if (link.status === 'disabled') return { id: link.id, status: 'disabled' };
    await tx.updateTable('payment_link').set({ status: 'disabled' }).where('id', '=', linkId).execute();
    await this.audit.record(tx, { actorId, action: 'payment_link.disable', subjectType: 'payment_link', subjectId: linkId, prior: { status: link.status }, next: { status: 'disabled' } });
    return { id: link.id, status: 'disabled' };
  }

  async list(projectId: string): Promise<LinkEntry[]> {
    return this.entries(projectId, null);
  }

  async detail(projectId: string, linkId: string): Promise<LinkEntry> {
    const [link] = await this.entries(projectId, linkId);
    if (!link) throw new PlatformError('NOT_FOUND', 'No such payment link.');
    return link;
  }

  private async entries(projectId: string, linkId: string | null): Promise<LinkEntry[]> {
    let q = this.db.selectFrom('payment_link').selectAll().where('project_id', '=', projectId).orderBy('created_at', 'desc').orderBy('id');
    if (linkId) q = q.where('id', '=', linkId);
    const links = await q.execute();
    if (!links.length) return [];
    const ids = links.map((l) => l.id);
    const methods = await this.db.selectFrom('payment_link_route as lr')
      .innerJoin('route as r', 'r.id', 'lr.route_id')
      .innerJoin('payment_method as pm', 'pm.code', 'r.payment_method_code')
      .select(['lr.link_id', 'r.country_code', 'r.payment_method_code', 'pm.name'])
      .where('lr.link_id', 'in', ids).orderBy('r.country_code').orderBy('r.payment_method_code').execute();
    const paid = await this.db.selectFrom('transaction')
      .select(['payment_link_id', sql<number>`count(*)::int`.as('n'), sql<number>`count(*) filter (where state = 'succeeded')::int`.as('ok'),
        sql<number>`coalesce(sum(requested_amount) filter (where state = 'succeeded'), 0)::bigint`.as('total'), sql<Date | null>`max(created_at)`.as('last_at')])
      .where('payment_link_id', 'in', ids).groupBy('payment_link_id').execute();
    return links.map((l) => {
      const p = paid.find((x) => x.payment_link_id === l.id);
      return {
        id: l.id, code: l.code, url: this.config.PAYLINK_BASE_URL ? this.urlOf(l.code) : '', title: l.title, amount_type: l.amount_type, amount: l.amount, minimum_amount: l.minimum_amount,
        currency: l.currency_code, single_use: l.single_use, expires_at: l.expires_at, status: l.status,
        methods: methods.filter((m) => m.link_id === l.id).map((m) => ({ country: m.country_code, payment_method: m.payment_method_code, payment_method_name: m.name })),
        payments: { count: p?.n ?? 0, succeeded: p?.ok ?? 0, total_collected: Number(p?.total ?? 0), last_at: p?.last_at ?? null },
      };
    });
  }
}
