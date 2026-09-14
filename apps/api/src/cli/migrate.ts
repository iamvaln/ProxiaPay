import { join } from 'node:path';
import { loadEnv } from './env';
import { createPool } from '../db/database';
import { runMigrations } from '../db/migrator';

async function main() {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url, 2);
  try {
    const applied = await runMigrations(pool, join(__dirname, '..', '..', 'migrations'), (m) => console.log(m));
    console.log(applied.length ? `applied ${applied.length} migration(s)` : 'schema is current');
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
