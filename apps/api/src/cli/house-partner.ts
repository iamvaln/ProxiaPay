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
  const usage = 'usage: --name NAME --owner-email EMAIL --projects code,code,…';
  const argv = process.argv.slice(2);
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!['--name', '--owner-email', '--projects'].includes(flag)) throw new Error(`unknown argument ${flag}; ${usage}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value; ${usage}`);
    args[flag.slice(2)] = value;
  }
  const { name, 'owner-email': ownerEmail, projects } = args;
  const projectCodes = (projects ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  if (!name?.trim() || !ownerEmail || projectCodes.length === 0) throw new Error(usage);
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
