// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../lib/session';
import { Roles } from './Oversight';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const ME = { administrator: { id: 'a1', name: 'Val', email: 'v@proxiapay.test', language: 'en', timezone: 'UTC' }, kind: 'platform', account_kind: 'platform', clients: [], pending_clients: [], second_factor_complete: true, environment: 'sandbox', permission_catalogue: {}, permissions: ['admin.roles'] };
const ROLES = {
  roles: [
    { id: 'r1', name: 'Platform ops', kind: 'platform', description: '', seeded: false, permissions: ['admin.roles'], administrators: [] },
    { id: 'r2', name: 'Client owner', kind: 'client', description: '', seeded: true, permissions: ['links.manage'], administrators: [] },
  ],
  permissions: { 'admin.roles': 'Edit roles', 'links.manage': 'Manage links', 'client.members': 'Manage the team', 'projects.create_own': 'Create own projects' },
  client_only_permissions: ['links.manage', 'client.members', 'projects.create_own'],
};

const open = async (name?: string) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/console/auth/me' ? ME : ROLES), { status: 200 })));
  render(<SessionProvider><MemoryRouter><Roles /></MemoryRouter></SessionProvider>);
  if (!name) return fireEvent.click(await screen.findByRole('button', { name: 'New role' }));
  const row = (await screen.findByText(name)).closest('tr')!;
  fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
};

describe('the role editor', () => {
  it('does not offer client-only permissions on a new role', async () => {
    await open();
    expect(await screen.findByText('Edit roles')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    for (const k of ROLES.client_only_permissions) expect(screen.queryByText(k)).toBeNull();
  });

  it('does not offer them when editing a platform role', async () => {
    await open('Platform ops');
    expect(await screen.findByText('Edit roles')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });
});
