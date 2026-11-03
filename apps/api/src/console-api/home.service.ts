import { Inject, Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { DB_TOKEN, type Db } from '../db/database';
import { groupProblems, isDeparting, DEPARTING, type AlertRow, type Problem } from './home.logic';

export interface RateVsBaseline { current: number | null; baseline: number | null; sample: number }
export interface CollectedToday { currency: string; today: number; last_week: number | null }
export interface RouteSeries {
  route_id: string; payment_method_code: string; payment_method_name: string; country_code: string; currency: string; direction: 'collection' | 'disbursement';
  baseline: number | null; current: number | null; sample: number; alerted: boolean; departing: boolean;
  hours: { hour: string; terminal: number; succeeded: number }[];
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3_600_000;

/** The console home's queries, each over the projects the administrator may see (`null` = every project). */
@Injectable()
export class HomeService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  // An empty scope matches nothing: the nil uuid is no project.
  private scopeFilter(scope: string[] | null, column = 't.project_id'): RawBuilder<unknown> {
    return scope ? sql`and ${sql.ref(column)} in (${sql.join(scope.length ? scope : [NIL_UUID])})` : sql``;
  }

  /** Last-hour success rate against the 7 days before it, over every terminal transaction in scope. */
  async overallSuccess(scope: string[] | null): Promise<RateVsBaseline> {
    const { rows } = await sql<{ recent_total: number; recent_rate: number | null; base_total: number; base_rate: number | null }>`
      select count(*) filter (where t.terminal_at > now() - interval '1 hour')::int as recent_total,
             (count(*) filter (where t.terminal_at > now() - interval '1 hour' and t.state = 'succeeded'))::float / nullif(count(*) filter (where t.terminal_at > now() - interval '1 hour'), 0) as recent_rate,
             count(*) filter (where t.terminal_at <= now() - interval '1 hour')::int as base_total,
             (count(*) filter (where t.terminal_at <= now() - interval '1 hour' and t.state = 'succeeded'))::float / nullif(count(*) filter (where t.terminal_at <= now() - interval '1 hour'), 0) as base_rate
        from transaction t
       where t.terminal_at > now() - interval '8 days' ${this.scopeFilter(scope)}`.execute(this.db);
    const r = rows[0]!;
    return { current: r.recent_rate, baseline: r.base_total >= DEPARTING.minSample ? r.base_rate : null, sample: r.recent_total };
  }

  /** Succeeded collections settled today, per currency, against the same stretch of the day one week ago. */
  async collectedToday(scope: string[] | null): Promise<CollectedToday[]> {
    const { rows } = await sql<{ currency: string; today: number | null; last_week: number | null }>`
      select t.currency_code as currency,
             sum(t.settled_amount) filter (where t.terminal_at >= date_trunc('day', now()))::bigint as today,
             sum(t.settled_amount) filter (where t.terminal_at >= date_trunc('day', now()) - interval '7 days' and t.terminal_at < now() - interval '7 days')::bigint as last_week
        from transaction t
       where t.direction = 'collection' and t.state = 'succeeded' and t.terminal_at >= date_trunc('day', now()) - interval '7 days' ${this.scopeFilter(scope)}
       group by 1
       order by 1`.execute(this.db);
    return rows.filter((r) => r.today !== null || r.last_week !== null).map((r) => ({ currency: r.currency, today: Number(r.today ?? 0), last_week: r.last_week === null ? null : Number(r.last_week) }));
  }

  async undetermined(scope: string[] | null): Promise<number> {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from transaction t where t.state = 'undetermined' ${this.scopeFilter(scope)}`.execute(this.db);
    return rows[0]!.n;
  }

  /** `withAlerts` is whether the caller may read alerts. One series per route with terminal transactions in the last 8 days: 24 hourly buckets, oldest first, the last being the current hour. */
  async routeSeries(scope: string[] | null, withAlerts: boolean): Promise<RouteSeries[]> {
    const { rows: rates } = await sql<{ route_id: string; payment_method_code: string; payment_method_name: string; country_code: string; currency: string; direction: string; recent_total: number; recent_rate: number | null; base_total: number; base_rate: number | null }>`
      select r.id as route_id, r.payment_method_code, pm.name as payment_method_name, r.country_code, r.currency_code as currency, r.direction,
             count(*) filter (where t.terminal_at > now() - interval '1 hour')::int as recent_total,
             (count(*) filter (where t.terminal_at > now() - interval '1 hour' and t.state = 'succeeded'))::float / nullif(count(*) filter (where t.terminal_at > now() - interval '1 hour'), 0) as recent_rate,
             count(*) filter (where t.terminal_at <= now() - interval '1 hour')::int as base_total,
             (count(*) filter (where t.terminal_at <= now() - interval '1 hour' and t.state = 'succeeded'))::float / nullif(count(*) filter (where t.terminal_at <= now() - interval '1 hour'), 0) as base_rate
        from transaction t
        join route r on r.id = t.route_id
        join payment_method pm on pm.code = r.payment_method_code
       where t.terminal_at > now() - interval '8 days' ${this.scopeFilter(scope)}
       group by r.id, pm.name
       order by r.country_code, pm.name, r.direction`.execute(this.db);
    if (!rates.length) return [];

    const { rows: hourly } = await sql<{ route_id: string; hour: Date; terminal: number; succeeded: number }>`
      select t.route_id, date_trunc('hour', t.terminal_at) as hour, count(*)::int as terminal, count(*) filter (where t.state = 'succeeded')::int as succeeded
        from transaction t
       where t.terminal_at > date_trunc('hour', now()) - interval '23 hours' ${this.scopeFilter(scope)}
       group by 1, 2`.execute(this.db);
    const byRoute = new Map<string, Map<number, { terminal: number; succeeded: number }>>();
    for (const h of hourly) {
      const buckets = byRoute.get(h.route_id) ?? new Map();
      buckets.set(h.hour.getTime(), { terminal: h.terminal, succeeded: h.succeeded });
      byRoute.set(h.route_id, buckets);
    }

    // Alerts are platform-wide: only an administrator who may read them has them count towards a route departing.
    const alerted = new Set<string>();
    if (withAlerts) {
      const { rows: alerts } = await sql<{ subject_reference: string }>`
        select subject_reference from alert where status in ('open', 'acknowledged') and fingerprint like 'health:success_rate:route:%'`.execute(this.db);
      for (const a of alerts) alerted.add(a.subject_reference);
    }

    const currentHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    return rates.map((r) => {
      const buckets = byRoute.get(r.route_id);
      const hours = Array.from({ length: 24 }, (_, i) => {
        const start = currentHour - (23 - i) * HOUR_MS;
        const b = buckets?.get(start);
        return { hour: new Date(start).toISOString(), terminal: b?.terminal ?? 0, succeeded: b?.succeeded ?? 0 };
      });
      const figures = { current: r.recent_rate, baseline: r.base_total >= DEPARTING.minSample ? r.base_rate : null, sample: r.recent_total, alerted: alerted.has(r.route_id) };
      return {
        route_id: r.route_id, payment_method_code: r.payment_method_code, payment_method_name: r.payment_method_name, country_code: r.country_code, currency: r.currency, direction: r.direction as RouteSeries['direction'],
        ...figures, departing: isDeparting(figures), hours,
      };
    });
  }

  /** The verdict's problems: open alerts grouped by what they are about, plus suspended provider accounts. Each source only when the caller may see it. */
  async problems(opts: { alerts: boolean; providers: boolean }): Promise<Problem[]> {
    const problems: Problem[] = [];
    if (opts.alerts) {
      const rows = await this.db
        .selectFrom('alert')
        .select(['id', 'severity', 'category', 'subject_type', 'subject_reference', 'fingerprint', 'title', 'action_reference', 'raised_at'])
        .where('status', 'in', ['open', 'acknowledged'])
        .where('severity', '<>', 'informational')
        .execute();
      const alerts = rows as AlertRow[];
      problems.push(...groupProblems(alerts, await this.names(alerts)));
    }
    if (opts.providers) {
      const suspended = await this.db.selectFrom('provider_account').select(['id', 'name', 'suspended_at', 'updated_at']).where('status', '=', 'suspended').execute();
      for (const p of suspended) {
        problems.push({
          severity: 'critical', kind: 'provider_suspended', subject_type: 'provider_account', subject_reference: p.id, subject_name: p.name, count: 1,
          since: (p.suspended_at ?? p.updated_at).toISOString(), title: `Provider account ${p.name} is suspended`, link: `/configuration/providers/${p.id}`,
        });
      }
    }
    return problems.sort((x, y) => (x.severity !== y.severity ? (x.severity === 'critical' ? -1 : 1) : Date.parse(x.since) - Date.parse(y.since)));
  }

  // Names for the subjects that have one: at most one query per subject type. Float drift alerts carry "<country>/<currency>/<direction>", not an id; groupProblems falls back to it.
  private async names(alerts: AlertRow[]): Promise<Map<string, string>> {
    const ids = (type: string) => [...new Set(alerts.filter((a) => a.subject_type === type && UUID.test(a.subject_reference)).map((a) => a.subject_reference))];
    const names = new Map<string, string>();
    const routeIds = ids('route');
    if (routeIds.length) {
      const rows = await this.db.selectFrom('route as r').innerJoin('payment_method as pm', 'pm.code', 'r.payment_method_code').select(['r.id', 'pm.name', 'r.country_code', 'r.direction']).where('r.id', 'in', routeIds).execute();
      for (const r of rows) names.set(`route:${r.id}`, `${r.name} ${r.country_code} · ${r.direction}`);
    }
    const accountIds = ids('provider_account');
    if (accountIds.length) {
      for (const r of await this.db.selectFrom('provider_account').select(['id', 'name']).where('id', 'in', accountIds).execute()) names.set(`provider_account:${r.id}`, r.name);
    }
    const projectIds = ids('project');
    if (projectIds.length) {
      for (const r of await this.db.selectFrom('project').select(['id', 'name']).where('id', 'in', projectIds).execute()) names.set(`project:${r.id}`, r.name);
    }
    const floatIds = ids('float_account');
    if (floatIds.length) {
      const rows = await this.db.selectFrom('ledger_account as a').innerJoin('provider_account as pa', 'pa.id', 'a.provider_account_id').select(['a.id', 'pa.name', 'a.country_code', 'a.currency_code', 'a.direction']).where('a.type', '=', 'float').where('a.id', 'in', floatIds).execute();
      for (const f of rows) names.set(`float_account:${f.id}`, `${f.name} ${f.country_code} ${f.currency_code} ${f.direction}`);
    }
    return names;
  }
}
