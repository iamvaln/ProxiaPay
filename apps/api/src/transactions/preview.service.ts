import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { PlatformError } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { newCorrelationId, newPreviewReference } from '../crypto/references';
import { DB_TOKEN, type Db } from '../db/database';
import { minorUnits, nonEmpty, parseBody } from '../http/validation';
import { maskMsisdn, normaliseMsisdn } from '../msisdn/msisdn';
import { RouteResolver } from '../routes/route-resolver';
import { SettingsService } from '../settings/settings.service';
import type { ProjectPrincipal } from '../project-auth/project-auth.service';
import { TransactionReader } from './transaction-reader';
import { AlertService } from '../alerts/alert.service';

export const previewSchema = z.object({
  direction: z.enum(['collection', 'disbursement']),
  amount: minorUnits,
  currency: z.string().regex(/^[A-Z]{3}$/),
  country: z.string().regex(/^[A-Z]{2}$/),
  payment_method: z.string().regex(/^[A-Z0-9_]{2,16}$/),
  counterparty: z.object({
    msisdn: nonEmpty(32),
    name: z.string().trim().max(128).optional(),
    email: z.string().trim().email().max(254).optional(),
  }),
  reference: nonEmpty(128),
  metadata: z.record(z.string().max(64), z.union([z.string().max(512), z.number(), z.boolean(), z.null()])).refine((m) => Object.keys(m).length <= 20, 'at most 20 keys').optional(),
});
export type PreviewBody = z.infer<typeof previewSchema>;

/**
 * Previews (spec 5, API reference 5.1): the whole intent is resolved here, validated against
 * the four gates, priced by the fee module, and frozen for fifteen minutes under a reference.
 * A preview holds no funds and reserves nothing.
 */
@Injectable()
export class PreviewService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly resolver: RouteResolver,
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
    private readonly reader: TransactionReader,
    private readonly alerts: AlertService,
  ) {}

  async create(principal: ProjectPrincipal, rawBody: unknown) {
    const body = parseBody(previewSchema, rawBody);
    if (!principal.scopes.includes(body.direction)) throw new PlatformError('SCOPE_INSUFFICIENT', `The credential lacks the ${body.direction} scope.`);
    const currency = await this.db.selectFrom('currency').select('exponent').where('code', '=', body.currency).executeTakeFirst();
    if (!currency) throw new PlatformError('CURRENCY_UNKNOWN', `Currency ${body.currency} is unrecognised.`, { field: 'currency' });

    const resolution = await this.resolver.resolve(this.db, { projectId: principal.projectId, direction: body.direction, country: body.country, currency: body.currency, paymentMethod: body.payment_method, amount: body.amount });
    const msisdn = normaliseMsisdn(body.counterparty.msisdn, { code: resolution.country.code, diallingPrefix: resolution.country.diallingPrefix });
    if (!msisdn.ok) {
      throw new PlatformError('PAYER_IDENTIFIER_INVALID', msisdn.reason === 'foreign_prefix' ? "The number carries another country's prefix." : 'The number is malformed for its country.', { field: 'counterparty.msisdn' });
    }
    const bindings = await this.resolver.availableBindings(this.db, resolution.routeVersion.id, body.amount);
    const binding = bindings[0];
    const figures = this.resolver.computeFigures(resolution, body.amount, binding);
    const validity = await this.settings.number('preview.validity_seconds');
    const msisdnIndex = this.crypto.blindIndex(msisdn.msisdn);

    // A retried preview with the same reference and the same intent returns the original; a different intent conflicts.
    const openSame = await this.db.selectFrom('preview').selectAll().where('project_id', '=', principal.projectId).where('project_reference', '=', body.reference).where('status', '=', 'open').executeTakeFirst();
    if (openSame) {
      const same = openSame.direction === body.direction && openSame.requested_amount === body.amount && openSame.route_id === resolution.route.id && openSame.msisdn_index.equals(msisdnIndex);
      if (same && openSame.expires_at.getTime() > Date.now()) return this.reader.previewToApi(openSame, { country_code: resolution.route.countryCode, payment_method_code: resolution.route.paymentMethodCode, direction: resolution.route.direction }, true);
      if (!same) throw new PlatformError('REFERENCE_CONFLICT', 'The project reference is in use for another payment.', { field: 'reference', details: { preview: openSame.reference } });
    }
    const confirmed = await this.db.selectFrom('transaction').select(['reference']).where('project_id', '=', principal.projectId).where('project_reference', '=', body.reference).executeTakeFirst();
    if (confirmed) throw new PlatformError('REFERENCE_CONFLICT', 'The project reference is in use for another payment.', { field: 'reference', details: { transaction: confirmed.reference } });

    // A preview matching an open transaction reports the pending payment rather than resolving a new one (spec 5.5).
    const pending = await this.db.selectFrom('transaction').select(['reference']).where('project_id', '=', principal.projectId).where('route_id', '=', resolution.route.id)
      .where('requested_amount', '=', body.amount).where('msisdn_index', '=', msisdnIndex).where('state', 'in', ['created', 'action_required', 'submitted', 'processing', 'undetermined']).executeTakeFirst();
    if (pending) throw new PlatformError('SIMILAR_PAYMENT_PENDING', 'A similar payment is already pending for this counterparty.', { details: { transaction: pending.reference } });

    const termsSnapshot = {
      route_version_id: resolution.routeVersion.id, route_version_sequence: resolution.routeVersion.sequence, entitlement_version_id: resolution.entitlementVersion.id,
      processing_fee_bps: resolution.terms.processing.bps, processing_fee_fixed: resolution.terms.processing.fixed, platform_fee_bps: resolution.terms.platform.bps, platform_fee_fixed: resolution.terms.platform.fixed,
      processing_fee_bearer: resolution.terms.processingBearer, platform_fee_bearer: resolution.terms.platformBearer,
      provider_fee_bps: binding?.expected_fee_bps ?? null, provider_fee_fixed: binding?.expected_fee_fixed ?? null, provider_terms_status: binding?.terms_status ?? null,
      sources: resolution.terms.sources, remainders: figures.remainders,
    };
    const limitsSnapshot = { ...resolution.limits };

    let row;
    try {
      row = await this.db
        .insertInto('preview')
        .values({
          reference: newPreviewReference(),
          project_id: principal.projectId,
          route_id: resolution.route.id,
          route_version_id: resolution.routeVersion.id,
          entitlement_version_id: resolution.entitlementVersion.id,
          binding_id: binding?.id ?? null,
          direction: body.direction,
          currency_code: body.currency,
          requested_amount: body.amount,
          processing_fee: figures.processingFee,
          platform_fee: figures.platformFee,
          processing_fee_bearer: resolution.terms.processingBearer,
          platform_fee_bearer: resolution.terms.platformBearer,
          charged_amount: figures.chargedAmount,
          settled_amount: figures.settledAmount,
          expected_provider_fee: figures.expectedProviderFee,
          fee_rounding_remainder: JSON.stringify(figures.remainders),
          msisdn_ciphertext: this.crypto.seal(msisdn.msisdn, 'msisdn'),
          msisdn_index: msisdnIndex,
          msisdn_masked: maskMsisdn(msisdn.msisdn),
          counterparty_name: body.counterparty.name ?? null,
          counterparty_email: body.counterparty.email ?? null,
          project_reference: body.reference,
          metadata: JSON.stringify(body.metadata ?? {}),
          payer_action: resolution.payerAction,
          terms_snapshot: JSON.stringify(termsSnapshot),
          limits_snapshot: JSON.stringify(limitsSnapshot),
          correlation_id: newCorrelationId(),
          expires_at: sql`now() + make_interval(secs => ${validity})`,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new PlatformError('REFERENCE_CONFLICT', 'The project reference is in use for another payment.', { field: 'reference' });
      throw e;
    }
    return this.reader.previewToApi(row, { country_code: resolution.route.countryCode, payment_method_code: resolution.route.paymentMethodCode, direction: resolution.route.direction }, true);
  }

  /** Closes previews past their window (worker), and raises the preview alert of spec 14.7 for a payer previewing without paying. */
  async expireOpen(): Promise<number> {
    const rows = await this.db
      .updateTable('preview')
      .set({ status: 'expired' })
      .where('status', '=', 'open')
      .where('expires_at', '<', sql<Date>`now()`)
      .returning(['project_id', 'msisdn_index', 'msisdn_masked', 'route_id'])
      .execute();
    const threshold = await this.settings.number('preview.alert_unconfirmed_per_hour');
    const seen = new Set<string>();
    for (const r of rows) {
      const key = r.msisdn_index.toString('hex');
      if (seen.has(key)) continue;
      seen.add(key);
      const { rows: c } = await sql<{ n: number }>`select count(*)::int as n from preview where msisdn_index = ${r.msisdn_index} and status = 'expired' and created_at > now() - interval '1 hour'`.execute(this.db);
      if (c[0]!.n >= threshold) {
        await this.alerts.raise({
          category: 'service_health', severity: 'warning', subjectType: 'payer', subjectReference: r.msisdn_masked, projectId: r.project_id, fingerprint: `preview_expiring:${key}:${new Date().toISOString().slice(0, 13)}`,
          title: 'Payer previewing repeatedly without completing', detail: { expired_last_hour: c[0]!.n, route_id: r.route_id }, actionReference: `/transactions/previews?msisdn=${encodeURIComponent(r.msisdn_masked)}`,
        });
      }
    }
    return rows.length;
  }
}
