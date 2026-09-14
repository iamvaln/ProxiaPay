import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { CONFIG, type AppConfig } from '../config/config';

/**
 * Cryptographic primitives for the platform, in one place so the choices are reviewable.
 *
 * Secrets at rest (provider credentials, signing secrets, TOTP seeds, browser-step addresses,
 * payer identifiers) use envelope encryption: each record is sealed under a fresh data key with
 * AES-256-GCM, and the data key is wrapped under the master key. Rotating the master key means
 * re-wrapping data keys without touching the sealed data. The master key comes from the key
 * store; the local implementation reads it from the environment.
 *
 * Equality lookups over encrypted payer identifiers use a keyed blind index (HMAC-SHA256 under
 * a key separate from the master key), so a search never needs the plaintext and a leaked index
 * key reveals nothing without a candidate number to test.
 */
@Injectable()
export class CryptoService {
  private readonly masterKey: Buffer;
  private readonly indexKey: Buffer;

  constructor(@Inject(CONFIG) config: Pick<AppConfig, 'MASTER_KEY_BASE64' | 'INDEX_KEY_BASE64'>) {
    this.masterKey = config.MASTER_KEY_BASE64;
    this.indexKey = config.INDEX_KEY_BASE64;
  }

  /** Seals plaintext under a fresh data key. Output: version || wrappedKey(60) || iv(12) || tag(16) || ciphertext. */
  seal(plaintext: Buffer | string, aad = ''): Buffer {
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const dataKey = randomBytes(32);
    const wrapped = aesGcmEncrypt(this.masterKey, dataKey, Buffer.from('proxiapay:dek:v1'));
    const sealed = aesGcmEncrypt(dataKey, data, Buffer.from(aad));
    dataKey.fill(0);
    return Buffer.concat([Buffer.from([1]), wrapped, sealed]);
  }

  open(envelope: Buffer, aad = ''): Buffer {
    if (envelope.length < 1 + 60 + 28) throw new Error('envelope too short');
    if (envelope[0] !== 1) throw new Error(`unsupported envelope version ${envelope[0]}`);
    const wrapped = envelope.subarray(1, 61);
    const sealed = envelope.subarray(61);
    const dataKey = aesGcmDecrypt(this.masterKey, wrapped, Buffer.from('proxiapay:dek:v1'));
    try {
      return aesGcmDecrypt(dataKey, sealed, Buffer.from(aad));
    } finally {
      dataKey.fill(0);
    }
  }

  openString(envelope: Buffer, aad = ''): string {
    return this.open(envelope, aad).toString('utf8');
  }

  /** Keyed blind index for equality lookups on a normalised value. */
  blindIndex(value: string): Buffer {
    return createHmac('sha256', this.indexKey).update(value, 'utf8').digest();
  }

  /** One-way hash for bearer tokens and session identifiers, which are already high-entropy. */
  static tokenHash(token: string): Buffer {
    return createHash('sha256').update(token, 'utf8').digest();
  }

  static async hashSecret(secret: string): Promise<string> {
    return argon2.hash(secret, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  static async verifySecret(hash: string, secret: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, secret);
    } catch {
      return false;
    }
  }

  static constantTimeEqual(a: string | Buffer, b: string | Buffer): boolean {
    const ba = typeof a === 'string' ? Buffer.from(a, 'utf8') : a;
    const bb = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  static hmacSha256Hex(key: string | Buffer, message: string | Buffer): string {
    return createHmac('sha256', key).update(message).digest('hex');
  }

  static sha256Hex(message: string | Buffer): string {
    return createHash('sha256').update(message).digest('hex');
  }

  static randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Six-digit numeric code, uniformly distributed. */
  static randomNumericCode(digits = 6): string {
    const max = 10 ** digits;
    // Rejection sampling avoids modulo bias.
    const limit = Math.floor(0x100000000 / max) * max;
    for (;;) {
      const n = randomBytes(4).readUInt32BE(0);
      if (n < limit) return String(n % max).padStart(digits, '0');
    }
  }
}

function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function aesGcmDecrypt(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
