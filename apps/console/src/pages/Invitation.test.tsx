// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../lib/session';
import { InvitationPage } from './Invitation';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const server = (invitation: { status: number; body: unknown }) => {
  const posts: { path: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace(/^\/console/, '');
    if (path === '/auth/me') return new Response('{"error":{"code":"UNAUTHENTICATED","message":"x"}}', { status: 401 });
    if ((init.method ?? 'GET') === 'POST') { posts.push({ path, body: JSON.parse(String(init.body)) }); return new Response('{"ok":true}', { status: 200 }); }
    return new Response(JSON.stringify(invitation.body), { status: invitation.status });
  }));
  return posts;
};
const page = () => render(
  <SessionProvider><MemoryRouter initialEntries={['/invitation/tok123']}><Routes>
    <Route path="/invitation/:token" element={<InvitationPage />} />
    <Route path="/sign-in" element={<p>sign-in page</p>} />
  </Routes></MemoryRouter></SessionProvider>,
);

describe('the invitation page', () => {
  it('the invitation page sets a password then sends to sign-in', async () => {
    const posts = server({ status: 200, body: { client_name: 'Acme', sets_password: true } });
    page();
    expect(await screen.findByRole('heading', { name: 'Set your password' })).toBeTruthy();
    expect(screen.getByText(/Acme/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long enough passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set your password' }));
    expect(await screen.findByText('sign-in page')).toBeTruthy();
    expect(posts).toEqual([{ path: '/invitations/tok123', body: { password: 'a long enough passphrase' } }]);
  });

  it('asks for no password from someone who already has an account', async () => {
    const posts = server({ status: 200, body: { client_name: 'Acme', sets_password: false } });
    page();
    expect(await screen.findByRole('heading', { name: 'Join Acme' })).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Join Acme' }));
    expect(await screen.findByText('sign-in page')).toBeTruthy();
    expect(posts).toEqual([{ path: '/invitations/tok123', body: {} }]);
  });

  it('an invalid link shows the neutral message', async () => {
    server({ status: 422, body: { error: { code: 'FIELD_INVALID', message: 'This invitation link is no longer valid. Ask for a new one.' } } });
    page();
    expect(await screen.findByText('This invitation link is no longer valid. Ask for a new one.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Join|Set your password/ })).toBeNull();
  });
});
