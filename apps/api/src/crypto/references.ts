import { randomBytes } from 'node:crypto';

/** Crockford base32 without the ambiguous letters, uppercase, for references people read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function opaque(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! & 31];
  return out;
}

/** References sort roughly by time (first 8 chars encode milliseconds) and carry 80 bits of randomness. */
function timeOrdered(prefix: string): string {
  let t = Date.now();
  let head = '';
  for (let i = 0; i < 8; i++) {
    head = ALPHABET[t % 32] + head;
    t = Math.floor(t / 32);
  }
  return `${prefix}_${head}${opaque(16)}`;
}

export const newPreviewReference = (): string => timeOrdered('prv');
export const newTransactionReference = (): string => timeOrdered('txn');
export const newEventReference = (): string => timeOrdered('evt');
export const newExportReference = (): string => timeOrdered('exp');
export const newCorrelationId = (): string => opaque(20);
export const newCredentialKey = (env: 'production' | 'sandbox'): string => `pk_${env === 'production' ? 'live' : 'test'}_${opaque(24).toLowerCase()}`;
export const newCredentialSecret = (env: 'production' | 'sandbox'): string => `sk_${env === 'production' ? 'live' : 'test'}_${randomBytes(32).toString('base64url')}`;
