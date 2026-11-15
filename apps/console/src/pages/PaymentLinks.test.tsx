// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../lib/session';
import { ProjectDetailPage } from './ProjectDetail';
import { TransactionsPage } from './Transactions';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const me = (permissions: string[]) => ({
  administrator: { id: 'a1', name: 'Valentine', email: 'v@proxiapay.test', language: 'en', timezone: 'UTC' }, second_factor_complete: true, environment: 'production', permission_catalogue: {}, permissions,
});
const PROJECT = {
  project: { id: 'p1', code: 'monjeton', name: 'MonJeton', status: 'active', created_at: '2026-11-01T10:00:00Z' },
  balances: [], credentials: [], origins: [], entitlements: [], notification_endpoint: null,
};
const ROUTES = { routes: [
  { id: 'r-cm', country: 'CM', payment_method: 'MOMO', payment_method_name: 'MTN MoMo', currency: 'XAF', minimum_amount: 100, maximum_amount: 1000000 },
  { id: 'r-ga', country: 'GA', payment_method: 'AIRTEL', payment_method_name: 'Airtel Money', currency: 'XAF', minimum_amount: 100, maximum_amount: 1000000 },
  { id: 'r-gh', country: 'GH', payment_method: 'MOMO', payment_method_name: 'MoMo Ghana', currency: 'GHS', minimum_amount: 100, maximum_amount: 100000 },
] };
const LINK = {
  id: 'l1', code: 'AbCdEfGhIj', url: 'https://pay.example.com/AbCdEfGhIj', title: 'Invoice 42', amount_type: 'free', amount: null, minimum_amount: 1000, currency: 'XAF', single_use: false, expires_at: null, status: 'active',
  methods: [{ country: 'CM', payment_method: 'MOMO', payment_method_name: 'MTN MoMo' }], payments: { count: 3, succeeded: 2, total_collected: 15000, last_at: '2026-11-10T10:00:00Z' },
};
const EMPTY_PAGE = { data: [], total: 0, page: 1, page_size: 25 };

/** A console API: answers by method and path and records every call. */
const server = (permissions: string[], over: { links?: unknown[]; writes?: Record<string, (body: any) => unknown> } = {}) => {
  const calls: { method: string; path: string; query: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const [path, query = ''] = url.replace(/^\/console/, '').split('?') as [string, string?];
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, query, body });
    const reads: Record<string, unknown> = {
      '/auth/me': me(permissions), '/projects/p1': PROJECT, '/projects/p1/payment-links': { links: over.links ?? [LINK] }, '/projects/p1/payment-links/routes': ROUTES,
      '/projects/p1/brand': { logo_asset_id: null, primary_color: '#1A56DB', secondary_color: null },
    };
    const write = over.writes?.[`${method} ${path}`];
    if (method !== 'GET' && !write) return new Response(JSON.stringify({}), { status: 200 });
    const answer = method === 'GET' ? (reads[path] ?? EMPTY_PAGE) : write!(body);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200 });
  }));
  return calls;
};
const project = (tab: string) => render(
  <SessionProvider><MemoryRouter initialEntries={[`/projects/p1?tab=${tab}`]}><Routes><Route path="/projects/:id" element={<ProjectDetailPage />} /></Routes></MemoryRouter></SessionProvider>,
);
const OWNER = ['projects.read', 'links.manage', 'transactions.read'];

describe('the payment links tab', () => {
  it('an owner creates a free link over two countries', async () => {
    const calls = server(OWNER, { writes: { 'POST /projects/p1/payment-links': () => ({ id: 'l2', code: 'Zz', url: 'https://pay.example.com/Zz' }) } });
    project('links');
    expect(await screen.findByText('Invoice 42')).toBeTruthy();
    const form = within(await waitFor(() => { const el = document.getElementById('new-link'); if (!el) throw new Error('no form'); return el; }));
    fireEvent.change(form.getByLabelText('Currency'), { target: { value: 'XAF' } });
    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'Donations' } });
    fireEvent.click(form.getByLabelText('Free: the payer chooses'));
    fireEvent.change(form.getByLabelText('Smallest amount accepted (XAF)'), { target: { value: '500' } });
    // Only the XAF routes are offered; the GHS one is not.
    expect(form.queryByLabelText('MoMo Ghana')).toBeNull();
    fireEvent.click(form.getByLabelText('MTN MoMo'));
    fireEvent.click(form.getByLabelText('Airtel Money'));
    fireEvent.click(form.getByRole('button', { name: 'Create the link' }));
    expect(await screen.findByText(/Link created: https:\/\/pay.example.com\/Zz/)).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/projects/p1/payment-links')!;
    expect(post.body).toMatchObject({ title: 'Donations', currency: 'XAF', amount_type: 'free', minimum_amount: 500, route_ids: ['r-cm', 'r-ga'], single_use: false, brand: { primary_color: '#1A56DB', secondary_color: null } });
    expect(post.body).not.toHaveProperty('amount');
  });

  it('an amount in a currency with decimals is typed in the currency and sent in minor units', async () => {
    const calls = server(OWNER, { writes: { 'POST /projects/p1/payment-links': () => ({ id: 'l2', code: 'Zz', url: 'https://pay.example.com/Zz' }) } });
    project('links');
    const form = within(await waitFor(() => { const el = document.getElementById('new-link'); if (!el) throw new Error('no form'); return el; }));
    fireEvent.change(form.getByLabelText('Currency'), { target: { value: 'GHS' } });
    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'Tickets' } });
    expect(form.queryByText(/minor units/)).toBeNull();
    fireEvent.change(form.getByLabelText('Amount (GHS)'), { target: { value: '12.50' } });
    fireEvent.click(form.getByLabelText('MoMo Ghana'));
    fireEvent.click(form.getByRole('button', { name: 'Create the link' }));
    await screen.findByText(/Link created/);
    expect(calls.find((c) => c.method === 'POST' && c.path === '/projects/p1/payment-links')!.body).toMatchObject({ currency: 'GHS', amount: 1250 });

    // The form clears after a create: a second link, free this time.
    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'Donations' } });
    fireEvent.click(form.getByLabelText('Free: the payer chooses'));
    fireEvent.change(form.getByLabelText('Smallest amount accepted (GHS)'), { target: { value: '2' } });
    fireEvent.click(form.getByLabelText('MoMo Ghana'));
    fireEvent.click(form.getByRole('button', { name: 'Create the link' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/projects/p1/payment-links')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/projects/p1/payment-links')[1]!.body).toMatchObject({ amount_type: 'free', minimum_amount: 200 });
  });

  it('shows when each link was last paid', async () => {
    server(['projects.read']);
    project('links');
    expect(await screen.findByText('Invoice 42')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /Last payment/ })).toBeTruthy();
    expect(screen.getByTitle('2026-11-10T10:00:00.000Z').textContent).toBe('10 Nov 2026, 10:00');
  });

  it('a developer sees the list but no create or disable', async () => {
    server(['projects.read', 'transactions.read']);
    project('links');
    expect(await screen.findByText('Invoice 42')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View payments' }).getAttribute('href')).toBe('/transactions?payment_link=l1');
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(document.getElementById('new-link')).toBeNull();
  });

  it('an owner disables an active link, once they confirm it cannot be undone', async () => {
    const calls = server(OWNER);
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    project('links');
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    expect(ask).toHaveBeenCalledWith('This link will stop accepting payments for good.');
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/disable'))).toBe(false);

    ask.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/projects/p1/payment-links/l1/disable')).toBe(true));
  });

  it('copy writes the URL', async () => {
    server(['projects.read']);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    project('links');
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    // Without transactions.read there are no payments to view.
    expect(screen.queryByRole('link', { name: 'View payments' })).toBeNull();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://pay.example.com/AbCdEfGhIj'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('says links are not configured instead of showing a broken address', async () => {
    server(['projects.read'], { links: [{ ...LINK, url: '' }] });
    project('links');
    expect(await screen.findByText('Payment links are not configured on this platform.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(screen.queryByText('QR code')).toBeNull();
  });

  it('shows the server refusal when the create is turned down', async () => {
    server(OWNER, { writes: { 'POST /projects/p1/payment-links': () => new Response(JSON.stringify({ error: { code: 'FIELD_INVALID', message: 'A link cannot use a route where the payer must type a code or open a page.', field: 'route_ids' } }), { status: 422 }) } });
    project('links');
    const form = within(await waitFor(() => { const el = document.getElementById('new-link'); if (!el) throw new Error('no form'); return el; }));
    fireEvent.change(form.getByLabelText('Currency'), { target: { value: 'XAF' } });
    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'X' } });
    fireEvent.change(form.getByLabelText('Amount (XAF)'), { target: { value: '500' } });
    fireEvent.click(form.getByLabelText('MTN MoMo'));
    fireEvent.click(form.getByRole('button', { name: 'Create the link' }));
    expect(await screen.findByText(/must type a code/)).toBeTruthy();
  });
});

describe('the brand section', () => {
  it('refuses a 201 KB logo before upload', async () => {
    const calls = server(OWNER);
    project('overview');
    const input = await screen.findByLabelText(/Logo \(PNG/);
    const big = new File([new Uint8Array(201 * 1024)], 'logo.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [big] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload the logo' }));
    expect(await screen.findByText('This file is over 200 KB. Choose a smaller image.')).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/brand/logo'))).toBe(false);
  });

  it('uploads a small logo as base64 and saves the colours', async () => {
    const calls = server(OWNER);
    project('overview');
    const input = await screen.findByLabelText(/Logo \(PNG/);
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload the logo' }));
    expect(await screen.findByText(/Logo saved/)).toBeTruthy();
    expect(calls.find((c) => c.path === '/projects/p1/brand/logo')!.body).toEqual({ data_base64: 'iVBORw==' });
    fireEvent.change(screen.getByLabelText('Primary colour'), { target: { value: '#112233' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the colours' }));
    expect(await screen.findByText(/Colours saved/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT' && c.path === '/projects/p1/brand')!.body).toEqual({ primary_color: '#112233', secondary_color: null });
  });

  it('a developer has no brand section', async () => {
    server(['projects.read']);
    project('overview');
    expect(await screen.findByText('monjeton')).toBeTruthy();
    expect(document.getElementById('brand')).toBeNull();
  });
});

describe('the transactions list for a payment link', () => {
  it('the transactions filter sends payment_link', async () => {
    const id = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
    const calls = server(['transactions.read']);
    render(<SessionProvider><MemoryRouter initialEntries={[`/transactions?payment_link=${id}`]}><Routes><Route path="/transactions" element={<TransactionsPage />} /></Routes></MemoryRouter></SessionProvider>);
    await waitFor(() => expect(calls.some((c) => c.path === '/transactions')).toBe(true));
    expect(new URLSearchParams(calls.find((c) => c.path === '/transactions')!.query).get('payment_link')).toBe(id);
    expect(screen.getByText('Payment link 0b1c2d3e')).toBeTruthy();
  });

  it('drops a payment_link that is not an id', async () => {
    const calls = server(['transactions.read']);
    render(<SessionProvider><MemoryRouter initialEntries={['/transactions?payment_link=nope']}><Routes><Route path="/transactions" element={<TransactionsPage />} /></Routes></MemoryRouter></SessionProvider>);
    await waitFor(() => expect(calls.some((c) => c.path === '/transactions')).toBe(true));
    expect(new URLSearchParams(calls.find((c) => c.path === '/transactions')!.query).has('payment_link')).toBe(false);
  });
});
