import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './env';
import { CoreModule } from '../core.module';
import { DB_TOKEN, type Db } from '../db/database';
import { ProviderAccountService } from '../providers/provider-account.service';
import { CredentialConfigError } from '../providers/provider-credentials';

/**
 * Seals provider credentials from a credentials file into each provider account.
 *
 *   node dist/cli/set-credentials.js /run/provider-credentials.env
 *
 * The file holds `<PROVIDER>_<KEY>=value` lines, e.g. EJARA_CLIENT_KEY and EJARA_CLIENT_SECRET,
 * and is parsed here directly: it must never be given to Compose as an env file, which would
 * interpolate a `$` in a secret and silently truncate it. Only changed credentials are re-sealed,
 * so the deploy workflow runs this every time.
 */
async function main() {
  const path = process.argv[2];
  if (!path) throw new CredentialConfigError('usage: set-credentials <path to credentials file>');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CredentialConfigError(`cannot read the credentials file at ${path}`);
  }
  loadEnv();
  const app = await NestFactory.createApplicationContext(CoreModule, { logger: ['error'], abortOnError: false });
  try {
    for (const r of await app.get(ProviderAccountService).syncCredentials(parseEnv(text))) {
      console.log(`${r.provider.padEnd(12)} ${r.accountId}  ${r.status}`);
    }
  } finally {
    await app.get<Db>(DB_TOKEN).destroy();
    await app.close();
  }
}
main().catch((e) => {
  console.error(e instanceof CredentialConfigError ? `credentials not applied: ${e.message}` : e);
  process.exit(1);
});
