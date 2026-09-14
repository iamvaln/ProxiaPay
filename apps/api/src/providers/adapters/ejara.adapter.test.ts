import { afterEach, describe, expect, it, vi } from 'vitest';
import { EjaraAdapter } from './ejara.adapter';
import type { AdapterContext } from '../adapter';

/**
 * The adapter against the provider's real answers, recorded from the test box on 2026-09-14.
 * Every mapping written from the specification alone turned out wrong on first contact
 * (wallet envelope, initiation reference and state, error code field), and the suite passed
 * throughout because nothing exercised the adapter against a realistic payload. These do.
 */

const AUTH = { message: 'Successful', data: { accessToken: 'tok', expiresIn: 3600 } };
const WALLET = (id: number, serviceType: string) => ({
  message: 'Successful',
  data: { totalCount: 1, count: 1, data: [{ id, createdAt: '2026-05-11T15:21:32.357Z', accountId: 24, currencyId: 65, countryId: 41, reference: 'ab0c62a7-d78c-46fb-8c45-913637990f69', serviceType, status: 'active', availableBalance: '200', frozenBalance: '0', totalBalance: '200', currency: { isoCode: 'XAF' }, country: { shortCode: 'CM', name: 'Cameroon' } }] },
});
const INITIATED = { message: 'Request processed successfully', data: { providerChannel: 'api', paymentProvider: 'MYCOOLPAY', providerStatus: 'initiated', internalPaymentId: 'ACCT-EJARAX1l5qc11ighmmu1941c4', providerMessage: '#150*50#' } };
const REFUSED = { message: 'Insufficient wallet funds', errorCode: 'INSUFFICIENT_FUNDS' };
const CONFIRMED = { message: 'Successful', data: { status: 'confirmed', fees: '2', feePolicy: 'percentage', feeValue: '0.02', amount: '102', rawAmount: '100', validatedAt: '2026-09-14T13:00:00.082Z', internalReference: 'ACCT-EJARAX1l5qc11ighmmu191rff', operatorReference: '49dfd3e0-43f5-4f05-9646-4227166e27a1', providerReference: 'b581e630-5afb-4b73-aa74-0650764b15c5', externalTransactionReference: 'probe_1789390744503' } };
const BAD_KEY = { message: 'Client key is invalid', errorCode: 'INVALID_API_CLIENT' };

type Reply = { status: number; body: unknown };
function stubFetch(route: (url: string, init?: RequestInit) => Reply) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const r = route(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }));
}

function ctx(): AdapterContext {
  return { account: { id: 'acct', baseUrl: 'https://testbox.example', credentials: { clientKey: 'k', clientSecret: 's' } }, correlationId: 'corr', async recordPayload() { return 'p'; } };
}

afterEach(() => vi.unstubAllGlobals());

describe('Ejara adapter against recorded answers', () => {
  it('reads wallets from the nested page and the object-valued country and currency', async () => {
    stubFetch((url) => (url.endsWith('/accounts/authenticate') ? { status: 200, body: AUTH } : url.includes('serviceType=collection') ? { status: 200, body: WALLET(37, 'collection') } : { status: 200, body: WALLET(38, 'disbursement') }));
    const wallets = await new EjaraAdapter().wallets(ctx());
    expect(wallets).toEqual([
      { country: 'CM', currency: 'XAF', direction: 'collection', balance: 200, providerWalletId: '37' },
      { country: 'CM', currency: 'XAF', direction: 'disbursement', balance: 200, providerWalletId: '38' },
    ]);
  });

  it('takes internalPaymentId and providerStatus from an accepted initiation, so status() can be queried with it', async () => {
    stubFetch((url) => (url.endsWith('/accounts/authenticate') ? { status: 200, body: AUTH } : { status: 200, body: INITIATED }));
    const result = await new EjaraAdapter().submit(ctx(), { msisdn: '+237691980189', direction: 'collection', amount: 100, currency: 'XAF', currencyExponent: 0, country: 'CM', paymentMethod: 'OM', transactionReference: 'probe_1' } as never);
    expect(result).toMatchObject({ outcome: 'accepted', providerReference: 'ACCT-EJARAX1l5qc11ighmmu1941c4', state: 'processing' });
  });

  it('reads the refusal code from errorCode: an empty merchant wallet is INSUFFICIENT_FUNDS, not a bare 400', async () => {
    stubFetch((url) => (url.endsWith('/accounts/authenticate') ? { status: 200, body: AUTH } : { status: 400, body: REFUSED }));
    const result = await new EjaraAdapter().submit(ctx(), { msisdn: '+237691980189', direction: 'disbursement', amount: 100, currency: 'XAF', currencyExponent: 0, country: 'CM', paymentMethod: 'OM', transactionReference: 'probe_2' } as never);
    expect(result).toEqual({ outcome: 'rejected', reason: 'PROVIDER_REJECTED', providerCode: 'INSUFFICIENT_FUNDS', providerMessage: 'Insufficient wallet funds', payloadId: 'p' });
  });

  it('maps a confirmed status with its amounts and fee', async () => {
    stubFetch((url) => (url.endsWith('/accounts/authenticate') ? { status: 200, body: AUTH } : { status: 200, body: CONFIRMED }));
    const result = await new EjaraAdapter().status(ctx(), 'ACCT-EJARAX1l5qc11ighmmu191rff');
    expect(result).toMatchObject({ state: 'succeeded', requestedAmount: 100, chargedAmount: 102, providerFee: 2, operatorReference: '49dfd3e0-43f5-4f05-9646-4227166e27a1' });
  });

  it('names the rejected credential half in the authentication error', async () => {
    stubFetch(() => ({ status: 401, body: BAD_KEY }));
    await expect(new EjaraAdapter().wallets(ctx())).rejects.toThrow('authentication failed (401 INVALID_API_CLIENT: Client key is invalid)');
  });
});
