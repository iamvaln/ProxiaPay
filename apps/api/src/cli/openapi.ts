import { writeFileSync } from 'node:fs';
import { buildOpenApi } from '../docs/openapi';

/**
 * Writes the interface specification the API serves at /docs/openapi.json to a file, for
 * publication elsewhere. Usage: npm run openapi -- [--env production|sandbox] [--out openapi.json]
 */
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? ''] : [])).filter((p) => p.length)) as Record<string, string>;
const env = args.env === 'production' ? 'production' : 'sandbox';
const out = args.out ?? 'openapi.json';
writeFileSync(out, JSON.stringify(buildOpenApi(env), null, 2));
console.log(`wrote ${out} for ${env}`);
