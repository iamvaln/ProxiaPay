import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './cli/env';
import { WorkerModule, registerJobHandlers } from './worker.module';
import { loadConfig } from './config/config';
import { rootLogger } from './logging/logger';
import { Worker } from './jobs/worker';
import { JobQueue } from './jobs/job-queue';
import { DB_TOKEN, type Db } from './db/database';

/** The background process (spec 15.1): sweep, deliveries, reconciliation, alerts, float cover, housekeeping. */
async function bootstrap() {
  loadEnv();
  const config = loadConfig();
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  const worker = app.get(Worker);
  const queue = app.get(JobQueue);
  const db = app.get<Db>(DB_TOKEN);
  registerJobHandlers(app);
  await scheduleRecurring(queue, db);
  worker.start(config.INSTANCE_NAME);
  rootLogger.info({ instance: config.INSTANCE_NAME, kinds: worker.kinds() }, 'worker started');
  const shutdown = async () => {
    await worker.stop();
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/** Recurring jobs re-arm themselves; seeding them here means a fresh deployment has them from the first minute. */
export async function scheduleRecurring(queue: JobQueue, db: Db): Promise<void> {
  for (const kind of ['sweep.tick', 'preview.expire', 'alerts.evaluate', 'float.cover', 'reconciliation.weekly', 'housekeeping']) {
    await queue.enqueue(db, kind, {}, { dedupeKey: kind, maxAttempts: 1_000_000 });
  }
}

bootstrap().catch((e) => { rootLogger.fatal({ err: e }, 'worker failed to start'); process.exit(1); });
