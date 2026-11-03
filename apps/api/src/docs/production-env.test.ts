import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** The assignments of an env template: KEY=value lines that are not comments. */
function assigned(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of read(path).split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

const shared = assigned('deploy/production.env.example');
const owner = assigned('deploy/production.owner.env.example');

/** Keys of the config schema (apps/api/src/config/config.ts), read from its source. */
function schemaKeys(): string[] {
  const src = read('apps/api/src/config/config.ts');
  const body = src.slice(src.indexOf('z.object({'), src.indexOf('export type AppConfig'));
  return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);
}

/** ${VAR…} references in a compose file (not the $$VAR of a container's own shell). */
function composeVars(path: string): string[] {
  return [...read(path).matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!);
}

/** WALG_ / AWS_ / BACKUP_ variables the backup and archive scripts read. */
function opsVars(): string[] {
  const text = read('ops/backup/run.sh') + read('ops/db/archive.sh');
  const set = new Set([...text.matchAll(/\b((?:WALG|AWS|BACKUP)_[A-Z0-9_]+)\b/g)].map((m) => m[1]!));
  set.delete('WALG_PREVENT_WAL_OVERWRITE'); // set by archive.sh itself, not by the operator
  return [...set];
}

const OWNER_ONLY = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'DATABASE_URL', 'APP_DB_ROLE', 'APP_DB_PASSWORD'];
const isBackupSecret = (k: string) => /^(WALG|AWS|BACKUP)_/.test(k);
// Defaults derived at runtime, not configuration.
const DERIVED = new Set(['INSTANCE_NAME']);

describe('the production env templates', () => {
  it('names every variable production needs', () => {
    const needed = new Set([
      ...schemaKeys(),
      ...composeVars('docker-compose.deploy.yml'),
      ...composeVars('docker-compose.production.yml'),
      ...opsVars(),
    ]);
    for (const k of DERIVED) needed.delete(k);
    needed.delete('SANDBOX_ANY_SECOND_FACTOR');
    const missing = [...needed].filter((k) => !shared.has(k) && !owner.has(k));
    expect(missing).toEqual([]);
  });

  it('puts the shared variables in the shared file', () => {
    const wanted = [...schemaKeys(), 'APP_DATABASE_URL', 'OWNER_ENV_FILE', 'ENV_FILE', 'STACK', 'APP_DOMAIN', 'CERT_RESOLVER', 'COMPOSE_FILE', 'REGISTRY', 'IMAGE_TAG']
      .filter((k) => !DERIVED.has(k) && k !== 'SANDBOX_ANY_SECOND_FACTOR' && k !== 'DATABASE_URL');
    expect(wanted.filter((k) => !shared.has(k))).toEqual([]);
    expect(shared.get('PROXIAPAY_ENV')).toBe('production');
    expect(shared.get('STACK')).toBe('proxiapay');
    expect(shared.get('APP_DOMAIN')).toBe('pay.proxia-digital.com');
    expect(shared.get('CERT_RESOLVER')).toBe('le');
    expect(shared.get('TRUSTED_PROXY_HOPS')).toBe('1');
    expect(shared.get('COMPOSE_FILE')).toBe('docker-compose.deploy.yml:docker-compose.production.yml');
    expect(shared.get('OWNER_ENV_FILE')).toBe('.env.production.owner');
  });

  it('puts the owner credentials and every backup variable in the owner file', () => {
    const wanted = [...OWNER_ONLY, ...opsVars()];
    expect(wanted.filter((k) => !owner.has(k))).toEqual([]);
    expect(owner.get('WALG_S3_PREFIX')).toBe('s3://pay-db-backups/proxiapay');
  });

  it('keeps the owner credentials and the backup secrets out of the shared file', () => {
    const leaked = [...shared.keys()].filter((k) => OWNER_ONLY.includes(k) || isBackupSecret(k));
    expect(leaked).toEqual([]);
  });

  it('never repeats a variable across the two files', () => {
    expect([...shared.keys()].filter((k) => owner.has(k))).toEqual([]);
  });

  it('never sets the sandbox second-factor switch', () => {
    expect(shared.has('SANDBOX_ANY_SECOND_FACTOR')).toBe(false);
    expect(owner.has('SANDBOX_ANY_SECOND_FACTOR')).toBe(false);
  });

  it('holds no real secret: every secret is a placeholder', () => {
    for (const k of ['MASTER_KEY_BASE64', 'INDEX_KEY_BASE64', 'RESEND_API_KEY', 'APP_DATABASE_URL']) expect(shared.get(k), k).toMatch(/</);
    for (const k of ['POSTGRES_PASSWORD', 'DATABASE_URL', 'APP_DB_PASSWORD', 'WALG_LIBSODIUM_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) expect(owner.get(k), k).toMatch(/</);
  });
});
