import { Module, type INestApplicationContext } from '@nestjs/common';
import { CoreModule } from './core.module';
import { Worker } from './jobs/worker';
import { SubmissionService } from './providers/submission.service';
import { StatusService } from './providers/status.service';
import { NotificationService } from './notifications/notification.service';
import { PreviewService } from './transactions/preview.service';
import { AlertService } from './alerts/alert.service';
import { HealthService } from './alerts/health.service';
import { TreasuryService } from './treasury/treasury.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { RateLimiter } from './project-auth/rate-limiter';
import { ProviderAccountService } from './providers/provider-account.service';
import { LedgerService } from './ledger/ledger.service';
import { DB_TOKEN, type Db } from './db/database';
import { sql } from 'kysely';
import type { EventSource } from './transactions/transaction.service';

@Module({ imports: [CoreModule] })
export class WorkerModule {}

const inSeconds = (s: number) => ({ rescheduleAt: new Date(Date.now() + s * 1000) });

/** Every kind of background work, in one place, so what the worker does is readable end to end. */
export function registerJobHandlers(app: INestApplicationContext): void {
  const worker = app.get(Worker);
  const submission = app.get(SubmissionService);
  const status = app.get(StatusService);
  const notifications = app.get(NotificationService);
  const previews = app.get(PreviewService);
  const alerts = app.get(AlertService);
  const health = app.get(HealthService);
  const treasury = app.get(TreasuryService);
  const reconciliation = app.get(ReconciliationService);
  const rateLimiter = app.get(RateLimiter);
  const accounts = app.get(ProviderAccountService);
  const ledger = app.get(LedgerService);
  const db = app.get<Db>(DB_TOKEN);

  worker.register('transaction.submit', async (p) => { await submission.submit(String(p.transactionId)); });
  worker.register('transaction.status_check', async (p) => { await status.check(String(p.transactionId), (p.source as EventSource) ?? 'status_check', (p.actorId as string) ?? null); });
  worker.register('notification.deliver', async (p) => { await notifications.deliver(String(p.deliveryId)); });
  worker.register('reconciliation.run', async (p) => { await reconciliation.execute(String(p.runId)); });

  worker.register('sweep.tick', async () => { await status.sweep(); return inSeconds(10); });
  worker.register('preview.expire', async () => { await previews.expireOpen(); return inSeconds(30); });
  worker.register('alerts.evaluate', async () => { await health.evaluate(); await alerts.escalateOverdue(); return inSeconds(60); });
  worker.register('float.cover', async () => { await treasury.evaluateCover(); return inSeconds(300); });
  worker.register('reconciliation.weekly', async () => { await reconciliation.scheduleWeekly(); return inSeconds(3600); });
  worker.register('housekeeping', async () => {
    await rateLimiter.prune();
    await accounts.pruneOldPayloads();
    await sql`delete from project_token where expires_at < now() - interval '1 day'`.execute(db);
    await sql`update admin_session set revoked_at = now() where revoked_at is null and expires_at < now()`.execute(db);
    const accountsToCheckpoint = await db.selectFrom('ledger_account').select('id').execute();
    for (const a of accountsToCheckpoint) await db.transaction().execute((tx) => ledger.checkpoint(tx, a.id));
    return inSeconds(3600);
  });
}
