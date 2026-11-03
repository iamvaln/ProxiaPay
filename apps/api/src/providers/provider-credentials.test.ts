import { describe, expect, it } from 'vitest';
import { CredentialConfigError, credentialsFromEnv, envNameFor } from './provider-credentials';

const EJARA = ['clientKey', 'clientSecret'];

describe('provider credentials from a credentials file', () => {
  it('names each variable after the provider and the key the adapter declares', () => {
    expect(envNameFor('ejara', 'clientKey')).toBe('EJARA_CLIENT_KEY');
    expect(envNameFor('ejara', 'clientSecret')).toBe('EJARA_CLIENT_SECRET');
  });

  it('collects a complete set, keeping a $ in a secret exactly as written', () => {
    expect(credentialsFromEnv({ EJARA_CLIENT_KEY: 'k1', EJARA_CLIENT_SECRET: 'Ozp@u$Fp' }, 'ejara', EJARA))
      .toEqual({ status: 'complete', values: { clientKey: 'k1', clientSecret: 'Ozp@u$Fp' } });
  });

  it('reports a provider with nothing in the file as absent, leaving its stored credentials alone', () => {
    expect(credentialsFromEnv({ OTHER: 'x' }, 'ejara', EJARA)).toEqual({ status: 'absent' });
  });

  it('refuses half a set and names what is missing', () => {
    expect(() => credentialsFromEnv({ EJARA_CLIENT_KEY: 'k1' }, 'ejara', EJARA)).toThrow(/EJARA_CLIENT_SECRET/);
  });

  it('refuses a name the adapter would never read, and says which names it expects', () => {
    // The trap this exists for: Ejara calls it a client id, the adapter reads clientKey. Stored under
    // the wrong name, the adapter would send an empty header and Ejara would blame the credential.
    let err: unknown;
    try { credentialsFromEnv({ EJARA_CLIENT_ID: 'k1', EJARA_CLIENT_SECRET: 's1' }, 'ejara', EJARA); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CredentialConfigError);
    expect(String((err as Error).message)).toMatch(/EJARA_CLIENT_ID/);
    expect(String((err as Error).message)).toMatch(/EJARA_CLIENT_KEY, EJARA_CLIENT_SECRET/);
  });

  it('treats an empty value as missing, not as a credential', () => {
    expect(() => credentialsFromEnv({ EJARA_CLIENT_KEY: 'k1', EJARA_CLIENT_SECRET: '' }, 'ejara', EJARA)).toThrow(/EJARA_CLIENT_SECRET/);
  });
});
