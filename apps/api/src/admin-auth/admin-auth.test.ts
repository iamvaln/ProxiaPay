import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { AdminAuthService } from './admin-auth.service';
import { CryptoService } from '../crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { loadConfig, resetConfigForTests } from '../config/config';

let t: TestContext;
beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(() => t.reset());

const client = { address: '10.0.0.1', description: 'test' };
const service = (anySecondFactor: boolean) =>
  new AdminAuthService(t.db, t.app.get(CryptoService), t.app.get(SettingsService), t.app.get(AuditService), { SANDBOX_ANY_SECOND_FACTOR: anySecondFactor });

async function signedIn(auth: AdminAuthService) {
  const admin = await t.admin();
  const r = await auth.signIn(admin.email, admin.password, client);
  if (!('sessionToken' in r)) throw new Error('locked');
  return { ...r, principal: (await auth.resolveSession(r.sessionToken))! };
}

describe('the second factor', () => {
  it('requires enrolment and a real code by default', async () => {
    const auth = service(false);
    const s = await signedIn(auth);
    expect(s.secondFactor).toBe('enrol');
    await expect(auth.completeSecondFactor(s.principal, '123456', client)).rejects.toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' });
  });

  describe('waived on a sandbox that asks for it', () => {
    it('skips enrolment and accepts any six digits', async () => {
      const auth = service(true);
      const s = await signedIn(auth);
      expect(s.secondFactor).toBe('verify');
      await auth.completeSecondFactor(s.principal, '482913', client);
      expect((await auth.resolveSession(s.sessionToken))!.secondFactorComplete).toBe(true);
    });

    it('still wants six digits, so the form behaves as it will in production', async () => {
      const auth = service(true);
      const s = await signedIn(auth);
      await expect(auth.completeSecondFactor(s.principal, 'abc', client)).rejects.toMatchObject({ code: 'CREDENTIALS_INVALID' });
    });

    it('leaves a trace in the authentication history', async () => {
      const auth = service(true);
      const s = await signedIn(auth);
      await auth.completeSecondFactor(s.principal, '000000', client);
      const events = await t.db.selectFrom('authentication_event').select('reason').where('administrator_id', '=', s.principal.administratorId).execute();
      expect(events.map((e) => e.reason)).toContain('second factor waived on the sandbox');
    });
  });

  it('cannot be waived in production: the configuration refuses to load', () => {
    resetConfigForTests();
    expect(() => loadConfig({ ...process.env, PROXIAPAY_ENV: 'production', SANDBOX_ANY_SECOND_FACTOR: 'true' })).toThrow(/SANDBOX_ANY_SECOND_FACTOR/);
    resetConfigForTests();
  });
});
