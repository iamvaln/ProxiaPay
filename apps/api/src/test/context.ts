import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { CoreModule } from '../core.module';
import { DB_TOKEN, type Db } from '../db/database';
import { resetConfigForTests } from '../config/config';
import { seedReferenceData } from '../seed/seed';
import { truncateAll } from './db';
import { CredentialService } from '../project-auth/credential.service';
import { LedgerService } from '../ledger/ledger.service';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { registerJobHandlers } from '../worker.module';
import { Worker } from '../jobs/worker';

export interface TestContext {
  app: INestApplicationContext;
  db: Db;
  reset(): Promise<void>;
  /** A project with an entitlement on every seeded route and one active credential. */
  project(code?: string, opts?: { fundXaf?: number }): Promise<{ id: string; key: string; secret: string; adminId: string }>;
  admin(email?: string): Promise<{ id: string; email: string; password: string }>;
  drain(): Promise<number>;
  close(): Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  resetConfigForTests();
  const app = await NestFactory.createApplicationContext(CoreModule, { logger: ['error'], abortOnError: false });
  const db = app.get<Db>(DB_TOKEN);
  registerJobHandlers(app);
  const worker = app.get(Worker);
  const credentials = app.get(CredentialService);
  const ledger = app.get(LedgerService);
  const adminAuth = app.get(AdminAuthService);
  let adminCounter = 0;
  const ctx: TestContext = {
    app,
    db,
    async reset() {
      await truncateAll(db);
      await seedReferenceData(db, { environment: 'sandbox' });
    },
    async admin(email) {
      const e = email ?? `admin${++adminCounter}@proxia.test`;
      const password = 'correct-horse-battery-staple';
      const { id } = await adminAuth.createAdministrator(db, { name: 'Test Admin', email: e, password });
      const owner = await db.selectFrom('role').select('id').where('name', '=', 'Owner').executeTakeFirstOrThrow();
      await db.insertInto('role_assignment').values({ administrator_id: id, role_id: owner.id, scope_type: 'all' }).execute();
      return { id, email: e, password };
    },
    async project(code = 'shop', opts = {}) {
      const admin = await ctx.admin();
      const project = await db.insertInto('project').values({ code, name: code, created_by: admin.id }).returning('id').executeTakeFirstOrThrow();
      const routes = await db.selectFrom('route').select('id').execute();
      for (const r of routes) {
        const ent = await db.insertInto('entitlement').values({ project_id: project.id, route_id: r.id }).returning('id').executeTakeFirstOrThrow();
        await db.insertInto('entitlement_version').values({ entitlement_id: ent.id, sequence: 1, count_24h: 1000, value_24h: 100_000_000, count_30d: 10000, value_30d: 1_000_000_000, note: 'test', created_by: admin.id }).execute();
      }
      const cred = await db.transaction().execute((tx) => credentials.issue(tx, project.id, ['collection', 'disbursement', 'read'], admin.id));
      if (opts.fundXaf) await db.transaction().execute((tx) => ledger.postProjectFunding(tx, { projectId: project.id, currency: 'XAF', amount: opts.fundXaf!, authorId: admin.id, justification: 'test funding' }));
      return { id: project.id, key: cred.key, secret: cred.secret, adminId: admin.id };
    },
    drain: () => worker.drain('test', worker.kinds().filter((k) => !['sweep.tick', 'preview.expire', 'alerts.evaluate', 'float.cover', 'reconciliation.weekly', 'housekeeping'].includes(k))),
    async close() {
      await app.close();
      await db.destroy();
    },
  };
  return ctx;
}
