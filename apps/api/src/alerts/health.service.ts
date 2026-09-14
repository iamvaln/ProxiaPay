import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_TOKEN, type Db } from '../db/database';
import { AlertService } from './alert.service';
import { ratio } from '../money/money';

export interface Measure { dimension: string; key: string; current: number; baseline: number | null; departed: boolean; sample: number }

/**
 * Service health (spec 8.5): rates against their own rolling baseline. The current window is
 * the last hour; the baseline is the same measure over the preceding seven days. A departure
 * of a third or more on a meaningful sample raises an alert naming the dimension that moved.
 */
@Injectable()
export class HealthService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly alerts: AlertService) {}

  async successRates(dimension: 'route' | 'provider_account' | 'project'): Promise<Measure[]> {
    const column = dimension === 'route' ? sql`t.route_id` : dimension === 'project' ? sql`t.project_id` : sql`a.provider_account_id`;
    const join = dimension === 'provider_account' ? sql`join transaction_attempt a on a.id = t.current_attempt_id` : sql``;
    const { rows } = await sql<{ key: string; recent_total: number; recent_ok: number; base_total: number; base_ok: number }>`
      select ${column}::text as key,
             count(*) filter (where t.terminal_at > now() - interval '1 hour')::int as recent_total,
             count(*) filter (where t.terminal_at > now() - interval '1 hour' and t.state = 'succeeded')::int as recent_ok,
             count(*) filter (where t.terminal_at <= now() - interval '1 hour')::int as base_total,
             count(*) filter (where t.terminal_at <= now() - interval '1 hour' and t.state = 'succeeded')::int as base_ok
        from transaction t ${join}
       where t.terminal_at > now() - interval '8 days'
       group by 1`.execute(this.db);
    return rows.map((r) => {
      const current = ratio(r.recent_ok, r.recent_total) ?? 1;
      const baseline = r.base_total >= 20 ? ratio(r.base_ok, r.base_total) : null;
      return { dimension, key: r.key, current, baseline, sample: r.recent_total, departed: baseline !== null && r.recent_total >= 10 && current < baseline * (2 / 3) };
    });
  }

  async failureReasons(): Promise<{ reason: string; recent: number; baseline_per_hour: number }[]> {
    const { rows } = await sql<{ reason: string; recent: number; baseline: number }>`
      select failure_reason as reason,
             count(*) filter (where terminal_at > now() - interval '1 hour')::int as recent,
             count(*) filter (where terminal_at <= now() - interval '1 hour')::int as baseline
        from transaction where failure_reason is not null and terminal_at > now() - interval '8 days'
       group by 1 order by 2 desc`.execute(this.db);
    return rows.map((r) => ({ reason: r.reason, recent: r.recent, baseline_per_hour: Math.round((r.baseline / (7 * 24)) * 100) / 100 }));
  }

  async counters(): Promise<Record<string, number>> {
    const { rows } = await sql<Record<string, number>>`
      select (select count(*)::int from transaction where state = 'undetermined') as undetermined_open,
             (select count(*)::int from transaction where state = 'action_required' and action_expires_at < now()) as action_required_stuck,
             (select count(*)::int from notification_delivery where status = 'exhausted' and created_at > now() - interval '24 hours') as notifications_exhausted_24h,
             (select count(*)::int from preview where status = 'expired' and created_at > now() - interval '24 hours') as previews_expired_24h,
             (select coalesce(extract(epoch from avg(terminal_at - created_at)), 0)::int from transaction where terminal_at > now() - interval '24 hours') as seconds_to_terminal_avg_24h`.execute(this.db);
    return rows[0]!;
  }

  /** Evaluates every measure and raises or clears alerts; run from the worker. */
  async evaluate(): Promise<void> {
    for (const dim of ['route', 'provider_account', 'project'] as const) {
      for (const m of await this.successRates(dim)) {
        const fp = `health:success_rate:${dim}:${m.key}`;
        if (m.departed) {
          await this.alerts.raise({
            category: 'service_health', severity: 'warning', subjectType: dim, subjectReference: m.key, fingerprint: fp,
            title: `Success rate fell on ${dim} ${m.key}`, detail: { current: m.current, baseline: m.baseline, sample: m.sample }, actionReference: `/transactions?${dim}=${m.key}&state=failed`,
          });
        } else {
          await this.alerts.clear(fp);
        }
      }
    }
  }
}
