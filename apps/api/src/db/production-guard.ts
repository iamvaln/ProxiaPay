import type { Pool } from 'pg';
import { appendOnlyMutations } from './app-role';

/**
 * In production the application must connect as the least-privilege role migrate maintains
 * (APP_DATABASE_URL). A missing or wrong URL would otherwise fall back to the owner and run the
 * app with every append-only revoke a no-op, silently; refuse to start instead. Strict: the role
 * must be no superuser and hold no UPDATE (table or column level) or DELETE on any table whose
 * triggers call refuse_mutation, the same derived list migrate revokes.
 */
export async function assertLeastPrivilegeRole(pool: Pool, environment: string): Promise<void> {
  if (environment !== 'production') return;
  const hint = 'Set APP_DATABASE_URL to the least-privilege app role (docs/production-deployment.md)';
  const { rows } = await pool.query<{ me: string; su: boolean }>(
    `select current_user as me, coalesce((select rolsuper from pg_roles where rolname = current_user), false) as su`);
  const { me, su } = rows[0]!;
  if (su) throw new Error(`refusing to start in production: the database role "${me}" is a superuser. ${hint}`);
  for (const { tbl, priv } of await appendOnlyMutations(pool)) {
    const { rows: held } = await pool.query<{ ok: boolean }>(
      priv === 'UPDATE' ? `select has_any_column_privilege(current_user, format('public.%I', $1::text), 'UPDATE') as ok`
                        : `select has_table_privilege(current_user, format('public.%I', $1::text), 'DELETE') as ok`, [tbl]);
    if (held[0]!.ok) throw new Error(`refusing to start in production: the database role "${me}" can ${priv} ${tbl}. ${hint}`);
  }
}
