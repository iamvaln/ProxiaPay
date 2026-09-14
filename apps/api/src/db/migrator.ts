import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

/**
 * Applies SQL migration files in name order, each inside its own transaction, recording
 * them in schema_migrations. Files are never re-run and never edited once applied: a
 * change to the schema is a new file, in the manner of every other record the platform keeps.
 */
export async function runMigrations(pool: Pool, dir: string, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', ['proxiapay.migrations']);
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now(), checksum text not null)`);
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(join(dir, file), 'utf8');
      const checksum = require('node:crypto').createHash('sha256').update(body).digest('hex');
      await client.query('begin');
      try {
        await client.query(body);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [file, checksum]);
        await client.query('commit');
        applied.push(file);
        log(`applied ${file}`);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', ['proxiapay.migrations']);
    client.release();
  }
  return applied;
}
