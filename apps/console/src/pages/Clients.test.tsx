// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../lib/session';
import { ClientDetail, Clients } from './Clients';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const ME = { administrator: { id: 'a1', name: 'Val', email: 'v@proxiapay.test', language: 'en', timezone: 'UTC' }, kind: 'platform', second_factor_complete: true, environment: 'sandbox', permission_catalogue: {}, permissions: ['admin.clients'] };

const server = (members: unknown[] = []) => {
  const calls: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^\/console/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const reads: Record<string, unknown> = {
      '/auth/me': ME, '/oversight/clients': { clients: [] },
      '/oversight/clients/c1': { id: 'c1', name: 'Acme', status: 'active', created_at: '2026-11-01T00:00:00Z', members, projects: [] },
    };
    const answer = method === 'GET' ? (reads[path] ?? {}) : path === '/auth/confirmations' ? { confirmation_id: 'cf1', expires_at: '' } : { status: 'invitation_sent' };
    return new Response(JSON.stringify(answer), { status: 200 });
  }));
  return calls;
};
const confirm = async (label: string) => {
  fireEvent.click(screen.getByRole('button', { name: label }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Confirmation code' }), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
};

describe('clients', () => {
  it('creates a client with trimmed values in both the confirmation request and the write', async () => {
    const calls = server();
    render(<SessionProvider><MemoryRouter><Clients /></MemoryRouter></SessionProvider>);
    fireEvent.change(await screen.findByLabelText('Client'), { target: { value: '  Acme  ' } });
    fireEvent.change(screen.getByLabelText('Owner name'), { target: { value: ' Awa ' } });
    fireEvent.change(screen.getByLabelText('Owner email'), { target: { value: ' awa@acme.test ' } });
    await confirm('Create client');
    const trimmed = { name: 'Acme', owner_name: 'Awa', owner_email: 'awa@acme.test', language: 'en' };
    await waitFor(() => expect(calls.find((c) => c.path === '/oversight/clients' && c.method === 'POST')).toBeTruthy());
    expect(calls.find((c) => c.path === '/auth/confirmations')?.body).toMatchObject({ operation_type: 'client.create', values: trimmed });
    expect(calls.find((c) => c.path === '/oversight/clients' && c.method === 'POST')?.body).toEqual({ ...trimmed, confirmation: { id: 'cf1', code: '123456' } });
  });

  it('invites another owner with trimmed values', async () => {
    const calls = server();
    render(<SessionProvider><MemoryRouter initialEntries={['/c/c1']}><Routes><Route path="/c/:id" element={<ClientDetail />} /></Routes></MemoryRouter></SessionProvider>);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: ' Ben ' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' ben@acme.test ' } });
    await confirm('Invite owner');
    const trimmed = { client_id: 'c1', name: 'Ben', email: 'ben@acme.test', language: 'en' };
    await waitFor(() => expect(calls.find((c) => c.path === '/oversight/clients/c1/owners')).toBeTruthy());
    expect(calls.find((c) => c.path === '/auth/confirmations')?.body).toMatchObject({ values: trimmed });
    expect(calls.find((c) => c.path === '/oversight/clients/c1/owners')?.body).toEqual({ ...trimmed, confirmation: { id: 'cf1', code: '123456' } });
  });

  it('re-enables a disabled account from the client page', async () => {
    const calls = server([{ membership_id: 'm1', administrator_id: 'u1', name: 'Ama', email: 'ama@acme.test', profile: 'developer', project_ids: [], status: 'active', disabled_by_client: false, invitation: 'accepted', account_status: 'disabled' }]);
    render(<SessionProvider><MemoryRouter initialEntries={['/c/c1']}><Routes><Route path="/c/:id" element={<ClientDetail />} /></Routes></MemoryRouter></SessionProvider>);
    await screen.findByText('Ama');
    expect(screen.queryByRole('button', { name: 'Disable account' })).toBeNull();
    await confirm('Enable account');
    await waitFor(() => expect(calls.find((c) => c.path === '/oversight/clients/c1/accounts/u1/enable')).toBeTruthy());
    expect(calls.find((c) => c.path === '/auth/confirmations')?.body).toMatchObject({ operation_type: 'administrator.enable', values: { administrator_id: 'u1' } });
  });
});
