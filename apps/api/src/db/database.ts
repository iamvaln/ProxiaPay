import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool } from 'pg';
import { configurePgTypes } from './pg-types';
import type { DB } from './schema.generated';

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;
/** Either a transaction or the root connection: services accept both. */
export type Executor = Db | Tx;

export function createPool(databaseUrl: string, max = 10): Pool {
  configurePgTypes();
  return new Pool({
    connectionString: databaseUrl,
    max,
    // Every session works in UTC; timestamps are rendered in the administrator's zone by the console.
    options: '-c timezone=UTC',
    application_name: 'proxiapay',
  });
}

export function createDb(pool: Pool): Db {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** The store's clock, so every instance agrees on whether a window has closed. */
export async function dbNow(executor: Executor): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`select now() as now`.execute(executor);
  return rows[0]!.now;
}

/** Transaction-scoped advisory lock keyed on a string; released when the transaction ends. */
export async function advisoryLock(tx: Tx, namespace: string, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${namespace}), hashtext(${key}))`.execute(tx);
}

export const DB_TOKEN = Symbol('DB');
