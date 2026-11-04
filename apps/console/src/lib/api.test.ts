import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_ENDED, get, post, sessionEvents } from './api';

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
