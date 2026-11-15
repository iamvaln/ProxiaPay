// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../lib/session';
import { TeamPage } from './Team';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const ME = { administrator: { id: 'a1', name: 'Awa', email: 'awa@acme.test', language: 'en', timezone: 'UTC' }, kind: 'client', active_client: { id: 'c1', name: 'Acme' }, clients: [], pending_clients: [], second_factor_complete: true, environment: 'sandbox', permission_catalogue: {}, permissions: ['client.members', 'projects.read'] };
const MEMBERS = [
  { membership_id: 'm1', name: 'Awa Owner', email: 'awa@acme.test', profile: 'owner', project_ids: [], status: 'active', invitation: 'accepted' },
  { membership_id: 'm2', name: 'Dev Dina', email: 'dina@acme.test', profile: 'developer', project_ids: ['p1'], status: 'active', invitation: 'accepted' },
  { membership_id: 'm3', name: 'Fin Fred', email: 'fred@acme.test', profile: 'finance', project_ids: [], status: 'invited', invitation: 'pending' },
];
const PROJECTS = { projects: [{ id: 'p1', name: 'Shop', code: 'shop' }, { id: 'p2', name: 'Pay', code: 'pay' }], scoped: false };

const server = (invite: () => Response = () => new Response('{"status":"invitation_sent"}', { status: 201 })) => {
  const writes: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^\/console/, '');
    if (method !== 'GET') { writes.push({ method, path, body: JSON.parse(String(init.body)) }); return path === '/team' ? invite() : new Response('{}', { status: 200 }); }
    const reads: Record<string, unknown> = { '/auth/me': ME, '/team': { members: MEMBERS }, '/projects': PROJECTS };
    return new Response(JSON.stringify(reads[path] ?? {}), { status: 200 });
  }));
  return writes;
};
const page = () => render(<SessionProvider><MemoryRouter><TeamPage /></MemoryRouter></SessionProvider>);
const fill = async (name: string, email: string) => {
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
};

describe('the team page', () => {
  it('invites with the chosen profile and projects', async () => {
    const writes = server();
    page();
    await fill('New Nora', 'nora@acme.test');
    fireEvent.click(screen.getByLabelText('Finance'));
    fireEvent.click(await screen.findByLabelText('Shop'));
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByText(/Invitation sent\./);
    expect(writes[0]).toEqual({ method: 'POST', path: '/team', body: { name: 'New Nora', email: 'nora@acme.test', profile: 'finance', project_ids: ['p1'] } });
  });

  it('shows the same confirmation whether or not the address existed', async () => {
    // The two answers differ in their text: what is read on screen must not depend on it.
    server(() => new Response('{"status":"invitation_sent","note":"known address"}', { status: 201 }));
    page();
    await fill('A', 'known@acme.test');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    const first = (await screen.findByRole('status')).textContent;
    cleanup();
    server(() => new Response('{"status":"something_else","note":"new address"}', { status: 201 }));
    page();
    await fill('B', 'fresh@acme.test');
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect((await screen.findByRole('status')).textContent).toBe(first);
    expect(first).toBe('✓ Invitation sent.');
  });

  it('does not offer the owner\'s row for editing', async () => {
    server();
    page();
    const owner = (await screen.findByText('Awa Owner')).closest('tr')!;
    expect(within(owner).queryByRole('button')).toBeNull();
    const dina = screen.getByText('Dev Dina').closest('tr')!;
    expect(within(dina).getByRole('button', { name: 'Change access' })).toBeTruthy();
    expect(within(dina).getByRole('button', { name: 'Disable' })).toBeTruthy();
  });

  it('changes a member\'s access and resends a pending invitation', async () => {
    const writes = server();
    page();
    const dina = (await screen.findByText('Dev Dina')).closest('tr')!;
    fireEvent.click(within(dina).getByRole('button', { name: 'Change access' }));
    const form = await screen.findByRole('region', { name: 'Change access' });
    fireEvent.click(within(form).getByLabelText('Finance'));
    fireEvent.click(within(form).getByLabelText('Pay'));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes.find((w) => w.method === 'PUT')).toEqual({ method: 'PUT', path: '/team/m2', body: { profile: 'finance', project_ids: ['p1', 'p2'] } }));
    const fred = screen.getByText('Fin Fred').closest('tr')!;
    fireEvent.click(within(fred).getByRole('button', { name: 'Resend invitation' }));
    await waitFor(() => expect(writes.some((w) => w.path === '/team/m3/resend')).toBe(true));
  });
});
