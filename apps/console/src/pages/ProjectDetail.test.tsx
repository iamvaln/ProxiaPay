// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../lib/session';
import { ProjectDetailPage } from './ProjectDetail';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const ME = {
  administrator: { id: 'a1', name: 'Valentine', email: 'v@proxiapay.test', language: 'en', timezone: 'UTC' }, second_factor_complete: true, environment: 'production', permission_catalogue: {},
  permissions: ['projects.credentials', 'projects.notifications', 'projects.entitlements', 'projects.origins', 'transactions.read'],
};
const PROJECT = {
  project: { id: 'p1', code: 'monjeton', name: 'MonJeton', status: 'active', created_at: '2026-11-01T10:00:00Z' },
  balances: [{ currency: 'XAF', available: 125000, reserved: 0 }], credentials: [], origins: [], entitlements: [], notification_endpoint: null,
};
const ROUTES = { routes: [{ id: 'r1', country_code: 'CM', payment_method_code: 'MOMO', direction: 'collection', currency_code: 'XAF', processing_fee_bps: 250, platform_fee_bps: 50, processing_fee_bearer: 'counterparty', platform_fee_bearer: 'project' }] };
const EMPTY_PAGE = { data: [], total: 0, page: 1, page_size: 25 };

/** A console API: answers by method and path, records every call; an unknown read is an empty list page. */
const server = (writes: Record<string, (body: any) => unknown> = {}) => {
  const calls: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^\/console/, '').split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const reads: Record<string, unknown> = { '/auth/me': ME, '/projects/p1': PROJECT, '/configuration/routes': ROUTES };
    const answer = method === 'GET' ? (reads[path] ?? EMPTY_PAGE) : (writes[`${method} ${path}`]?.(body) ?? {});
    return new Response(JSON.stringify(answer), { status: 200 });
  }));
  return calls;
};

const Where = () => <span data-testid="where">{useLocation().search}</span>;
const page = (url: string) => render(
  <SessionProvider><MemoryRouter initialEntries={[url]}><Routes><Route path="/projects/:id" element={<><ProjectDetailPage /><Where /></>} /></Routes></MemoryRouter></SessionProvider>,
);
const where = () => screen.getByTestId('where').textContent;
const card = (id: string) => within(document.getElementById(id)!);

describe('the project page', () => {
  it('switching tabs shows each section and keeps the tab in the URL', async () => {
    server();
    page('/projects/p1');
    expect(await screen.findByText('monjeton')).toBeTruthy();
    expect(screen.getByText('Balances')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Credentials' })).toBeNull();
    const sections: [string, string[]][] = [
      ['keys', ['Credentials', 'Notification endpoint']],
      ['origins', ['Declared origins', 'Recent refusals on origin']],
      ['routes', ['Entitlements']],
      ['deliveries', ['Deliveries']],
      ['activity', ['Activity']],
    ];
    for (const [tab, headings] of sections) {
      fireEvent.click(screen.getByRole('link', { name: tab }));
      for (const h of headings) expect(await screen.findByRole('heading', { name: h })).toBeTruthy();
      expect(screen.queryByText('monjeton')).toBeNull();
      expect(where()).toBe(`?tab=${tab}`);
    }
    fireEvent.click(screen.getByRole('link', { name: 'overview' }));
    expect(await screen.findByText('monjeton')).toBeTruthy();
    expect(where()).toBe('');
  });

  it('opens on the tab the URL names', async () => {
    server();
    page('/projects/p1?tab=routes');
    expect(await screen.findByRole('heading', { name: 'Entitlements' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Credentials' })).toBeNull();
  });

  it('issuing a credential then setting the webhook keeps both secrets, each in its own card', async () => {
    const calls = server({
      'POST /auth/confirmations': () => ({ confirmation_id: 'c1', expires_at: '' }),
      'POST /projects/p1/credentials': () => ({ key: 'pk_live_new', secret: 'sk_live_new' }),
      'PUT /projects/p1/notification-endpoint': () => ({ url: 'https://monjeton.cm/hook', signing_secret: 'whsec_new' }),
    });
    page('/projects/p1?tab=keys');
    fireEvent.click(await screen.findByRole('button', { name: 'Issue credential' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Confirmation code' }), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await card('credentials').findByText('sk_live_new')).toBeTruthy();
    expect(card('credentials').getByText('pk_live_new')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('https://…'), { target: { value: 'https://monjeton.cm/hook' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set address' }));
    expect(await card('notifications').findByText('whsec_new')).toBeTruthy();
    expect(card('credentials').getByText('sk_live_new')).toBeTruthy();
    expect(card('credentials').queryByText('whsec_new')).toBeNull();
    expect(card('notifications').queryByText('sk_live_new')).toBeNull();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ url: 'https://monjeton.cm/hook' });

    // Each panel goes only when its own value is acknowledged.
    fireEvent.click(card('notifications').getByRole('button', { name: 'I’ve copied it' }));
    expect(card('notifications').queryByText('whsec_new')).toBeNull();
    expect(card('credentials').getByText('sk_live_new')).toBeTruthy();
  });

  it('the grant form starts with empty limits and inherited placeholders', async () => {
    const calls = server({ 'POST /projects/p1/entitlements': () => ({ entitlement_id: 'e1', version_id: 'v1', sequence: 1 }) });
    page('/projects/p1?tab=routes');
    const limits = ['Count, 24 h', 'Value, 24 h', 'Count, 30 d', 'Value, 30 d'];
    for (const l of limits) {
      const input = (await screen.findByLabelText(l)) as HTMLInputElement;
      expect(input.value).toBe('');
      expect(input.required).toBe(true);
    }
    fireEvent.change(screen.getByLabelText('Route'), { target: { value: 'r1' } });
    expect((screen.getByLabelText('Processing fee override') as HTMLInputElement).placeholder).toBe('inherit: 250 bps (2.5 %)');
    expect((screen.getByLabelText('Platform fee override') as HTMLInputElement).placeholder).toBe('inherit: 50 bps (0.5 %)');
    expect((screen.getByLabelText('Processing fee bearer') as HTMLSelectElement).options[0]!.textContent).toBe('inherit: counterparty');
    expect((screen.getByLabelText('Platform fee bearer') as HTMLSelectElement).options[0]!.textContent).toBe('inherit: project');

    limits.forEach((l, i) => fireEvent.change(screen.getByLabelText(l), { target: { value: String([5000, 20000000, 100000, 400000000][i]) } }));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'MonJeton go-live' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit new version' }));
    expect((await screen.findByRole('status')).textContent).toBe('✓ Version #1 committed.');
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/projects/p1/entitlements')).toBe(true));
    expect(calls.find((c) => c.path === '/projects/p1/entitlements')!.body).toMatchObject({
      route_id: 'r1', count_24h: 5000, value_24h: 20000000, count_30d: 100000, value_30d: 400000000,
      processing_fee_bps: null, platform_fee_bps: null, processing_fee_bearer: null, platform_fee_bearer: null, note: 'MonJeton go-live', accept_shortfall: false,
    });
  });
});
