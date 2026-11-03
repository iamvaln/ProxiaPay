import { join } from 'node:path';
import { loadEnv } from './env';
import { createPool } from '../db/database';
import { runMigrations } from '../db/migrator';
import { appRoleFromEnv, ensureAppRole, grantAppRole } from '../db/app-role';

async function main() {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const appRole = appRoleFromEnv(process.env);
  const pool = createPool(url, 2);
  try {
    const applied = await runMigrations(pool, join(__dirname, '..', '..', 'migrations'), (m) => console.log(m));
    console.log(applied.length ? `applied ${applied.length} migration(s)` : 'schema is current');
    // After every migrate, not only the first: a migration may have added tables the role must reach.
    if (appRole) {
      await ensureAppRole(pool, appRole.role, appRole.password);
      const { revoked } = await grantAppRole(pool, appRole.role);
      console.log(`granted ${appRole.role}; revoked ${revoked.join(', ')}`);
    }
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
