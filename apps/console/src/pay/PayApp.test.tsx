// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeFromPath, paidAt, PayApp, pollDelay } from './PayApp';
import { KEYS, t } from './i18n';

const CODE = 'AbCdEfGhIj';
const TOKEN = 'T'.repeat(43);
const FAST = { pollFast: 10, pollSlow: 10, slowAfter: 1000, checkingFor: 60_000, quoteDelay: 30 };

const LINK = {
  code: CODE, project_name: 'Acme Shop', title: 'School fees', description: 'Term 1', amount_type: 'fixed', amount: 5000, minimum_amount: 0,
  currency: 'XAF', exponent: 0, sandbox: true, brand: { logo_url: null, primary_color: '#1A56DB', secondary_color: null },
  countries: [{ code: 'CM', name: 'Cameroon', dialling_prefix: '+237' }],
  methods: [
    { key: 'k-om', country: 'CM', name: 'Orange Money', minimum_amount: 100, maximum_amount: 1_000_000, charged_amount: 5125 },
    { key: 'k-momo', country: 'CM', name: 'MTN MoMo', minimum_amount: 100, maximum_amount: 1_000_000, charged_amount: 5100 },
  ],
};
const FREE = { ...LINK, amount_type: 'free', amount: null, minimum_amount: 100, methods: LINK.methods.map(({ charged_amount: _, ...m }) => m) };
const TWO_COUNTRIES = {
  ...LINK,
  countries: [...LINK.countries, { code: 'GA', name: 'Gabon', dialling_prefix: '+241' }],
  methods: [...LINK.methods, { key: 'k-airtel', country: 'GA', name: 'Airtel Money', minimum_amount: 100, maximum_amount: 1_000_000, charged_amount: 5150 }],
};
const REVIEW = {
  amount: 5000, fees_borne_by_payer: 125, total: 5125, currency: 'XAF', method: { country: 'CM', name: 'Orange Money' },
  msisdn_formatted: '+237 6 99 12 34 11', expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
};
const status = (state: string, over: Record<string, unknown> = {}) => ({
  state, reference: 'PP-7K2Q9X4M', amount: 5000, charged_amount: 5125, currency: 'XAF', method: { country: 'CM', name: 'Orange Money' },
  instructions: null, outcome: ['succeeded', 'failed', 'expired'].includes(state) ? { failure_reason_text: state === 'succeeded' ? null : 'The payer declined the request.' } : null,
  project_name: 'Acme Shop', title: 'School fees', exponent: 0, sandbox: true, msisdn_masked: '+237•••••3411',
  completed_at: ['succeeded', 'failed', 'expired'].includes(state) ? '2026-11-15T13:32:00.000Z' : null, brand: { logo_url: null, primary_color: '#1A56DB' }, ...over,
});

type Answer = unknown | Response | (() => unknown | Response);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number, code: string, message: string, field?: string) => json({ error: { code, message, ...(field ? { field } : {}) } }, status);

/** The pay API: answers by method and path (query aside) and records every call the page makes. */
function server(routes: Record<string, Answer>) {
  const calls: { method: string; url: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.split('?')[0]!;
    calls.push({ method, url, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${path}`];
    if (route === undefined) return refusal(404, 'NOT_FOUND', 'No such resource.');
    const answer = typeof route === 'function' ? (route as () => unknown)() : route;
    return answer instanceof Response ? answer : json(answer);
  }));
  return calls;
}
const at = (path: string, hash = '') => window.history.replaceState(null, '', `${path}${hash}`);
const languages = (list: string[]) => Object.defineProperty(window.navigator, 'languages', { value: list, configurable: true });
const main = () => within(document.querySelector('.pay-main') as HTMLElement);

beforeEach(() => { at(`/${CODE}`); languages(['en-GB', 'en']); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); at('/'); });

describe('the payment page', () => {
  it('a fixed link goes form → review (total) → confirm → request sent → receipt', async () => {
    let state = 'submitted';
    const calls = server({
      [`GET /pay-api/v1/links/${CODE}`]: LINK,
      [`POST /pay-api/v1/links/${CODE}/previews`]: { payment_token: TOKEN, review: REVIEW },
      [`POST /pay-api/v1/payments/${TOKEN}/confirm`]: { reference: 'PP-7K2Q9X4M' },
      [`GET /pay-api/v1/payments/${TOKEN}`]: () => status(state, { instructions: 'Dial #150# and approve with your PIN.' }),
    });
    render(<PayApp timings={FAST} />);
    expect(await screen.findByRole('heading', { name: 'School fees' })).toBeTruthy();
    expect(screen.getByText('Sandbox — no real money moves')).toBeTruthy();
    expect(screen.getByText('Total to pay with Orange Money: 5,125 XAF')).toBeTruthy();
    expect(screen.getByText('+237')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Orange Money number'), { target: { value: '699 12 34 11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Check before you pay')).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/previews'))!.body).toEqual({ method: 'k-om', msisdn: '699 12 34 11' });
    expect(screen.getByText('Total to pay')).toBeTruthy();
    expect(screen.getByText('+237 6 99 12 34 11')).toBeTruthy();
    expect(screen.getByText(/This total holds for (9|10) minutes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and pay 5,125 XAF' }));

    expect(await screen.findByText('A payment request was sent to +237 6 99 12 34 11. Approve it on your phone or in your Orange Money app.')).toBeTruthy();
    // The payer approves on their phone: nothing to type, the route's own words shown.
    expect(screen.getByText('Dial #150# and approve with your PIN.')).toBeTruthy();
    expect(document.querySelector('.pay-main input, .pay-main select, .pay-main textarea')).toBeNull();
    expect(window.location.hash).toBe(`#p=${TOKEN}`);
    expect(calls.filter((c) => c.path.endsWith(`/payments/${TOKEN}`)).every((c) => c.url.endsWith('?lang=en'))).toBe(true);

    state = 'succeeded';
    expect(await screen.findByText('Payment successful')).toBeTruthy();
    expect(main().getByText('Receipt')).toBeTruthy();
    expect(main().getByText('PP-7K2Q9X4M')).toBeTruthy();
    expect(main().getByText('5,125 XAF')).toBeTruthy();
    // The receipt carries the masked number and when the payment went through, never the full number.
    expect(main().getByText('Orange Money · +237•••••3411')).toBeTruthy();
    expect(main().queryByText(/6 99 12 34 11/)).toBeNull();
    expect(main().getByText('15 November 2026 at 14:32')).toBeTruthy();
    // Polling stops on the outcome.
    const reads = calls.filter((c) => c.path.endsWith(`/payments/${TOKEN}`)).length;
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.filter((c) => c.path.endsWith(`/payments/${TOKEN}`)).length).toBe(reads);
    // The page never calls a path outside /pay-api/v1.
    expect(calls.every((c) => c.url.startsWith('/pay-api/v1/'))).toBe(true);
  });

  it('request sent shows the route instructions and no input, and a reload resumes from the fragment', async () => {
    at(`/${CODE}`, `#p=${TOKEN}`);
    server({
      [`GET /pay-api/v1/links/${CODE}`]: LINK,
      [`GET /pay-api/v1/payments/${TOKEN}`]: status('processing', { instructions: 'Approve in the Orange Money app.' }),
    });
    render(<PayApp timings={FAST} />);
    expect(await screen.findByText('A payment request was sent to your phone. Approve it on your phone or in your Orange Money app.')).toBeTruthy();
    expect(screen.getByText('Approve in the Orange Money app.')).toBeTruthy();
    expect(screen.getByText('Waiting for your approval…')).toBeTruthy();
    expect(document.querySelector('.pay-main input, .pay-main select, .pay-main textarea')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('a free link quotes as the payer types, once they pause', async () => {
    const calls = server({
      [`GET /pay-api/v1/links/${CODE}`]: FREE,
      [`POST /pay-api/v1/links/${CODE}/quote`]: { charged_amount: 2560, fees_borne_by_payer: 60 },
      [`POST /pay-api/v1/links/${CODE}/previews`]: { payment_token: TOKEN, review: { ...REVIEW, amount: 2500, fees_borne_by_payer: 60, total: 2560 } },
    });
    render(<PayApp timings={FAST} />);
    const amount = await screen.findByLabelText('Amount (XAF)');
    expect(screen.getByText('Minimum 100 XAF')).toBeTruthy();
    expect(screen.getByText('Amount of your choice')).toBeTruthy();
    for (const v of ['2', '25', '250', '2500']) fireEvent.change(amount, { target: { value: v } });
    expect(await screen.findByText('Fees 60 XAF · total to pay 2,560 XAF')).toBeTruthy();
    const quotes = calls.filter((c) => c.path.endsWith('/quote'));
    expect(quotes.map((c) => c.body)).toEqual([{ method: 'k-om', amount: 2500 }]);

    fireEvent.change(screen.getByLabelText('Orange Money number'), { target: { value: '699123411' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('button', { name: 'Confirm and pay 2,560 XAF' })).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/previews'))!.body).toEqual({ method: 'k-om', msisdn: '699123411', amount: 2500 });
  });

  it('refuses a free amount below the minimum beside the field, without asking the API', async () => {
    const calls = server({ [`GET /pay-api/v1/links/${CODE}`]: FREE });
    render(<PayApp timings={FAST} />);
    const amount = await screen.findByLabelText('Amount (XAF)');
    fireEvent.change(amount, { target: { value: '50' } });
    fireEvent.blur(amount);
    expect(await screen.findByText('The amount must be at least 100 XAF.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('no country selector with one country; with two, the selector and its prefix', async () => {
    server({ [`GET /pay-api/v1/links/${CODE}`]: LINK });
    render(<PayApp timings={FAST} />);
    await screen.findByLabelText('Payment method');
    expect(screen.queryByLabelText('Country')).toBeNull();
    cleanup();

    server({ [`GET /pay-api/v1/links/${CODE}`]: TWO_COUNTRIES });
    render(<PayApp timings={FAST} />);
    const country = await screen.findByLabelText('Country');
    fireEvent.change(country, { target: { value: 'GA' } });
    expect(screen.getByText('+241')).toBeTruthy();
    expect(screen.getByLabelText('Airtel Money number')).toBeTruthy();
    expect(within(screen.getByLabelText('Payment method')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Airtel Money']);
  });

  it('a link with no method left says so', async () => {
    server({ [`GET /pay-api/v1/links/${CODE}`]: { ...LINK, countries: [], methods: [] } });
    render(<PayApp timings={FAST} />);
    expect(await screen.findByText('No payment method is available right now. Please try again later.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('an unavailable link shows the neutral message', async () => {
    server({ [`GET /pay-api/v1/links/${CODE}`]: refusal(404, 'LINK_UNAVAILABLE', 'This link is no longer available') });
    render(<PayApp timings={FAST} />);
    expect(await screen.findByText('This link is no longer available')).toBeTruthy();
  });

  it('shows a field error beside its field, and a plain word for too many attempts', async () => {
    let answer = refusal(400, 'FIELD_INVALID', 'ENGLISH FROM THE API', 'msisdn');
    server({ [`GET /pay-api/v1/links/${CODE}`]: LINK, [`POST /pay-api/v1/links/${CODE}/previews`]: () => answer });
    render(<PayApp timings={FAST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const error = await screen.findByText('Enter a valid number for Cameroon.');
    expect(error.id).toBe('pay-msisdn-error');
    expect(screen.getByLabelText('Orange Money number').getAttribute('aria-invalid')).toBe('true');

    answer = refusal(429, 'RATE_LIMITED', 'Too many requests from this connection. Wait a minute and try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Too many attempts, please wait a moment.')).toBeTruthy();
  });

  it('success shows the receipt and sends the email; a failed send says to save it instead', async () => {
    at(`/${CODE}`, `#p=${TOKEN}`);
    let sent: 'sent' | 'failed' = 'sent';
    const calls = server({
      [`GET /pay-api/v1/links/${CODE}`]: refusal(404, 'LINK_UNAVAILABLE', 'This link is no longer available'),
      [`GET /pay-api/v1/payments/${TOKEN}`]: status('succeeded'),
      [`POST /pay-api/v1/payments/${TOKEN}/receipt`]: () => ({ status: sent }),
    });
    const print = vi.fn();
    vi.stubGlobal('print', print);
    render(<PayApp timings={FAST} />);
    // A paid single-use link is gone, yet its receipt reloads from the fragment, with the client's face and the sandbox band.
    expect(await screen.findByText('Payment successful')).toBeTruthy();
    expect(screen.getByText('Sandbox — no real money moves')).toBeTruthy();
    expect(main().getByText('Acme Shop')).toBeTruthy();
    expect(main().getByText('School fees')).toBeTruthy();
    expect(main().getByText('Orange Money · +237•••••3411')).toBeTruthy();
    expect((document.querySelector('.pay-page') as HTMLElement).style.getPropertyValue('--pay-primary')).toBe('#1A56DB');
    fireEvent.change(screen.getByLabelText(/Get the receipt by email/), { target: { value: 'ama@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send me the receipt' }));
    expect(await screen.findByText('The receipt is on its way. Check your inbox.')).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/receipt'))!.body).toEqual({ email: 'ama@example.com', language: 'en' });

    sent = 'failed';
    fireEvent.click(screen.getByRole('button', { name: 'Send me the receipt' }));
    expect(await screen.findByText('We could not send the email; save the receipt instead.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save or print the receipt' }));
    expect(print).toHaveBeenCalledOnce();
  });

  it('a failure gives the reason and "Try again" while the link takes payments', async () => {
    at(`/${CODE}`, `#p=${TOKEN}`);
    server({ [`GET /pay-api/v1/links/${CODE}`]: LINK, [`GET /pay-api/v1/payments/${TOKEN}`]: status('failed') });
    render(<PayApp timings={FAST} />);
    expect(await screen.findByText('The payer declined the request.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(window.location.hash).toBe('');
  });

  it('a payment being checked lets the payer close the page', async () => {
    at(`/${CODE}`, `#p=${TOKEN}`);
    server({ [`GET /pay-api/v1/links/${CODE}`]: LINK, [`GET /pay-api/v1/payments/${TOKEN}`]: status('undetermined') });
    render(<PayApp timings={FAST} />);
    expect(await screen.findByText('We are checking with the operator; you can close this page.')).toBeTruthy();
  });

  it('speaks French when the browser asks for it, passes the language on, and switches on request', async () => {
    languages(['fr-FR', 'fr']);
    at(`/${CODE}`, `#p=${TOKEN}`);
    const calls = server({
      [`GET /pay-api/v1/links/${CODE}`]: LINK,
      [`GET /pay-api/v1/payments/${TOKEN}`]: status('succeeded'),
      [`POST /pay-api/v1/payments/${TOKEN}/receipt`]: { status: 'sent' },
    });
    render(<PayApp timings={FAST} />);
    expect(await screen.findByText('Paiement réussi')).toBeTruthy();
    expect(screen.getByText('Sandbox — aucun argent réel ne circule')).toBeTruthy();
    expect(screen.getByText('Paiement sécurisé · Powered by ProxiaPay')).toBeTruthy();
    expect(document.documentElement.lang).toBe('fr');
    expect(calls.find((c) => c.path.endsWith(`/payments/${TOKEN}`))!.url).toMatch(/\?lang=fr$/);
    fireEvent.change(screen.getByLabelText(/Recevoir le reçu par email/), { target: { value: 'ama@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'M’envoyer le reçu' }));
    await screen.findByText('Le reçu est en route. Consultez votre boîte de réception.');
    expect(calls.find((c) => c.path.endsWith('/receipt'))!.body.language).toBe('fr');

    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(await screen.findByText('Payment successful')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('?lang=en'))).toBe(true));
  });

  describe('every refusal reads in French on a French page, never in the API’s English', () => {
    const API = 'ENGLISH FROM THE API';
    beforeEach(() => languages(['fr-FR']));

    const atPreview: [string, Response | (() => Response), string, 'free' | 'fixed'][] = [
      ['a number refused by the form', () => refusal(400, 'FIELD_INVALID', API, 'msisdn'), 'Saisissez un numéro valide pour ce pays (Cameroun).', 'fixed'],
      ['a number the platform refuses', () => refusal(400, 'PAYER_IDENTIFIER_INVALID', API, 'msisdn'), 'Saisissez un numéro valide pour ce pays (Cameroun).', 'fixed'],
      ['a method no longer offered', () => refusal(400, 'FIELD_INVALID', API, 'method'), 'Ce moyen de paiement n’est pas disponible sur ce lien.', 'fixed'],
      ['an amount the method cannot take', () => refusal(400, 'FIELD_INVALID', API, 'amount'), 'Ce montant ne peut pas être payé avec ce moyen de paiement.', 'free'],
      ['a number already paying', () => refusal(409, 'SIMILAR_PAYMENT_PENDING', API), 'Un paiement depuis ce numéro est déjà en cours.', 'fixed'],
      ['no provider', () => refusal(503, 'NO_PROVIDER_AVAILABLE', API), 'Ce moyen de paiement n’est pas disponible pour le moment. Réessayez plus tard.', 'fixed'],
      ['no float', () => refusal(503, 'FLOAT_INSUFFICIENT', API), 'Ce moyen de paiement n’est pas disponible pour le moment. Réessayez plus tard.', 'fixed'],
      ['the link’s count cap', () => refusal(422, 'VELOCITY_COUNT_EXCEEDED', API), 'Ce lien ne peut pas recevoir plus de paiements pour le moment. Réessayez plus tard.', 'fixed'],
      ['the link’s value cap', () => refusal(422, 'VELOCITY_VALUE_EXCEEDED', API), 'Ce lien ne peut pas recevoir plus de paiements pour le moment. Réessayez plus tard.', 'fixed'],
      ['too many attempts', () => refusal(429, 'RATE_LIMITED', API), 'Trop de tentatives, patientez un instant.', 'fixed'],
      ['a payment that did not start', () => refusal(409, 'REFERENCE_CONFLICT', API), 'Une erreur est survenue. Réessayez.', 'fixed'],
      ['a field the page does not show', () => refusal(400, 'FIELD_INVALID', API, 'reference'), 'Une erreur est survenue. Réessayez.', 'fixed'],
    ];
    for (const [what, answer, french, kind] of atPreview) {
      it(`at the preview: ${what}`, async () => {
        server({ [`GET /pay-api/v1/links/${CODE}`]: kind === 'free' ? FREE : LINK, [`POST /pay-api/v1/links/${CODE}/previews`]: answer });
        render(<PayApp timings={FAST} />);
        if (kind === 'free') fireEvent.change(await screen.findByLabelText('Montant (XAF)'), { target: { value: '2500' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Continuer' }));
        expect(await screen.findByText(french)).toBeTruthy();
        expect(screen.queryByText(API)).toBeNull();
      });
    }

    it('at the quote: an amount the method cannot take', async () => {
      server({ [`GET /pay-api/v1/links/${CODE}`]: FREE, [`POST /pay-api/v1/links/${CODE}/quote`]: () => refusal(400, 'FIELD_INVALID', API, 'amount') });
      render(<PayApp timings={FAST} />);
      fireEvent.change(await screen.findByLabelText('Montant (XAF)'), { target: { value: '2500' } });
      expect(await screen.findByText('Ce montant ne peut pas être payé avec ce moyen de paiement.')).toBeTruthy();
      expect(screen.queryByText(API)).toBeNull();
    });

    const atConfirm: [string, () => Response, string][] = [
      ['another payment in progress', () => refusal(409, 'LINK_PAYMENT_IN_PROGRESS', API), 'Un paiement est déjà en cours sur ce lien.'],
      ['another payment being checked', () => refusal(409, 'LINK_PAYMENT_BEING_CHECKED', API), 'Un paiement sur ce lien est en cours de vérification.'],
      ['an expired total', () => refusal(409, 'PREVIEW_EXPIRED', API), 'Ce total a expiré ; recommencez.'],
      ['a payment gone', () => refusal(404, 'NOT_FOUND', API), 'Ce paiement n’est plus disponible.'],
      ['an unknown code', () => refusal(500, 'INTERNAL_ERROR', API), 'Une erreur est survenue. Réessayez.'],
    ];
    for (const [what, answer, french] of atConfirm) {
      it(`at the confirmation: ${what}`, async () => {
        server({
          [`GET /pay-api/v1/links/${CODE}`]: LINK,
          [`POST /pay-api/v1/links/${CODE}/previews`]: { payment_token: TOKEN, review: REVIEW },
          [`POST /pay-api/v1/payments/${TOKEN}/confirm`]: answer,
        });
        render(<PayApp timings={FAST} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Continuer' }));
        fireEvent.click(await screen.findByRole('button', { name: /^Confirmer et payer/ }));
        expect(await screen.findByText(french)).toBeTruthy();
        expect(screen.queryByText(API)).toBeNull();
        expect(screen.getByRole('button', { name: 'Modifier' })).toBeTruthy();
      });
    }

    const atReceipt: [string, () => Response, string][] = [
      ['a bad address', () => refusal(400, 'FIELD_INVALID', API, 'email'), 'Saisissez une adresse email valide.'],
      ['a fourth receipt', () => refusal(409, 'RECEIPT_LIMIT_REACHED', API), 'Le reçu a déjà été envoyé trois fois.'],
      ['a receipt before success', () => refusal(409, 'RECEIPT_NOT_READY', API), 'Le reçu est disponible une fois le paiement réussi.'],
      ['a bad language', () => refusal(400, 'FIELD_INVALID', API, 'language'), 'Une erreur est survenue. Réessayez.'],
    ];
    for (const [what, answer, french] of atReceipt) {
      it(`at the receipt: ${what}`, async () => {
        at(`/${CODE}`, `#p=${TOKEN}`);
        server({
          [`GET /pay-api/v1/links/${CODE}`]: LINK,
          [`GET /pay-api/v1/payments/${TOKEN}`]: status('succeeded'),
          [`POST /pay-api/v1/payments/${TOKEN}/receipt`]: answer,
        });
        render(<PayApp timings={FAST} />);
        fireEvent.change(await screen.findByLabelText(/Recevoir le reçu par email/), { target: { value: 'ama@example.com' } });
        fireEvent.click(screen.getByRole('button', { name: 'M’envoyer le reçu' }));
        expect(await screen.findByText(french)).toBeTruthy();
        expect(screen.queryByText(API)).toBeNull();
      });
    }
  });

  it('a confirmation lost on the network offers to check the payment, not to edit it', async () => {
    let confirmed = false;
    const calls = server({
      [`GET /pay-api/v1/links/${CODE}`]: LINK,
      [`POST /pay-api/v1/links/${CODE}/previews`]: { payment_token: TOKEN, review: REVIEW },
      [`GET /pay-api/v1/payments/${TOKEN}`]: () => status('processing'),
    });
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/confirm')) { confirmed = true; throw new TypeError('Failed to fetch'); }
      return answer(url, init);
    });
    render(<PayApp timings={FAST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and pay 5,125 XAF' }));
    expect(await screen.findByText('We could not reach the server. Check your connection and try again.')).toBeTruthy();
    expect(confirmed).toBe(true);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(window.location.hash).toBe(`#p=${TOKEN}`);
    fireEvent.click(screen.getByRole('button', { name: 'Check the payment' }));
    expect(await screen.findByText('Approve the payment on your phone')).toBeTruthy();
    expect(calls.some((c) => c.path === `/pay-api/v1/payments/${TOKEN}`)).toBe(true);
  });

  it('stops asking about a payment still being checked after the checking time, keeping the message', async () => {
    at(`/${CODE}`, `#p=${TOKEN}`);
    const calls = server({ [`GET /pay-api/v1/links/${CODE}`]: LINK, [`GET /pay-api/v1/payments/${TOKEN}`]: status('undetermined') });
    render(<PayApp timings={{ ...FAST, checkingFor: 40 }} />);
    expect(await screen.findByText('We are checking with the operator; you can close this page.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 120));
    const reads = calls.filter((c) => c.path.endsWith(`/payments/${TOKEN}`)).length;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.filter((c) => c.path.endsWith(`/payments/${TOKEN}`)).length).toBe(reads);
    expect(screen.getByText('We are checking with the operator; you can close this page.')).toBeTruthy();
  });

  it('a change of language reads the payment again without restarting the quick pace', async () => {
    at(`/${CODE}`, `#p=${TOKEN}`);
    const calls = server({ [`GET /pay-api/v1/links/${CODE}`]: LINK, [`GET /pay-api/v1/payments/${TOKEN}`]: status('processing') });
    render(<PayApp timings={{ ...FAST, pollFast: 10, slowAfter: 50, pollSlow: 60_000 }} />);
    await screen.findByText('Waiting for your approval…');
    await new Promise((r) => setTimeout(r, 120));
    fireEvent.click(screen.getByRole('button', { name: 'Français' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('?lang=fr'))).toBe(true));
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.filter((c) => c.url.endsWith('?lang=fr'))).toHaveLength(1);
  });

  it('shows a logo only from the pay API’s asset path, else the initial', async () => {
    server({ [`GET /pay-api/v1/links/${CODE}`]: { ...LINK, brand: { ...LINK.brand, logo_url: 'https://elsewhere.example/logo.png' } } });
    render(<PayApp timings={FAST} />);
    await screen.findByRole('heading', { name: 'School fees' });
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.pay-initial')!.textContent).toBe('A');
    cleanup();

    server({ [`GET /pay-api/v1/links/${CODE}`]: { ...LINK, brand: { ...LINK.brand, logo_url: '/pay-api/v1/assets/0b5f1c9e-0000-4000-8000-000000000001' } } });
    render(<PayApp timings={FAST} />);
    await screen.findByRole('heading', { name: 'School fees' });
    expect(document.querySelector('img')!.getAttribute('src')).toBe('/pay-api/v1/assets/0b5f1c9e-0000-4000-8000-000000000001');
  });

  it('the page never calls a path outside /pay-api/v1, and shares no console module but its tokens and mark', () => {
    const dir = __dirname;
    const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f)).map((f) => readFileSync(join(dir, f), 'utf8'));
    const imports = sources.flatMap((s) => [...s.matchAll(/from '([^']+)'/g)].map((m) => m[1]!)).filter((p) => p.startsWith('..'));
    expect([...new Set(imports)]).toEqual(['../components/Logo']);
    const fetches = sources.flatMap((s) => [...s.matchAll(/fetch\(/g)]);
    expect(fetches).toHaveLength(1);
    expect(sources.join('\n')).toMatch(/const BASE = '\/pay-api\/v1';/);
    expect(sources.join('\n')).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
});

describe('the page’s shape', () => {
  it('reads the code from the path', () => {
    expect(codeFromPath(`/${CODE}`)).toBe(CODE);
    expect(codeFromPath(`/${CODE}/`)).toBe(CODE);
    expect(codeFromPath('/')).toBe('');
  });

  it('follows every 3 s for a minute, then every 10 s', () => {
    expect(pollDelay(0)).toBe(3000);
    expect(pollDelay(59_999)).toBe(3000);
    expect(pollDelay(60_000)).toBe(10_000);
  });

  it('stacks the brand panel above the form below 720 px, with touch-sized controls', () => {
    const css = readFileSync(join(__dirname, 'pay.css'), 'utf8');
    expect(css).toMatch(/\.pay-card \{[^}]*display: flex/);
    expect(css).toMatch(/@media \(max-width: 719px\) \{[^@]*\.pay-card \{[^}]*flex-direction: column/);
    expect(css).toMatch(/\.pay-page input, \.pay-page select \{[^}]*min-height: 48px/);
    expect(css).toMatch(/\.pay-page \.pay-button \{[^}]*min-height: 48px/);
    expect(css).toMatch(/\.pay-instructions p \{[^}]*overflow-wrap: anywhere/);
  });

  it('prints the receipt alone: no email field, no buttons, the sandbox band kept', () => {
    const css = readFileSync(join(__dirname, 'pay.css'), 'utf8');
    const print = /@media print \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    const hidden = /([^{}]*)\{\s*display: none;\s*\}/.exec(print)?.[1]?.split(',').map((x) => x.trim()) ?? [];
    expect(hidden).toEqual(expect.arrayContaining(['.pay-email', '.pay-page button']));
    expect(hidden).not.toContain('.pay-band');
    expect(hidden.some((x) => /pay-receipt|pay-summary|pay-main|pay-card/.test(x))).toBe(false);
  });

  it('dates the receipt in the method country’s time, in the page’s language', () => {
    expect(paidAt('2026-11-15T13:32:00Z', 'CM', 'en')).toBe('15 November 2026 at 14:32');
    expect(paidAt('2026-11-15T13:32:00Z', 'SN', 'fr')).toMatch(/^15 novembre 2026 (à )?13:32$/);
  });

  it('has every word in both languages', () => {
    for (const key of KEYS) {
      expect(t('en', key), key).not.toBe('');
      expect(t('fr', key), key).not.toBe('');
    }
  });
});
