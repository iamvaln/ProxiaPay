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
    if (path === '/home') { homes.push((state.me as { active_client?: { id: string } }).active_client?.id); return new Response('{"cards":{"awaiting_your_approval":[]}}', { status: 200 }); }
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
