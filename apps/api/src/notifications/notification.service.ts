import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { PlatformError } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { newEventReference } from '../crypto/references';
import { DB_TOKEN, type Db, type Executor, type Tx } from '../db/database';
import { JobQueue } from '../jobs/job-queue';
import { log } from '../logging/logger';
import { SettingsService } from '../settings/settings.service';
import { AlertService } from '../alerts/alert.service';
import { AuditService } from '../audit/audit.service';
import { NOT_PUBLIC, vetTarget } from './public-address';
import { deliveryTransport } from './delivery-transport';

export type NotificationEvent =
  | 'transaction.action_required' | 'transaction.succeeded' | 'transaction.failed' | 'transaction.expired' | 'transaction.undetermined' | 'transaction.corrected';

/** Widening intervals between attempts (spec 7.3): one minute to a day, eight attempts. */
const RETRY_SECONDS = [60, 300, 900, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 24 * 3600];

/**
 * Notifications to projects (spec 7.3, API reference 6). A delivery is created in the same
 * transaction as the state change, signed with the project's own secret over the timestamp and
 * the exact body, and retried on a widening interval with every attempt recorded.
 */
@Injectable()
export class NotificationService {
  private readonly logger = log('notifications');
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly crypto: CryptoService,
    private readonly queue: JobQueue,
    private readonly settings: SettingsService,
    private readonly alerts: AlertService,
    private readonly audit: AuditService,
  ) {}

  /** Enqueues an event for the project's active endpoint, if it has one. `data` is the API transaction object plus any extra fields. */
  async enqueue(tx: Tx, args: { projectId: string; transactionId: string; event: NotificationEvent; data: Record<string, unknown> }): Promise<string | null> {
    const endpoint = await tx.selectFrom('project_notification_endpoint').select('id').where('project_id', '=', args.projectId).where('active', '=', true).executeTakeFirst();
    if (!endpoint) return null;
    const eventId = newEventReference();
    const payload = { id: eventId, event: args.event, occurred_at: new Date().toISOString(), data: args.data };
    const maxAttempts = await this.settings.number('notification.max_attempts');
    const row = await tx
      .insertInto('notification_delivery')
      .values({ event_id: eventId, transaction_id: args.transactionId, endpoint_id: endpoint.id, event_type: args.event, payload: JSON.stringify(payload), max_attempts: maxAttempts })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.queue.enqueue(tx, 'notification.deliver', { deliveryId: row.id }, { maxAttempts: 1 });
    return row.id;
  }

  /** Delivers one attempt; reschedules itself on failure and records every outcome. */
  async deliver(deliveryId: string): Promise<'delivered' | 'retry' | 'exhausted' | 'skipped'> {
    const d = await this.db
      .selectFrom('notification_delivery as d')
      .innerJoin('project_notification_endpoint as e', 'e.id', 'd.endpoint_id')
      .select(['d.id', 'd.status', 'd.attempt', 'd.max_attempts', 'd.payload', 'd.event_id', 'd.transaction_id', 'e.url', 'e.signing_secret_ciphertext', 'e.id as endpoint_id', 'e.project_id', 'e.active'])
      .where('d.id', '=', deliveryId)
      .executeTakeFirst();
    if (!d || d.status !== 'pending') return 'skipped';
    // Resolved and judged before every attempt: a name can come to resolve inside the network after it was set. Retrying would not change the answer.
    const target = await vetTarget(d.url);
    if (target.verdict === 'internal') {
      const attempt = d.attempt + 1;
      await this.db.insertInto('notification_delivery_attempt').values({ delivery_id: d.id, attempt, error: NOT_PUBLIC, duration_ms: 0 }).execute();
      await this.db.updateTable('notification_delivery').set({ status: 'exhausted', attempt }).where('id', '=', d.id).execute();
      await this.raiseFailing(d.project_id, { delivery_id: d.id, last_status: null, error: NOT_PUBLIC });
      return 'exhausted';
    }
    const body = JSON.stringify(d.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = this.crypto.openString(d.signing_secret_ciphertext, `notification_endpoint:${d.endpoint_id}`);
    const signature = CryptoService.hmacSha256Hex(secret, `${timestamp}.${body}`);
    const attempt = d.attempt + 1;
    const started = Date.now();
    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let error: string | null = null;
    // A name that does not resolve is not connected to at all: the attempt fails and the usual retry applies.
    if (target.verdict === 'unresolved') error = `The address did not resolve (${target.error}).`;
    else {
      try {
        // Connected only to the addresses just vetted, never to a second resolution's.
        const res = await deliveryTransport.post(d.url, {
          'content-type': 'application/json',
          'user-agent': 'ProxiaPay/1.0',
          'x-proxiapay-event-id': d.event_id,
          'x-proxiapay-timestamp': String(timestamp),
          'x-proxiapay-signature': signature,
        }, body, target.addresses, 10_000);
        responseStatus = res.status;
        responseBody = res.body;
        // A redirect is not followed: it could point anywhere, the check above included.
        if (res.status >= 300 && res.status < 400) error = 'Redirect not followed.';
      } catch (e) {
        error = (e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message;
      }
    }
    const ok = responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
    await this.db.insertInto('notification_delivery_attempt').values({ delivery_id: d.id, attempt, response_status: responseStatus, response_body: responseBody, error, duration_ms: Date.now() - started }).execute();
    if (ok) {
      await this.db.updateTable('notification_delivery').set({ status: 'delivered', attempt, delivered_at: sql`now()` }).where('id', '=', d.id).execute();
      await this.alerts.clear(`notification_failing:${d.project_id}`).catch(() => undefined);
      return 'delivered';
    }
    if (attempt >= d.max_attempts || !d.active) {
      await this.db.updateTable('notification_delivery').set({ status: 'exhausted', attempt }).where('id', '=', d.id).execute();
      await this.raiseFailing(d.project_id, { delivery_id: d.id, last_status: responseStatus, error });
      return 'exhausted';
    }
    const delay = RETRY_SECONDS[Math.min(attempt - 1, RETRY_SECONDS.length - 1)]!;
    const nextAt = new Date(Date.now() + delay * 1000);
    await this.db.updateTable('notification_delivery').set({ attempt, next_attempt_at: nextAt }).where('id', '=', d.id).execute();
    await this.queue.enqueue(this.db, 'notification.deliver', { deliveryId: d.id }, { runAt: nextAt, maxAttempts: 1 });
    this.logger.info({ delivery_id: d.id, attempt, next_at: nextAt, status: responseStatus, error }, 'notification retry scheduled');
    return 'retry';
  }

  private async raiseFailing(projectId: string, detail: { delivery_id: string; last_status: number | null; error: string | null }) {
    await this.alerts.raise({
      category: 'service_health', severity: 'warning', subjectType: 'project', subjectReference: projectId, projectId,
      fingerprint: `notification_failing:${projectId}`, title: 'Notification deliveries failing to a project', detail, actionReference: `/projects/${projectId}#notifications`,
    }).catch(() => undefined);
  }

  /** An administrator replays a delivery: a fresh delivery of the same payload, attributed to them. */
  async replay(transactionId: string, deliveryId: string, administratorId: string): Promise<string> {
    return this.db.transaction().execute(async (tx) => {
      // Bound to the transaction the caller reached, so a delivery id of another project's transaction answers as missing.
      const d = await tx.selectFrom('notification_delivery').selectAll().where('id', '=', deliveryId).where('transaction_id', '=', transactionId).executeTakeFirst();
      if (!d) throw new PlatformError('NOT_FOUND', 'No such delivery.');
      const row = await tx
        .insertInto('notification_delivery')
        .values({ event_id: d.event_id, transaction_id: d.transaction_id, endpoint_id: d.endpoint_id, event_type: d.event_type, payload: JSON.stringify(d.payload), max_attempts: d.max_attempts, replayed_from: d.id, replayed_by: administratorId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.queue.enqueue(tx, 'notification.deliver', { deliveryId: row.id }, { maxAttempts: 1 });
      await this.audit.record(tx, { actorId: administratorId, action: 'notification.replay', subjectType: 'notification_delivery', subjectId: row.id, prior: { replayed_from: d.id } });
      return row.id;
    });
  }

  async setEndpoint(exec: Executor, projectId: string, url: string, actorId: string): Promise<{ secret: string }> {
    const secret = `whsec_${CryptoService.randomToken(32)}`;
    await exec.updateTable('project_notification_endpoint').set({ active: false }).where('project_id', '=', projectId).where('active', '=', true).execute();
    const row = await exec
      .insertInto('project_notification_endpoint')
      .values({ project_id: projectId, url, signing_secret_ciphertext: Buffer.alloc(0), created_by: actorId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await exec.updateTable('project_notification_endpoint').set({ signing_secret_ciphertext: this.crypto.seal(secret, `notification_endpoint:${row.id}`) }).where('id', '=', row.id).execute();
    await this.audit.record(exec, { actorId, action: 'notification_endpoint.set', subjectType: 'project', subjectId: projectId, next: { url } });
    return { secret };
  }

  async regenerateSecret(exec: Executor, projectId: string, actorId: string, confirmationId?: string): Promise<{ secret: string }> {
    const endpoint = await exec.selectFrom('project_notification_endpoint').select('id').where('project_id', '=', projectId).where('active', '=', true).executeTakeFirstOrThrow();
    const secret = `whsec_${CryptoService.randomToken(32)}`;
    await exec.updateTable('project_notification_endpoint').set({ signing_secret_ciphertext: this.crypto.seal(secret, `notification_endpoint:${endpoint.id}`) }).where('id', '=', endpoint.id).execute();
    await this.audit.record(exec, { actorId, action: 'notification_endpoint.regenerate_secret', subjectType: 'project', subjectId: projectId, confirmationId });
    return { secret };
  }

  /** A project's deliveries, with the reference of the transaction each belongs to, as an unexecuted query to page. */
  deliveriesQuery(projectId: string) {
    return this.db
      .selectFrom('notification_delivery as d')
      .innerJoin('project_notification_endpoint as e', 'e.id', 'd.endpoint_id')
      .innerJoin('transaction as t', 't.id', 'd.transaction_id')
      .select(['d.id', 'd.event_id', 'd.event_type', 'd.attempt', 'd.status', 'd.next_attempt_at', 'd.delivered_at', 'd.created_at', 'd.replayed_from', 't.reference as transaction_reference'])
      .where('e.project_id', '=', projectId);
  }

  async deliveriesForTransaction(transactionId: string) {
    const deliveries = await this.db.selectFrom('notification_delivery').select(['id', 'event_id', 'event_type', 'attempt', 'status', 'next_attempt_at', 'delivered_at', 'created_at', 'replayed_from']).where('transaction_id', '=', transactionId).orderBy('created_at', 'desc').execute();
    const ids = deliveries.map((d) => d.id);
    const attempts = ids.length ? await this.db.selectFrom('notification_delivery_attempt').selectAll().where('delivery_id', 'in', ids).orderBy('id').execute() : [];
    return deliveries.map((d) => ({ ...d, attempts: attempts.filter((a) => a.delivery_id === d.id) }));
  }
}

/** Verification as a project performs it (API reference 6.3), provided for the integration guide and tests. */
export function verifyNotificationSignature(secret: string, timestampHeader: string, rawBody: Buffer | string, signatureHeader: string, now = Date.now()): boolean {
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const expected = CryptoService.hmacSha256Hex(secret, Buffer.concat([Buffer.from(`${ts}.`), typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody]));
  return CryptoService.constantTimeEqual(expected, signatureHeader);
}
