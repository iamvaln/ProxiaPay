// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../lib/session';
import { ProjectsPage } from './Projects';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const ME = { administrator: { id: 'a1', name: 'Valentine', email: 'v@proxiapay.test', language: 'en', timezone: 'UTC' }, second_factor_complete: true, environment: 'production', permission_catalogue: {}, permissions: ['projects.manage'] };

const server = () => {
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace(/^\/console/, '');
    if ((init.method ?? 'GET') === 'POST') { posts.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: 'p9', code: 'monjeton', name: 'MonJeton', status: 'active' }), { status: 201 }); }
    return new Response(JSON.stringify(path === '/auth/me' ? ME : { projects: [], scoped: false }), { status: 200 });
  }));
  return posts;
};
const page = () => render(<SessionProvider><MemoryRouter><ProjectsPage /></MemoryRouter></SessionProvider>);

describe('a new project', () => {
  it('the code field lowercases what is typed', async () => {
    server();
    page();
    const code = (await screen.findByLabelText('Code')) as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'MonJeton-CM' } });
    expect(code.value).toBe('monjeton-cm');
    expect(screen.getByText('Lowercase letters, digits and hyphens, 2 to 32 characters.')).toBeTruthy();
  });

  it('is created once, and says so', async () => {
    const posts = server();
    page();
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: 'MonJeton' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'MonJeton' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect((await screen.findByRole('status')).textContent).toBe('✓ Project monjeton created.');
    expect(posts).toEqual([{ code: 'monjeton', name: 'MonJeton' }]);
  });
});
