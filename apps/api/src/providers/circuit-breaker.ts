import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_TOKEN, type Db } from '../db/database';
import { SettingsService } from '../settings/settings.service';
import { AlertService } from '../alerts/alert.service';

/**
 * Per provider account, held in the store so every instance sees one view (spec 5.4, 15.5):
 * N failures within the window opens the breaker and marks the account degraded; a probe is
 * allowed every probe interval, and one success closes it.
 */
@Injectable()
export class CircuitBreaker {
  constructor(@Inject(DB_TOKEN) private readonly db: Db, private readonly settings: SettingsService, private readonly alerts: AlertService) {}

  async recordFailure(providerAccountId: string): Promise<void> {
    const failures = await this.settings.number('breaker.failures');
    const windowSeconds = await this.settings.number('breaker.window_seconds');
    const opened = await this.db.transaction().execute(async (tx) => {
      await tx.insertInto('circuit_breaker').values({ provider_account_id: providerAccountId }).onConflict((oc) => oc.doNothing()).execute();
      const cb = await tx.selectFrom('circuit_breaker').selectAll().where('provider_account_id', '=', providerAccountId).forUpdate().executeTakeFirstOrThrow();
      const now = Date.now();
      const inWindow = cb.window_started_at && now - cb.window_started_at.getTime() < windowSeconds * 1000;
      const count = inWindow ? cb.failure_count + 1 : 1;
      const open = cb.state === 'open' || count >= failures;
      await tx.updateTable('circuit_breaker').set({
        failure_count: count,
        window_started_at: inWindow ? cb.window_started_at : sql`now()`,
        state: open ? 'open' : 'closed',
        opened_at: open ? (cb.opened_at ?? sql`now()`) : null,
        updated_at: sql`now()`,
      }).where('provider_account_id', '=', providerAccountId).execute();
      if (open && cb.state !== 'open') {
        await tx.updateTable('provider_account').set({ status: 'degraded' }).where('id', '=', providerAccountId).where('status', '=', 'active').execute();
        return true;
      }
      return false;
    });
    if (opened) {
      await this.alerts.raise({
        category: 'service_health', severity: 'critical', subjectType: 'provider_account', subjectReference: providerAccountId, fingerprint: `breaker_open:${providerAccountId}`,
        title: 'Provider account degraded: circuit breaker open', detail: { failures }, actionReference: `/configuration/providers/${providerAccountId}`,
      });
    }
  }

  async recordSuccess(providerAccountId: string): Promise<void> {
    const changed = await this.db.transaction().execute(async (tx) => {
      const cb = await tx.selectFrom('circuit_breaker').select('state').where('provider_account_id', '=', providerAccountId).forUpdate().executeTakeFirst();
      if (!cb) return false;
      await tx.updateTable('circuit_breaker').set({ state: 'closed', failure_count: 0, opened_at: null, window_started_at: null, updated_at: sql`now()` }).where('provider_account_id', '=', providerAccountId).execute();
      if (cb.state !== 'closed') {
        await tx.updateTable('provider_account').set({ status: 'active' }).where('id', '=', providerAccountId).where('status', '=', 'degraded').execute();
        return true;
      }
      return false;
    });
    if (changed) await this.alerts.clear(`breaker_open:${providerAccountId}`);
  }

  /** Whether a probe may go through an open breaker now (one every probe interval). */
  async allowProbe(providerAccountId: string): Promise<boolean> {
    const interval = await this.settings.number('breaker.probe_interval_seconds');
    const result = await this.db
      .updateTable('circuit_breaker')
      .set({ last_probe_at: sql`now()`, state: 'half_open' })
      .where('provider_account_id', '=', providerAccountId)
      .where('state', 'in', ['open', 'half_open'])
      .where((eb) => eb.or([eb('last_probe_at', 'is', null), eb('last_probe_at', '<', sql<Date>`now() - make_interval(secs => ${interval})`)]))
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }
}
