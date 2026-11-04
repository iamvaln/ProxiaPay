import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../test/context';
import { consoleRequest } from '../test/console-request';
import { LedgerService } from '../ledger/ledger.service';
import { TreasuryService } from '../treasury/treasury.service';
import { ConfirmationService } from '../admin-auth/confirmation.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { TreasuryController } from './treasury.controller';
import { Authorisation, type Grant } from '../admin-auth/authorisation.service';
import { ALL_PERMISSIONS } from '../permissions/permissions';

let t: TestContext;
const get = <T>(token: new (...a: never[]) => T) => t.app.get(token as never) as T;
const nul = null as never;
const controller = () => new TreasuryController(t.db, get(LedgerService), get(TreasuryService), nul, get(ConfirmationService), get(AuditService), nul, nul);

beforeAll(async () => { t = await createTestContext(); });
afterAll(() => t.close());
beforeEach(() => t.reset());

/** A request by a real administrator, since postings and the audit record reference the author. */
async function asAdmin(opts: Parameters<typeof consoleRequest>[1] = {}) {
  const admin = await t.admin();
  const base = consoleRequest(t, opts);
  return { ...base, principal: { ...base.principal, administratorId: admin.id } } as typeof base;
}

/** Funds with a confirmation code bound to exactly the submitted values, as the console does. */
async function fund(req: Awaited<ReturnType<typeof asAdmin>>, values: Record<string, unknown>, boundTo: Record<string, unknown> = values) {
  const fingerprint = ConfirmationService.fingerprint('funding.post', boundTo);
  const row = await t.db.insertInto('operation_confirmation').values({
    administrator_id: req.principal.administratorId, operation_type: 'funding.post', subject_reference: '', fingerprint,
    code_hash: CryptoService.tokenHash(`${fingerprint}:123456`), expires_at: new Date(Date.now() + 600_000),
  }).returning('id').executeTakeFirstOrThrow();
  return controller().funding({ ...values, confirmation: { id: row.id, code: '123456' } }, req);
}

async function wallet(direction: 'collection' | 'disbursement' = 'disbursement') {
  const cap = await t.db.selectFrom('provider_account_capability').select(['provider_account_id', 'country_code', 'currency_code']).where('direction', '=', direction).executeTakeFirstOrThrow();
  return { provider_account_id: cap.provider_account_id, country: cap.country_code, currency: cap.currency_code, direction };
}
const base = { target: 'float', amount: 5000, justification: 'opening balance' };

describe('funding opens the float it funds', () => {
  it('creates a float that did not exist, posts debit float / credit business capital, and lists it', async () => {
    const req = await asAdmin();
    const w = await wallet('disbursement');
    expect(await t.db.selectFrom('ledger_account').select('id').where('type', '=', 'float').execute()).toHaveLength(0);

    const res = await fund(req, { ...base, ...w });
    expect(res.float_account_id).toEqual(expect.any(String));

    const postings = await t.db.selectFrom('ledger_posting as p').innerJoin('ledger_account as a', 'a.id', 'p.account_id').select(['a.type', 'p.side', 'p.amount']).where('p.entry_id', '=', res.entry_id).execute();
    expect(postings).toEqual(expect.arrayContaining([{ type: 'float', side: 'debit', amount: 5000 }, { type: 'business_capital', side: 'credit', amount: 5000 }]));

    const listed = await controller().float(req);
    expect(listed.accounts.map((a: { id: string }) => a.id)).toEqual([res.float_account_id]);
    // The hourly drift check looks the float up by exactly this key; it now finds it, holding the funded amount.
    const ledger = get(LedgerService);
    const found = await ledger.findAccount(t.db, { type: 'float', providerAccountId: w.provider_account_id, countryCode: w.country, currency: w.currency, direction: w.direction });
    expect(found).toBe(res.float_account_id);
    expect(await ledger.balance(t.db, found!)).toBe(5000);
    expect(await t.db.selectFrom('audit_record').select('id').where('action', '=', 'funding.float').execute()).toHaveLength(1);
  });

  it('reuses the float when the same wallet is funded again', async () => {
    const req = await asAdmin();
    const w = await wallet('collection');
    const first = await fund(req, { ...base, ...w });
    const second = await fund(req, { ...base, ...w, amount: 700 });
    expect(second.float_account_id).toBe(first.float_account_id);
    expect(await t.db.selectFrom('ledger_account').select('id').where('type', '=', 'float').execute()).toHaveLength(1);
    expect(await get(LedgerService).balance(t.db, first.float_account_id!)).toBe(5700);
  });

  it('still funds an existing float by its id', async () => {
    const req = await asAdmin();
    const w = await wallet('collection');
    const id = await get(LedgerService).getOrCreateAccount(t.db, { type: 'float', providerAccountId: w.provider_account_id, countryCode: w.country, currency: w.currency, direction: w.direction });
    const res = await fund(req, { ...base, currency: w.currency, float_account_id: id });
    expect(res.float_account_id).toBe(id);
    expect(await get(LedgerService).balance(t.db, id)).toBe(5000);
  });

  describe('refuses', () => {
    const refused = async (values: (w: Awaited<ReturnType<typeof wallet>>) => Record<string, unknown>) => {
      const req = await asAdmin();
      const w = await wallet();
      await expect(fund(req, values(w))).rejects.toMatchObject({ code: 'FIELD_INVALID' });
      expect(await t.db.selectFrom('ledger_account').select('id').where('type', '=', 'float').execute()).toHaveLength(0);
      expect(await t.db.selectFrom('ledger_entry').select('id').where('entry_type', '=', 'float_funding').execute()).toHaveLength(0);
    };
    const uuid = '11111111-1111-4111-8111-111111111111';

    it('neither form', () => refused((w) => ({ ...base, currency: w.currency })));
    it('both forms', () => refused((w) => ({ ...base, ...w, float_account_id: uuid })));
    it('an incomplete wallet form', () => refused((w) => ({ ...base, currency: w.currency, provider_account_id: w.provider_account_id })));
    it('a provider account that does not exist', () => refused((w) => ({ ...base, ...w, provider_account_id: uuid })));
    it('a wallet the provider account has no capability for', () => refused((w) => ({ ...base, ...w, country: 'ZZ' })));
    it('a currency the provider account cannot hold', () => refused((w) => ({ ...base, ...w, currency: 'EUR' })));
    it('a float_account_id that is not a float', () => refused((w) => ({ ...base, currency: w.currency, float_account_id: uuid })));

    it('an account that is not a float, and a float in another currency', async () => {
      const req = await asAdmin();
      const w = await wallet();
      const ledger = get(LedgerService);
      const capital = await ledger.getOrCreateAccount(t.db, { type: 'business_capital', currency: w.currency });
      await expect(fund(req, { ...base, currency: w.currency, float_account_id: capital })).rejects.toMatchObject({ code: 'FIELD_INVALID' });
      const float = await ledger.getOrCreateAccount(t.db, { type: 'float', providerAccountId: w.provider_account_id, countryCode: w.country, currency: w.currency, direction: w.direction });
      await expect(fund(req, { ...base, currency: 'EUR', float_account_id: float })).rejects.toMatchObject({ code: 'FIELD_INVALID' });
      expect(await ledger.balance(t.db, float)).toBe(0);
    });
  });

  it('records the float it resolved in the audit record', async () => {
    const req = await asAdmin();
    const res = await fund(req, { ...base, ...(await wallet()) });
    const rec = await t.db.selectFrom('audit_record').select('new_state').where('action', '=', 'funding.float').executeTakeFirstOrThrow();
    expect(rec.new_state).toMatchObject({ float_account_id: res.float_account_id, amount: 5000 });
  });

  it('refuses a code requested for another wallet or amount', async () => {
    const req = await asAdmin();
    const w = await wallet('disbursement');
    const other = await wallet('collection');
    const asked = { ...base, ...w };
    await expect(fund(req, { ...base, ...other }, asked)).rejects.toMatchObject({ code: 'CONFIRMATION_INVALID' });
    await expect(fund(req, { ...asked, amount: 9000 }, asked)).rejects.toMatchObject({ code: 'CONFIRMATION_INVALID' });
    expect(await t.db.selectFrom('ledger_account').select('id').where('type', '=', 'float').execute()).toHaveLength(0);
  });

  it('refuses a suspended provider account', async () => {
    const req = await asAdmin();
    const w = await wallet();
    await t.db.updateTable('provider_account').set({ status: 'suspended' }).where('id', '=', w.provider_account_id).execute();
    await expect(fund(req, { ...base, ...w })).rejects.toMatchObject({ code: 'FIELD_INVALID' });
    expect(await t.db.selectFrom('ledger_account').select('id').where('type', '=', 'float').execute()).toHaveLength(0);
  });

  describe('for an administrator scoped to one provider account', () => {
    async function twoProviders() {
      const w = await wallet();
      const other = await t.db.insertInto('provider_account').values({ provider_code: 'simulator', name: 'Other', base_url: 'simulator://other' }).returning('id').executeTakeFirstOrThrow();
      await t.db.insertInto('provider_account_capability').values({ provider_account_id: other.id, country_code: w.country, currency_code: w.currency, direction: 'disbursement', payment_method_code: 'MOMO' }).execute();
      return { mine: w, otherId: other.id };
    }

    it('lists only that provider account', async () => {
      const { mine, otherId } = await twoProviders();
      const req = await asAdmin({ providerScope: [mine.provider_account_id] });
      const ids = (await controller().fundingTargets(req)).provider_accounts.map((p: { id: string }) => p.id);
      expect(ids).toEqual([mine.provider_account_id]);
      expect(ids).not.toContain(otherId);
    });

    it('funds within the scope and refuses outside it, by wallet and by float id', async () => {
      const { mine, otherId } = await twoProviders();
      const req = await asAdmin({ providerScope: [mine.provider_account_id] });
      await expect(fund(req, { ...base, ...mine })).resolves.toHaveProperty('float_account_id');
      await expect(fund(req, { ...base, ...mine, provider_account_id: otherId })).rejects.toMatchObject({ code: 'FIELD_INVALID', message: 'No such provider account.' });
      const foreign = await get(LedgerService).getOrCreateAccount(t.db, { type: 'float', providerAccountId: otherId, countryCode: mine.country, currency: mine.currency, direction: 'disbursement' });
      await expect(fund(req, { ...base, currency: mine.currency, float_account_id: foreign })).rejects.toMatchObject({ code: 'FIELD_INVALID' });
      expect(await get(LedgerService).balance(t.db, foreign)).toBe(0);
    });
  });

  describe('project funding', () => {
    /** An administrator whose treasury.funding reaches only the given projects. */
    async function scopedTo(projectIds: string[]) {
      const req = await asAdmin();
      const grants: Grant[] = ALL_PERMISSIONS.map((permission) => permission === 'treasury.funding'
        ? { permission, scopeType: 'projects', projectIds, providerAccountIds: [] }
        : { permission, scopeType: 'all', projectIds: [], providerAccountIds: [] });
      return { ...req, auth: new Authorisation(req.principal.administratorId, grants) } as typeof req;
    }
    const project = { target: 'project', currency: 'XAF', amount: 5000, justification: 'opening balance' };

    it('funds a project within the scope and refuses one outside it, or one that does not exist', async () => {
      const mine = await t.project('mine');
      const other = await t.project('other');
      const req = await scopedTo([mine.id]);
      await expect(fund(req, { ...project, project_id: mine.id })).resolves.toHaveProperty('entry_id');
      await expect(fund(req, { ...project, project_id: other.id })).rejects.toMatchObject({ code: 'FIELD_INVALID', message: 'No such project.' });
      await expect(fund(await asAdmin(), { ...project, project_id: '11111111-1111-4111-8111-111111111111' })).rejects.toMatchObject({ code: 'FIELD_INVALID', message: 'No such project.' });
      expect(await t.db.selectFrom('ledger_entry').select('id').where('entry_type', '=', 'project_funding').execute()).toHaveLength(1);
    });
  });

  it('lists the wallets that can be funded, from the provider accounts and their capabilities', async () => {
    const req = await asAdmin();
    const res = await controller().fundingTargets(req);
    const w = await wallet('disbursement');
    expect(res.provider_accounts.length).toBeGreaterThan(0);
    const pa = res.provider_accounts.find((p: { id: string }) => p.id === w.provider_account_id)!;
    expect(pa.wallets).toEqual(expect.arrayContaining([{ country: w.country, currency: w.currency, direction: 'disbursement' }]));
    expect(pa.wallets.every((x: Record<string, unknown>) => Object.keys(x).sort().join() === 'country,currency,direction')).toBe(true);
    void req;
  });
});
