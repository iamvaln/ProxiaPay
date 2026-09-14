import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOTS = [process.cwd(), resolve(__dirname, '..', '..'), resolve(__dirname, '..', '..', '..', '..')];

/**
 * Loads .env, then .env.local, each from the first of the working directory, the api package or the
 * repository root that has one; real deployments set variables directly. A variable already set is
 * never overwritten, so .env.local supplements .env rather than overriding it.
 */
export function loadEnv(): void {
  for (const name of ['.env', '.env.local']) {
    const found = ROOTS.map((root) => resolve(root, name)).find((path) => existsSync(path));
    if (found) process.loadEnvFile(found);
  }
}
