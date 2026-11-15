// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeFromPath, PayApp, pollDelay } from './PayApp';
import { KEYS, t } from './i18n';

const CODE = 'AbCdEfGhIj';
const TOKEN = 'T'.repeat(43);
const FAST = { pollFast: 10, pollSlow: 10, slowAfter: 1000, quoteDelay: 30 };

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
  instructions: null, outcome: ['succeeded', 'failed', 'expired'].includes(state) ? { failure_reason_text: state === 'succeeded' ? null : 'The payer declined the request.' } : null, ...over,
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
    expect(main().getByText('Orange Money · +237 6 99 12 34 11')).toBeTruthy();
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
    let answer = refusal(400, 'FIELD_INVALID', 'Enter the number to pay from.', 'msisdn');
    server({ [`GET /pay-api/v1/links/${CODE}`]: LINK, [`POST /pay-api/v1/links/${CODE}/previews`]: () => answer });
    render(<PayApp timings={FAST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const error = await screen.findByText('Enter the number to pay from.');
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
    // A paid single-use link is gone, yet its receipt reloads from the fragment.
    expect(await screen.findByText('Payment successful')).toBeTruthy();
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
    expect(css).toMatch(/@media print/);
  });

  it('has every word in both languages', () => {
    for (const key of KEYS) {
      expect(t('en', key), key).not.toBe('');
      expect(t('fr', key), key).not.toBe('');
    }
  });
});
