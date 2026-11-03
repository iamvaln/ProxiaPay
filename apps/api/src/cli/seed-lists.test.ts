import { describe, expect, it } from 'vitest';
import { assertSafeTarget } from './seed-lists';

const local = 'postgres://u:p@127.0.0.1:5433/proxiapay_preview';

describe('seed-lists', () => {
  it('refuses to run in production, or with no environment named', () => {
    expect(() => assertSafeTarget('production', local)).toThrow(/PROXIAPAY_ENV=sandbox/);
    expect(() => assertSafeTarget(undefined, local)).toThrow(/PROXIAPAY_ENV=sandbox/);
    expect(() => assertSafeTarget('development', local)).toThrow(/PROXIAPAY_ENV=sandbox/);
  });
  it('runs in sandbox against a local database', () => {
    expect(() => assertSafeTarget('sandbox', local)).not.toThrow();
    expect(() => assertSafeTarget('sandbox', 'postgres://u:p@localhost/db')).not.toThrow();
  });
  it('refuses a database that is not local unless forced', () => {
    const remote = 'postgres://u:p@db.internal.example:5432/proxiapay';
    expect(() => assertSafeTarget('sandbox', remote)).toThrow(/SEED_LISTS_ALLOW_REMOTE/);
    expect(() => assertSafeTarget('sandbox', undefined)).toThrow(/DATABASE_URL/);
    expect(() => assertSafeTarget('sandbox', remote, '1')).not.toThrow();
  });
});
