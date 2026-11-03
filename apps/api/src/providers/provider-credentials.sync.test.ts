import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { ProviderAccountService } from './provider-account.service';

let t: TestContext;
let accounts: ProviderAccountService;
let ejaraId: string;

beforeAll(async () => { t = await createTestContext(); accounts = t.app.get(ProviderAccountService); });
afterAll(() => t.close());
beforeEach(async () => {
  await t.reset();
  ejaraId = (await t.db.insertInto('provider_account').values({ provider_code: 'ejara', name: 'Ejara Pay (test)', base_url: 'https://ejara.test' }).returning('id').executeTakeFirstOrThrow()).id;
});

const audits = () => t.db.selectFrom('audit_record').select(['actor_id', 'action']).where('action', '=', 'provider_account.credentials_replaced').where('subject_id', '=', ejaraId).execute();
const stored = async () => (await accounts.context(t.db, ejaraId, 'test')).ctx.account.credentials;
const FILE = { EJARA_CLIENT_KEY: 'k1', EJARA_CLIENT_SECRET: 'Ozp@u$Fp' };

describe('syncing provider credentials from a credentials file', () => {
  it('seals a complete set, a $ intact, and records it in the audit trail as the system', async () => {
    const results = await accounts.syncCredentials(FILE);
    expect(results).toContainEqual({ accountId: ejaraId, provider: 'ejara', status: 'sealed' });
    expect(await stored()).toEqual({ clientKey: 'k1', clientSecret: 'Ozp@u$Fp' });
    expect(await audits()).toEqual([{ actor_id: null, action: 'provider_account.credentials_replaced' }]);
  });

  it('leaves unchanged credentials alone, so running on every deploy adds nothing to the audit trail', async () => {
    await accounts.syncCredentials(FILE);
    const second = await accounts.syncCredentials(FILE);
    expect(second).toContainEqual({ accountId: ejaraId, provider: 'ejara', status: 'unchanged' });
    expect(await audits()).toHaveLength(1);
  });

  it('re-seals when a value changes', async () => {
    await accounts.syncCredentials(FILE);
    const rotated = await accounts.syncCredentials({ ...FILE, EJARA_CLIENT_SECRET: 'new-secret' });
    expect(rotated).toContainEqual({ accountId: ejaraId, provider: 'ejara', status: 'sealed' });
    expect((await stored()).clientSecret).toBe('new-secret');
    expect(await audits()).toHaveLength(2);
  });

  it('keeps stored credentials when the file says nothing about the provider', async () => {
    await accounts.syncCredentials(FILE);
    expect(await accounts.syncCredentials({})).toContainEqual({ accountId: ejaraId, provider: 'ejara', status: 'absent' });
    expect(await stored()).toEqual({ clientKey: 'k1', clientSecret: 'Ozp@u$Fp' });
  });

  it('skips a provider whose adapter needs no credentials', async () => {
    const results = await accounts.syncCredentials(FILE);
    expect(results.filter((r) => r.provider === 'simulator').every((r) => r.status === 'not_needed')).toBe(true);
  });

  it('refuses to guess between two accounts of the same provider', async () => {
    await t.db.insertInto('provider_account').values({ provider_code: 'ejara', name: 'Ejara Pay (second)', base_url: 'https://ejara2.test' }).execute();
    await expect(accounts.syncCredentials(FILE)).rejects.toThrow(/two|several|more than one/i);
  });
});
