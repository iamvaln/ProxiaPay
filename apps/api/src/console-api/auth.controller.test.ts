import { describe, expect, it } from 'vitest';
import { ConsoleAuthController } from './auth.controller';

describe('the console sign-in page', () => {
  // The environment is not a secret (the address already says it), and the sign-in page must show it before anyone signs in.
  it('learns which environment it is in without a session', () => {
    for (const env of ['sandbox', 'production'] as const) {
      const controller = new ConsoleAuthController(null as never, { PROXIAPAY_ENV: env, NODE_ENV: 'test', TRUSTED_PROXY_HOPS: 0 }, null as never, null as never, null as never);
      expect(controller.environment()).toEqual({ environment: env });
    }
  });

  it('answers that route with no guard in front of it', () => {
    expect(Reflect.getMetadata('__guards__', ConsoleAuthController.prototype.environment)).toBeUndefined();
  });
});
