import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './env';
import { CoreModule } from '../core.module';
import { ClientsModule } from '../clients/clients.module';
import { ClientsService } from '../clients/clients.service';
import { ClientProjectsService } from '../console-api/client-projects.service';
import { EntitlementService } from '../console-api/entitlement.service';
import { DB_TOKEN, type Db } from '../db/database';
import { PlatformError } from '../common/errors';
import { setUpHousePartner } from './house-partner-setup';

/** Just the services the setup reuses, so the CLI does not boot the HTTP modules. */
@Module({ imports: [CoreModule, ClientsModule], providers: [ClientProjectsService, EntitlementService] })
class HousePartnerCliModule {}

/**
 * Sets up the house partner (Proxia Digital) on an environment: the client, its projects, and a platform account as its owner.
 *
 *   node dist/cli/house-partner.js --name "Proxia Digital" --owner-email <platform admin email> --projects <code,code,…>
 *
 * Idempotent. Run by the controller on each environment, with Valentine's approval.
 */
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : [])).filter((p) => p.length));
  const { name, 'owner-email': ownerEmail, projects } = args as Record<string, string>;
  const projectCodes = (projects ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  if (!name || !ownerEmail || projectCodes.length === 0) throw new Error('usage: --name NAME --owner-email EMAIL --projects code,code,…');
  loadEnv();
  const app = await NestFactory.createApplicationContext(HousePartnerCliModule, { logger: ['error'], abortOnError: false });
  try {
    const db = app.get<Db>(DB_TOKEN);
    const done = await setUpHousePartner(db, { clients: app.get(ClientsService), clientProjects: app.get(ClientProjectsService) }, { name, ownerEmail, projectCodes });
    console.log(done.length ? done.join('\n') : 'nothing to do');
  } finally {
    await app.get<Db>(DB_TOKEN).destroy();
    await app.close();
  }
}
main().catch((e) => {
  console.error(e instanceof PlatformError ? `house partner not set up: ${e.message}` : e);
  process.exit(1);
});
