import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { CONFIG, type AppConfig } from '../config/config';
import { DB_TOKEN, type Db, type Executor } from '../db/database';
import { log } from '../logging/logger';
import { SettingsService } from '../settings/settings.service';
import { Mailer } from './mailer';

export type AlertCategory = 'treasury' | 'service_health' | 'reconciliation' | 'security';
export type AlertSeverity = 'informational' | 'warning' | 'critical';

export interface RaiseInput {
  category: AlertCategory;
  severity: AlertSeverity;
  subjectType: string;
  subjectReference: string;
  projectId?: string | null;
  /** One open alert exists per fingerprint; a recurring condition advances its count instead of raising again. */
  fingerprint: string;
  title: string;
  detail?: Record<string, unknown>;
  /** The console operation that addresses it. */
  actionReference: string;
}

const RANK: Record<AlertSeverity, number> = { informational: 0, warning: 1, critical: 2 };

/**
 * The alert lifecycle of spec 8.6: raised once per condition fingerprint, advanced while it
 * persists, re-notified where severity rises or the quiet period elapses, and cleared with a
 * notice when the condition ends. Delivery goes to the groups a policy names; a group with no
 * address falls back to the operations address of the collections stage.
 */
@Injectable()
export class AlertService {
  private readonly logger = log('alerts');
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Pick<AppConfig, 'ALERT_EMAIL' | 'PROXIAPAY_ENV'>,
    private readonly settings: SettingsService,
    private readonly mailer: Mailer,
  ) {}

  async raise(input: RaiseInput, exec: Executor = this.db): Promise<{ id: string; created: boolean }> {
    const existing = await exec.selectFrom('alert').selectAll().where('fingerprint', '=', input.fingerprint).where('status', 'in', ['open', 'acknowledged']).executeTakeFirst();
    if (existing) {
      const severityRose = RANK[input.severity] > RANK[existing.severity as AlertSeverity];
      const quietHours = await this.settings.number('alert.quiet_period_hours');
      const quietElapsed = !existing.last_notified_at || Date.now() - existing.last_notified_at.getTime() > quietHours * 3600_000;
      await exec
        .updateTable('alert')
        .set({
          last_seen_at: sql`now()`,
          occurrence_count: existing.occurrence_count + 1,
          severity: severityRose ? input.severity : existing.severity,
          detail: JSON.stringify(input.detail ?? {}),
          ...(severityRose ? { status: 'open', acknowledged_at: null, acknowledged_by: null } : {}),
        })
        .where('id', '=', existing.id)
        .execute();
      if (severityRose || quietElapsed) await this.notify(exec, existing.id, 'renotified');
      return { id: existing.id, created: false };
    }
    try {
      const row = await exec
        .insertInto('alert')
        .values({
          category: input.category, severity: input.severity, subject_type: input.subjectType, subject_reference: input.subjectReference,
          project_id: input.projectId ?? null, fingerprint: input.fingerprint, title: input.title, detail: JSON.stringify(input.detail ?? {}), action_reference: input.actionReference,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.notify(exec, row.id, 'raised');
      return { id: row.id, created: true };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return this.raise(input, exec); // raced with a simultaneous evaluation
      throw e;
    }
  }

  /** Clears the open alert for a condition that no longer holds, telling recipients it cleared. */
  async clear(fingerprint: string, exec: Executor = this.db): Promise<boolean> {
    const existing = await exec.selectFrom('alert').select('id').where('fingerprint', '=', fingerprint).where('status', 'in', ['open', 'acknowledged']).executeTakeFirst();
    if (!existing) return false;
    await exec.updateTable('alert').set({ status: 'cleared', cleared_at: sql`now()` }).where('id', '=', existing.id).execute();
    await this.notify(exec, existing.id, 'cleared');
    return true;
  }

  async acknowledge(alertId: string, administratorId: string): Promise<void> {
    await this.db.updateTable('alert').set({ status: 'acknowledged', acknowledged_by: administratorId, acknowledged_at: sql`now()` }).where('id', '=', alertId).where('status', '=', 'open').execute();
  }

  /** Escalates unacknowledged critical alerts past their period (run from the worker). */
  async escalateOverdue(): Promise<number> {
    const rows = await this.db
      .selectFrom('alert as a')
      .innerJoin('alert_policy as p', 'p.category', 'a.category')
      .select(['a.id', 'p.escalation_minutes', 'p.escalation_group_id', 'a.raised_at'])
      .where('a.status', '=', 'open')
      .where('a.severity', '=', 'critical')
      .where('a.escalated_at', 'is', null)
      .where('p.acknowledgement_required', '=', true)
      .execute();
    let n = 0;
    for (const r of rows) {
      if (Date.now() - r.raised_at.getTime() < r.escalation_minutes * 60_000) continue;
      await this.db.updateTable('alert').set({ escalated_at: sql`now()` }).where('id', '=', r.id).execute();
      await this.notify(this.db, r.id, 'escalated', r.escalation_group_id);
      n++;
    }
    return n;
  }

  private async notify(exec: Executor, alertId: string, kind: 'raised' | 'renotified' | 'escalated' | 'cleared', onlyGroupId?: string | null): Promise<void> {
    const alert = await exec.selectFrom('alert').selectAll().where('id', '=', alertId).executeTakeFirstOrThrow();
    const policy = await exec.selectFrom('alert_policy').selectAll().where('category', '=', alert.category).executeTakeFirst();
    if (policy && RANK[alert.severity as AlertSeverity] < RANK[policy.minimum_severity as AlertSeverity] && kind !== 'cleared') return;
    const groupIds = onlyGroupId ? [onlyGroupId] : (await exec.selectFrom('alert_policy_group').select('group_id').where('category', '=', alert.category).execute()).map((g) => g.group_id);
    const addresses = groupIds.length
      ? await exec.selectFrom('alert_group_address as ga').innerJoin('alert_group as g', 'g.id', 'ga.group_id').select(['ga.group_id', 'ga.channel', 'ga.address'])
          .where('ga.group_id', 'in', groupIds).where('ga.active', '=', true).where('g.active', '=', true).execute()
      : [];
    const targets = addresses.length ? addresses : [{ group_id: null, channel: 'email', address: this.config.ALERT_EMAIL }];
    const subject = `[ProxiaPay ${this.config.PROXIAPAY_ENV}] ${kind === 'cleared' ? 'CLEARED: ' : ''}${alert.severity.toUpperCase()} ${alert.title}`;
    const text = `${alert.title}\nCategory: ${alert.category}\nSubject: ${alert.subject_type} ${alert.subject_reference}\nOccurrences: ${alert.occurrence_count}\nAction: ${alert.action_reference}\nDetail: ${JSON.stringify(alert.detail)}`;
    for (const t of targets) {
      let status: 'sent' | 'failed' | 'logged' = 'logged';
      let response: string | null = null;
      try {
        status = await this.mailer.send({ to: t.address, subject, text });
      } catch (e) {
        status = 'failed';
        response = (e as Error).message;
        this.logger.warn({ alert_id: alertId, err: e }, 'alert delivery failed');
      }
      await exec.insertInto('alert_delivery').values({ alert_id: alertId, group_id: t.group_id, channel: t.channel, address: t.address, kind, status, response }).execute();
    }
    await exec.updateTable('alert').set({ last_notified_at: sql`now()` }).where('id', '=', alertId).execute();
  }
}
