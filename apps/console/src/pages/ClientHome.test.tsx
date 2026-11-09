// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const ACME = { id: 'c1', name: 'Acme' };
const BETA = { id: 'c2', name: 'Beta' };
const base = { administrator: { id: 'a1', name: 'Awa', email: 'awa@acme.test', language: 'en', timezone: 'UTC' }, kind: 'client', second_factor_complete: true, environment: 'sandbox', permission_catalogue: {}, permissions: ['transactions.read', 'projects.read'] };

const server = (state: { me: object }, posts: { path: string }[] = [], homes: (string | undefined)[] = []) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace(/^\/console/, '');
    if ((init.method ?? 'GET') === 'POST') {
      posts.push({ path });
      if (path === '/auth/active-client') state.me = { ...state.me, active_client: BETA };
      if (path.endsWith('/accept')) state.me = { ...state.me, active_client: ACME, clients: [ACME], pending_clients: [] };
      return new Response('{"ok":true}', { status: 200 });
    }
    if (path === '/home') return new Response('{"error":{"code":"NOT_FOUND","message":"Not found."}}', { status: 404 });
    if (path === '/client/home') { homes.push((state.me as { active_client?: { id: string } }).active_client?.id); return new Response(JSON.stringify({ collected_today: [{ currency: 'XAF', today: 250000, last_week: null }], success_rate: { current: 0.9, baseline: null, sample: 10 }, undetermined: 3 }), { status: 200 }); }
    return new Response(JSON.stringify(state.me), { status: 200 });
  }));
};
const app = () => render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>);

describe('a client account on the home', () => {
  it('reloads the home for the new client after a switch', async () => {
    const homes: (string | undefined)[] = [];
    server({ me: { ...base, active_client: ACME, clients: [ACME, BETA], pending_clients: [] } }, [], homes);
    app();
    fireEvent.change(await screen.findByLabelText('Client'), { target: { value: 'c2' } });
    await waitFor(() => expect(homes).toContain('c2'));
    expect(homes[0]).toBe('c1');
  });

  it('a client home shows its figures and no platform card', async () => {
    server({ me: { ...base, active_client: ACME, clients: [ACME], pending_clients: [] } });
    app();
    expect(await screen.findByText('Success rate, last hour')).toBeTruthy();
    expect(screen.getByText('90.0 %')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.queryByText(/waiting|float|approval/i)).toBeNull();
    expect(document.querySelector('a[href*="/oversight"], a[href*="/treasury"], a[href*="/reconciliation"], a[href="/approvals"]')).toBeNull();
  });

  it('calls no closed endpoint from the transactions page', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.replace(/^\/console/, '').split('?')[0]!;
      paths.push(path);
      return new Response(JSON.stringify(path === '/auth/me' ? { ...base, active_client: ACME, clients: [ACME], pending_clients: [] } : { data: [], total: 0, page: 1, page_size: 25, projects: [] }), { status: 200 });
    }));
    render(<MemoryRouter initialEntries={['/transactions']}><App /></MemoryRouter>);
    await waitFor(() => expect(paths).toContain('/transactions'));
    expect(paths.filter((p) => p.startsWith('/configuration'))).toEqual([]);
  });

  it('offers a pending invitation and accepts it', async () => {
    const posts: { path: string }[] = [];
    server({ me: { ...base, active_client: null, clients: [], pending_clients: [{ membership_id: 'm1', client_name: 'Acme' }] } }, posts);
    app();
    expect(await screen.findByText('You were invited to join Acme')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(posts).toEqual([{ path: '/auth/memberships/m1/accept' }]));
    await waitFor(() => expect(screen.queryByText('You were invited to join Acme')).toBeNull());
  });

  it('says so when nothing is pending and no client is active', async () => {
    server({ me: { ...base, active_client: null, clients: [], pending_clients: [] } });
    app();
    expect(await screen.findByText('Your account is not attached to a client yet.')).toBeTruthy();
  });
});
