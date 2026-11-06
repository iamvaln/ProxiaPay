import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, SESSION_ENDED, get, post, readableError, sessionEvents } from './api';
import { t as translate } from './i18n';

const answer = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe('the end of a session', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is announced when the server says the session is gone, so the console returns to sign-in', async () => {
    const ended = vi.fn();
    sessionEvents.addEventListener(SESSION_ENDED, ended);
    answer(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    await expect(get('/home')).rejects.toThrow('Sign in to continue.');
    sessionEvents.removeEventListener(SESSION_ENDED, ended);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('is not announced for a wrong password or a pending second factor', async () => {
    const ended = vi.fn();
    sessionEvents.addEventListener(SESSION_ENDED, ended);
    answer(401, { error: { code: 'CREDENTIALS_INVALID', message: 'No match.' } });
    await expect(post('/auth/sign-in', {})).rejects.toThrow();
    answer(401, { error: { code: 'SECOND_FACTOR_REQUIRED', message: 'Complete the second factor to continue.' } });
    await expect(get('/home')).rejects.toThrow();
    sessionEvents.removeEventListener(SESSION_ENDED, ended);
    expect(ended).not.toHaveBeenCalled();
  });
});

describe('a readable error', () => {
  const en = (k: string, v?: Record<string, string | number>) => translate('en', k, v);
  const fr = (k: string, v?: Record<string, string | number>) => translate('fr', k, v);
  const invalid = (field: string, message: string) => new ApiError(400, 'FIELD_INVALID', `${field}: ${message}`, undefined, field);

  it('a non-integer bps is explained in words', () => {
    const err = invalid('processing_fee_bps', 'Invalid input: expected int, received number');
    expect(readableError(err, en)).toBe('Processing fee override: a whole number of basis points (250 = 2.5 %).');
    expect(readableError(err, fr)).toBe('Frais de traitement personnalisés : un nombre entier de points de base (250 = 2,5 %).');
  });

  it('names other fields in words', () => {
    expect(readableError(invalid('count_24h', 'Invalid input: expected number, received null'), en)).toBe('Count, 24 h: a whole number of transactions.');
    expect(readableError(invalid('code', 'Invalid string: must match pattern'), en)).toBe('Code: lowercase letters, digits and hyphens, 2 to 32 characters.');
  });

  it('falls back to the server message for a field or an error it does not know', () => {
    expect(readableError(invalid('mystery', 'Invalid input'), en)).toBe('mystery: Invalid input');
    expect(readableError(new ApiError(409, 'CONFLICT', 'The code is taken.'), en)).toBe('The code is taken.');
  });

  it('reads any error, not only an ApiError', () => {
    expect(readableError(new Error('Network down'), en)).toBe('Network down');
  });
});
