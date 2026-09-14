import { loadEnv } from './env';
import { createDb, createPool } from '../db/database';
import { countRoutes, seedReferenceData } from '../seed/seed';

async function main() {
  loadEnv();
  const env = (process.env.PROXIAPAY_ENV as 'production' | 'sandbox') ?? 'sandbox';
  const pool = createPool(process.env.DATABASE_URL!, 2);
  const db = createDb(pool);
  try {
    await db.transaction().execute((tx) => seedReferenceData(tx, { environment: env }));
    console.log(`seeded ${env} catalogue: ${await countRoutes(db)} routes`);
  } finally {
    await db.destroy();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
