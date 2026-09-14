import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Loads .env from the api package or repository root when present; real deployments set variables directly. */
export function loadEnv(): void {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(__dirname, '..', '..', '.env'), resolve(__dirname, '..', '..', '..', '..', '.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}
