import type { Pool } from 'pg';

/**
 * In production the application must connect as the least-privilege role migrate maintains
 * (APP_DATABASE_URL). A missing or wrong URL would otherwise fall back to the owner and run the
 * app with every append-only revoke a no-op, silently; refuse to start instead.
 */
export async function assertLeastPrivilegeRole(pool: Pool, environment: string): Promise<void> {
  if (environment !== 'production') return;
  const { rows } = await pool.query<{ me: string; su: boolean; upd: boolean }>(
    `select current_user as me,
            coalesce((select rolsuper from pg_roles where rolname = current_user), false) as su,
            has_table_privilege(current_user, 'ledger_entry', 'UPDATE') as upd`);
  const { me, su, upd } = rows[0]!;
  if (su) throw new Error(`refusing to start in production: the database role "${me}" is a superuser. Set APP_DATABASE_URL to the least-privilege app role (docs/production-deployment.md)`);
  if (upd) throw new Error(`refusing to start in production: the database role "${me}" can UPDATE ledger_entry. Set APP_DATABASE_URL to the least-privilege app role (docs/production-deployment.md)`);
}
