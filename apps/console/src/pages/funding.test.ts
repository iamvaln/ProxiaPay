import { describe, expect, it } from 'vitest';
import { t } from '../lib/i18n';
import { emptyFunding, fundingRequest, walletChoices, type FundingTargets } from './funding';

const targets: FundingTargets = {
  provider_accounts: [
    { id: 'pa1', name: 'Ejara Pay', wallets: [{ country: 'CM', currency: 'XAF', direction: 'collection' }, { country: 'CM', currency: 'XAF', direction: 'disbursement' }, { country: 'CI', currency: 'XOF', direction: 'collection' }] },
    { id: 'pa2', name: 'Simulator', wallets: [] },
  ],
};
const filled = { ...emptyFunding, amount: 253, justification: 'opening', reference: 'bank-1' };

describe('the funding request', () => {
  it('names the provider account, country, currency and direction for a float, and nothing else', () => {
    expect(fundingRequest({ ...filled, target: 'float', provider_account_id: 'pa1', country: 'CM', currency: 'XAF', direction: 'collection' })).toEqual({
      target: 'float', provider_account_id: 'pa1', country: 'CM', direction: 'collection', currency: 'XAF', amount: 253, justification: 'opening', reference: 'bank-1',
    });
  });
  it('names the project for a project balance, and leaves the wallet out', () => {
    expect(fundingRequest({ ...filled, target: 'project', project_id: 'p1', provider_account_id: 'pa1', country: 'CM' })).toEqual({
      target: 'project', project_id: 'p1', currency: 'XAF', amount: 253, justification: 'opening', reference: 'bank-1',
    });
  });
  it('omits an empty reference', () => {
    expect(fundingRequest({ ...filled, reference: '', target: 'project', project_id: 'p1' })).not.toHaveProperty('reference');
  });
});

describe('the wallet choices', () => {
  it('offers only what the chosen provider account holds, narrowing as the choice is made', () => {
    expect(walletChoices(targets, 'pa1', {}).countries).toEqual(['CI', 'CM']);
    expect(walletChoices(targets, 'pa1', { country: 'CM' })).toMatchObject({ currencies: ['XAF'], directions: ['collection', 'disbursement'] });
    expect(walletChoices(targets, 'pa1', { country: 'CM', currency: 'XAF', direction: 'disbursement' }).complete).toBe(true);
    expect(walletChoices(targets, 'pa1', { country: 'CI' }).complete).toBe(false);
    expect(walletChoices(targets, 'pa2', {}).countries).toEqual([]);
    expect(walletChoices(targets, '', {}).countries).toEqual([]);
  });
});

describe('the funding wording', () => {
  it('exists in both languages', () => {
    for (const k of ['fund.provider_account', 'fund.country', 'fund.direction', 'fund.opens_float']) {
      expect(t('en', k)).not.toBe(k);
      expect(t('fr', k)).not.toBe(k);
    }
  });
});
