import { describe, expect, it } from 'vitest';
import { t } from './i18n';

describe('the environment names', () => {
  it('reads SANDBOX and PRODUCTION in both languages: they are names, not words to translate', () => {
    for (const lang of ['en', 'fr'] as const) {
      expect(t(lang, 'env.sandbox')).toBe('SANDBOX');
      expect(t(lang, 'env.production')).toBe('PRODUCTION');
    }
  });
});
