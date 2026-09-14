import 'reflect-metadata';
import { loadEnv } from './env';
import { NestFactory } from '@nestjs/core';
import { CoreModule } from '../core.module';
import { AdminAuthService } from '../admin-auth/admin-auth.service';
import { DB_TOKEN, type Db } from '../db/database';

/**
 * Creates the first administrator and assigns the Owner role (spec 16.1: administration runs on a
 * single role holding every permission at the foundations stage). Usage:
 *   npm run admin:create -- --name "Ada" --email ada@example.com --password 'a-long-passphrase'
 */
async function main() {
  loadEnv();
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : [])).filter((p) => p.length));
  const { name, email, password } = args as Record<string, string>;
  if (!name || !email || !password) throw new Error('usage: --name NAME --email EMAIL --password PASSWORD [--role Owner]');
  const app = await NestFactory.createApplicationContext(CoreModule, { logger: ['error'] });
  const db = app.get<Db>(DB_TOKEN);
  const auth = app.get(AdminAuthService);
  try {
    const roleName = args.role ?? 'Owner';
    const role = await db.selectFrom('role').select('id').where('name', '=', roleName).executeTakeFirst();
    if (!role) throw new Error(`role ${roleName} does not exist; run the seed first`);
    const { id } = await db.transaction().execute(async (tx) => {
      const created = await auth.createAdministrator(tx, { name, email, password });
      await tx.insertInto('role_assignment').values({ administrator_id: created.id, role_id: role.id, scope_type: 'all' }).execute();
      return created;
    });
    console.log(`administrator ${email} created (${id}) with role ${roleName}; enrol an authenticator at first sign-in`);
  } finally {
    await app.close();
    await db.destroy();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
