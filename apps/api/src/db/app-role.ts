import type { Pool, PoolClient } from 'pg';

/** Runs a statement built by the server's own format(): %I quotes identifiers, %L literals, so nothing is interpolated here. */
async function formatted(pool: Pool | PoolClient, template: string, ...args: string[]): Promise<void> {
  const { rows } = await pool.query<{ stmt: string }>('select format($1, variadic $2::text[]) as stmt', [template, args]);
  await pool.query(rows[0]!.stmt);
}

/** The app role must never be the owner or a superuser: it would make every revoke below a no-op. */
async function refuseOwnerRole(pool: Pool | PoolClient, role: string): Promise<void> {
  const { rows } = await pool.query<{ me: boolean; su: boolean }>(
    `select $1 = current_user as me, coalesce((select rolsuper from pg_roles where rolname = $1), false) as su`, [role]);
  if (rows[0]!.me) throw new Error(`APP_DB_ROLE ${role} is the migrating (owner) role; the application needs its own`);
  if (rows[0]!.su) throw new Error(`APP_DB_ROLE ${role} is a superuser; the application needs a plain role`);
}

/** Every (table, UPDATE | DELETE) a trigger executing refuse_mutation() guards: what the app role must never hold. */
export async function appendOnlyMutations(pool: Pool | PoolClient): Promise<{ tbl: string; priv: 'UPDATE' | 'DELETE' }[]> {
  const { rows } = await pool.query<{ tbl: string; priv: 'UPDATE' | 'DELETE' }>(`
      select distinct c.relname as tbl, p.priv
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        join pg_proc f on f.oid = t.tgfoid and f.proname = 'refuse_mutation'
        cross join lateral (values ('UPDATE', 16), ('DELETE', 8)) as p(priv, bit)
       where not t.tgisinternal and t.tgtype & p.bit <> 0
       order by 1, 2`);
  return rows;
}

/** Creates the application's login role, or resets its password if it already exists. */
export async function ensureAppRole(pool: Pool, role: string, password: string): Promise<void> {
  await refuseOwnerRole(pool, role);
  const { rowCount } = await pool.query('select 1 from pg_roles where rolname = $1', [role]);
  // CREATE/ALTER ROLE take no bind parameters for the password, hence %L.
  await formatted(pool, rowCount ? 'alter role %I login password %L' : 'create role %I login password %L', role, password);
}

/**
 * Gives the role the run of the schema, then takes back what the append-only tables must not allow.
 * Re-run after every migration: tables and sequences created since the last grant are covered, and
 * the revoke list is derived (any table with a trigger on UPDATE / DELETE that executes refuse_mutation),
 * so a later append-only table is protected without anyone remembering to list it.
 */
export async function grantAppRole(pool: Pool, role: string): Promise<{ revoked: string[] }> {
  const c = await pool.connect();
  try {
    await refuseOwnerRole(c, role);
    // One transaction: no moment where the blanket grant is in force and the revokes are not.
    await c.query('begin');
    const db = (await c.query<{ db: string }>('select current_database() as db')).rows[0]!.db;
    await formatted(c, 'grant connect on database %I to %I', db, role);
    await formatted(c, 'grant usage on schema public to %I', role);
    await formatted(c, 'grant select, insert, update, delete on all tables in schema public to %I', role);
    await formatted(c, 'grant usage, select on all sequences in schema public to %I', role);
    const rows: { tbl: string; priv: 'INSERT' | 'UPDATE' | 'DELETE' }[] = await appendOnlyMutations(c);
    // Migration history is the owner's alone: the application may read it, never rewrite it.
    rows.push(...(['INSERT', 'UPDATE', 'DELETE'] as const).map((priv) => ({ tbl: 'schema_migrations', priv })));
    for (const r of rows) await formatted(c, `revoke ${r.priv} on table %I from %I`, r.tbl, role);
    await c.query('commit');
    return { revoked: rows.map((r) => `${r.tbl}:${r.priv}`) };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** The role migrate should maintain: both variables set, or neither (sandbox, dev, CI); half is a deployment mistake. */
export function appRoleFromEnv(env: NodeJS.ProcessEnv): { role: string; password: string } | null {
  const role = env.APP_DB_ROLE, password = env.APP_DB_PASSWORD;
  if (!role && !password) return null;
  if (!role || !password) throw new Error('APP_DB_ROLE and APP_DB_PASSWORD must be set together');
  return { role, password };
}
