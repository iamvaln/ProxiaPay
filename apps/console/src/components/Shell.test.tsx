// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../lib/session';
import { Shell } from './Shell';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const ACME = { id: 'c1', name: 'Acme' };
const BETA = { id: 'c2', name: 'Beta' };
const clientMe = (clients = [ACME], extra: object = {}) => ({
  administrator: { id: 'a1', name: 'Awa', email: 'awa@acme.test', language: 'en', timezone: 'UTC' },
  kind: 'client', active_client: clients[0], clients, pending_clients: [],
  second_factor_complete: true, environment: 'sandbox', permission_catalogue: {},
  permissions: ['transactions.read', 'projects.read', 'client.members'], ...extra,
});

const server = (me: object) => {
  const posts: { path: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace(/^\/console/, '');
    if ((init.method ?? 'GET') === 'POST') { posts.push({ path, body: JSON.parse(String(init.body)) }); return new Response('{"ok":true}', { status: 200 }); }
    return new Response(JSON.stringify(me), { status: 200 });
  }));
  return posts;
};
const shell = () => render(<SessionProvider><MemoryRouter><Shell><p>page</p></Shell></MemoryRouter></SessionProvider>);

describe('the shell', () => {
  it('a client account sees Home, Transactions, Projects and Team, never Configuration, Treasury, Reconciliation or Oversight', async () => {
    server(clientMe());
    shell();
    await screen.findByText('Transactions');
    for (const present of ['Home', 'Transactions', 'Projects', 'Team', 'Account']) expect(screen.getByRole('link', { name: present })).toBeTruthy();
    for (const absent of ['Configuration', 'Treasury', 'Reconciliation', 'Oversight']) expect(screen.queryByRole('link', { name: absent })).toBeNull();
  });

  it('keeps Team for the owner only', async () => {
    server(clientMe([ACME], { permissions: ['transactions.read', 'projects.read'] }));
    shell();
    await screen.findByText('Transactions');
    expect(screen.queryByRole('link', { name: 'Team' })).toBeNull();
  });

  it('the switcher appears only with two clients and switching calls active-client', async () => {
    server(clientMe([ACME]));
    shell();
    await screen.findByText('Transactions');
    expect(screen.queryByLabelText('Client')).toBeNull();
    cleanup();

    const posts = server(clientMe([ACME, BETA]));
    shell();
    const select = (await screen.findByLabelText('Client')) as HTMLSelectElement;
    expect(select.value).toBe('c1');
    fireEvent.change(select, { target: { value: 'c2' } });
    await waitFor(() => expect(posts).toEqual([{ path: '/auth/active-client', body: { client_id: 'c2' } }]));
  });

  it('a platform administrator gets the account link and no switcher', async () => {
    server({ ...clientMe(), kind: 'platform', active_client: null, clients: [], permissions: ['reference.read'] });
    shell();
    await screen.findByText('Configuration');
    expect(screen.getByRole('link', { name: 'Account' })).toBeTruthy();
    expect(screen.queryByLabelText('Client')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Team' })).toBeNull();
  });
});
