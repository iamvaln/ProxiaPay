import { loadEnv } from './env';
import { loadConfig } from '../config/config';
import { createDb, createPool } from '../db/database';
import { countRoutes, seedReferenceData } from '../seed/seed';

async function main() {
  loadEnv();
  const config = loadConfig(); // validated, so a malformed alert address fails here rather than at delivery
  const env = config.PROXIAPAY_ENV;
  const pool = createPool(config.DATABASE_URL, 2);
  const db = createDb(pool);
  try {
    const alertAddresses = { Finance: config.ALERT_EMAIL_FINANCE, Developers: config.ALERT_EMAIL_DEVELOPERS, Administrators: config.ALERT_EMAIL_ADMINISTRATORS };
    await db.transaction().execute((tx) => seedReferenceData(tx, { environment: env, alertAddresses }));
    console.log(`seeded ${env} catalogue: ${await countRoutes(db)} routes`);
  } finally {
    await db.destroy();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
