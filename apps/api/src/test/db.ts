import { join } from 'node:path';
import { sql } from 'kysely';
import type { Pool } from 'pg';
import { createDb, createPool, type Db } from '../db/database';
import { runMigrations } from '../db/migrator';

let pool: Pool | undefined;
let db: Db | undefined;

/** One pool per test file; the schema is migrated once and tables are truncated between tests. */
export async function testDb(): Promise<Db> {
  if (db) return db;
  pool = createPool(process.env.DATABASE_URL!, 8);
  await runMigrations(pool, join(__dirname, '..', '..', 'migrations'));
  db = createDb(pool);
  return db;
}

export async function truncateAll(d: Db): Promise<void> {
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`.execute(d);
  // Append-only triggers refuse DELETE; TRUNCATE bypasses row triggers, which is what a test reset wants.
  await sql.raw(`truncate table ${rows.map((r) => `"${r.tablename}"`).join(', ')} restart identity cascade`).execute(d);
}

export async function closeTestDb(): Promise<void> {
  await db?.destroy();
  db = undefined;
  pool = undefined;
}
