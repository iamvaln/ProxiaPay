import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CryptoService } from './crypto.service';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from './totp';
import { newPreviewReference, newTransactionReference } from './references';

const svc = new CryptoService({ MASTER_KEY_BASE64: randomBytes(32), INDEX_KEY_BASE64: randomBytes(32) });

describe('envelope encryption', () => {
  it('round-trips and binds associated data', () => {
    const env = svc.seal('+237677123456', 'txn');
    expect(svc.openString(env, 'txn')).toBe('+237677123456');
    expect(() => svc.open(env, 'other')).toThrow();
  });
  it('produces distinct ciphertext for identical plaintext', () => {
    expect(svc.seal('x').equals(svc.seal('x'))).toBe(false);
  });
  it('refuses tampering', () => {
    const env = svc.seal('secret');
    env[env.length - 1] = (env[env.length - 1] ?? 0) ^ 0xff;
    expect(() => svc.open(env)).toThrow();
  });
  it('blind index is deterministic and keyed', () => {
    expect(svc.blindIndex('a').equals(svc.blindIndex('a'))).toBe(true);
    const other = new CryptoService({ MASTER_KEY_BASE64: randomBytes(32), INDEX_KEY_BASE64: randomBytes(32) });
    expect(svc.blindIndex('a').equals(other.blindIndex('a'))).toBe(false);
  });
  it('hashes and verifies secrets with argon2id', async () => {
    const h = await CryptoService.hashSecret('sk_test_abc');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await CryptoService.verifySecret(h, 'sk_test_abc')).toBe(true);
    expect(await CryptoService.verifySecret(h, 'sk_test_abd')).toBe(false);
  });
  it('numeric codes have the requested length', () => {
    for (let i = 0; i < 50; i++) expect(CryptoService.randomNumericCode()).toMatch(/^\d{6}$/);
  });
});

describe('totp', () => {
  it('matches RFC 6238 test vectors (SHA-1, 8 digits truncated to 6)', () => {
    // RFC 4226 appendix D vectors for secret "12345678901234567890".
    const secret = Buffer.from('12345678901234567890');
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 1)).toBe('287082');
    expect(hotp(secret, 9)).toBe('520489');
  });
  it('base32 round-trips', () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
  it('verifies within a one-step window and rejects outside it', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const at = new Date(59_000);
    expect(verifyTotp(secret, totp(secret, at), at)).toBe(true);
    expect(verifyTotp(secret, totp(secret, at), new Date(at.getTime() + 30_000))).toBe(true);
    expect(verifyTotp(secret, totp(secret, at), new Date(at.getTime() + 90_000))).toBe(false);
    expect(verifyTotp(secret, '12345', at)).toBe(false);
  });
});

describe('references', () => {
  it('carry their prefix and are unique', () => {
    const refs = new Set(Array.from({ length: 1000 }, newPreviewReference));
    expect(refs.size).toBe(1000);
    expect(newTransactionReference()).toMatch(/^txn_[0-9A-Z]{24}$/);
  });
});
