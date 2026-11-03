import { describe, expect, it } from 'vitest';
import { assertNotProduction } from './seed-lists';

describe('seed-lists', () => {
  it('refuses to run in production', () => {
    expect(() => assertNotProduction('production')).toThrow(/refuses/);
  });
  it('runs in sandbox and development', () => {
    expect(() => assertNotProduction('sandbox')).not.toThrow();
    expect(() => assertNotProduction(undefined)).not.toThrow();
  });
});
