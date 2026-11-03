import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { truncateAll } from '../test/db';
import { seedReferenceData } from './seed';
import { RouteResolver } from '../routes/route-resolver';
import { PlatformError } from '../common/errors';

let t: TestContext;
beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(async () => { await truncateAll(t.db); });

const activeCodes = async () => (await t.db.selectFrom('country').select('code').where('active', '=', true).orderBy('code').execute()).map((c) => c.code);
const snapshot = async () => ({
  countries: await t.db.selectFrom('country').select(['code', 'active']).orderBy('code').execute(),
  routes: (await t.db.selectFrom('route').select('id').execute()).length,
  versions: (await t.db.selectFrom('route_version').select('id').execute()).length,
  bindings: (await t.db.selectFrom('route_binding').select('id').execute()).length,
});

describe('production seed', () => {
  it('points the production Ejara account at the prodbox URL', async () => {
    await seedReferenceData(t.db, { environment: 'production' });
    const account = await t.db.selectFrom('provider_account').selectAll().where('name', '=', 'Ejara Pay (production)').executeTakeFirstOrThrow();
    expect(account.base_url).toBe('https://prodbox-valentines-payment.ejaraapis.xyz');
    expect(account.has_test_environment).toBe(false);
  });

  it('production seed leaves only Cameroon live', async () => {
    await seedReferenceData(t.db, { environment: 'production' });
    expect(await activeCodes()).toEqual(['CM']);
    expect((await t.db.selectFrom('route').select('id').execute()).length).toBeGreaterThan(0);
    const { id: projectId } = await t.project('shop');
    const resolver = t.app.get(RouteResolver);
    const input = { projectId, direction: 'collection' as const, paymentMethod: 'MOMO', amount: 1000 };
    await expect(resolver.resolve(t.db, { ...input, country: 'CM', currency: 'XAF' })).resolves.toMatchObject({ country: { code: 'CM' } });
    const err = await resolver.resolve(t.db, { ...input, country: 'BF', currency: 'XOF' }).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.code).toBe('COUNTRY_DISABLED');
  });

  it('sandbox seed keeps every country active', async () => {
    await seedReferenceData(t.db, { environment: 'sandbox' });
    const all = await t.db.selectFrom('country').select('code').execute();
    expect(all.length).toBeGreaterThan(1);
    expect(await activeCodes()).toEqual(all.map((c) => c.code).sort());
  });

  it('re-running the production seed changes nothing, even after a console activation', async () => {
    await seedReferenceData(t.db, { environment: 'production' });
    const first = await snapshot();
    await seedReferenceData(t.db, { environment: 'production' });
    expect(await snapshot()).toEqual(first);
    await t.db.updateTable('country').set({ active: true }).where('code', '=', 'BF').execute();
    await seedReferenceData(t.db, { environment: 'production' });
    expect(await activeCodes()).toEqual(['BF', 'CM']);
  });
});
