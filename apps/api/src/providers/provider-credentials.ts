/**
 * Provider credentials as they arrive from a deployment's credentials file. Each adapter declares
 * the keys it reads; the variables are named mechanically from the provider and the key, so
 * Ejara's `clientKey` is `EJARA_CLIENT_KEY`. The file is parsed directly and never passed through
 * Compose, which interpolates `$` and would silently truncate a secret that contains one.
 */

export class CredentialConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialConfigError';
  }
}

export function envNameFor(providerCode: string, key: string): string {
  return `${providerCode}_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')}`.toUpperCase();
}

export type CredentialLookup = { status: 'absent' } | { status: 'complete'; values: Record<string, string> };

/**
 * A provider's credentials from the parsed file: complete, absent, or refused. Half a set is refused
 * rather than stored, and so is a name the adapter would never read — stored under the wrong key,
 * a credential becomes an empty header and the provider blames the credential.
 */
export function credentialsFromEnv(env: Record<string, string | undefined>, providerCode: string, keys: readonly string[]): CredentialLookup {
  const expected = keys.map((k) => envNameFor(providerCode, k));
  const prefix = `${providerCode.toUpperCase()}_`;
  const unknown = Object.keys(env).filter((name) => name.startsWith(prefix) && !expected.includes(name));
  if (unknown.length) {
    throw new CredentialConfigError(`${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not read by the ${providerCode} adapter; it expects ${expected.join(', ')}.`);
  }
  const present = expected.filter((name) => (env[name] ?? '') !== '');
  if (present.length === 0) return { status: 'absent' };
  const missing = expected.filter((name) => !present.includes(name));
  if (missing.length) throw new CredentialConfigError(`${providerCode} credentials are incomplete: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing or empty.`);
  return { status: 'complete', values: Object.fromEntries(keys.map((k) => [k, env[envNameFor(providerCode, k)]!])) };
}
