// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../lib/session';
import { ProjectDetailPage } from './ProjectDetail';
import { TransactionDetailPage } from './TransactionDetail';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const ME = {
  administrator: { id: 'a1', name: 'Awa', email: 'awa@acme.test', language: 'en', timezone: 'UTC' }, kind: 'client', active_client: { id: 'c1', name: 'Acme' }, clients: [{ id: 'c1', name: 'Acme' }], pending_clients: [],
  second_factor_complete: true, environment: 'production', permission_catalogue: {}, permissions: ['projects.read', 'transactions.read', 'projects.credentials'],
};
const ROUTE = {
  country: 'CM', payment_method: 'MTN_MOMO', payment_method_name: 'MTN MoMo', direction: 'collection', currency: 'XAF', active: true,
  fees: { processing_bps: 250, processing_fixed: 0, processing_bearer: 'counterparty', platform_bps: 50, platform_fixed: 0, platform_bearer: 'project' },
  limits: { minimum_amount: 100, maximum_amount: 500000, count_24h: 1000, value_24h: 100000000, count_30d: 1000, value_30d: 100000000 },
};
const project = (routes: unknown[], waiting: boolean) => ({
  project: { id: 'p1', code: 'monjeton', name: 'MonJeton', status: 'active', created_at: '2026-11-01T10:00:00Z' },
  credentials: [], origins: [], notification_endpoint: null, routes, balances: [{ currency: 'XAF', available: 1000, reserved: 0 }], waiting_for_routes: waiting,
});
const TXN = {
  reference: 'TX1', project_reference: 'ord-1', project: { id: 'p1', code: 'monjeton', name: 'MonJeton' }, direction: 'collection', state: 'succeeded', created_at: '2026-11-01T10:00:00Z', terminal_at: null,
  country: 'CM', payment_method: 'MTN_MOMO', payment_method_name: 'MTN MoMo', currency: 'XAF', requested_amount: 10000, charged_amount: 10250, processing_fee: 250, platform_fee: 50,
  processing_fee_bearer: 'counterparty', platform_fee_bearer: 'project', msisdn_masked: '2376****12', failure_reason: null,
  attempts: [{ started_at: '2026-11-01T10:00:00Z', ended_at: null, state: 'succeeded', failure_reason: null, operator_reference: 'OP-77' }],
  notifications: [{ event_type: 'transaction.succeeded', status: 'delivered', attempts: 1, last_attempt_at: null }],
};

const server = (reads: Record<string, unknown>) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const path = url.replace(/^\/console/, '').split('?')[0]!;
  return new Response(JSON.stringify(path === '/auth/me' ? ME : (reads[path] ?? { data: [], total: 0, page: 1, page_size: 25 })), { status: 200 });
}));
const at = (url: string) => render(
  <SessionProvider><MemoryRouter initialEntries={[url]}><Routes>
    <Route path="/projects/:id" element={<ProjectDetailPage />} /><Route path="/transactions/:reference" element={<TransactionDetailPage />} />
  </Routes></MemoryRouter></SessionProvider>,
);

describe('a client on the project page', () => {
  it('a client sees routes read-only and the waiting message when it has none', async () => {
    server({ '/projects/p1': project([ROUTE], false) });
    at('/projects/p1?tab=routes');
    expect(await screen.findByText('CM · MTN MoMo · collection · XAF')).toBeTruthy();
    expect(screen.getByText(/2\.5%/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /deactivate/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Grant a route' })).toBeNull();
    cleanup();
    server({ '/projects/p1': project([], true) });
    at('/projects/p1?tab=routes');
    expect(await screen.findByText('Waiting for ProxiaPay to open your routes.')).toBeTruthy();
  });

  it('a client sees no activity tab', async () => {
    server({ '/projects/p1': project([], true) });
    at('/projects/p1');
    await screen.findByText('monjeton');
    expect(screen.queryByRole('link', { name: 'activity' })).toBeNull();
    expect(screen.getByRole('link', { name: 'routes' })).toBeTruthy();
  });

  it('a client sees no link to a route page', async () => {
    server({ '/projects/p1': project([ROUTE], false), '/transactions/TX1': TXN });
    at('/projects/p1?tab=routes');
    await screen.findByText('CM · MTN MoMo · collection · XAF');
    expect(document.querySelector('a[href*="/configuration"]')).toBeNull();
    cleanup();
    at('/transactions/TX1');
    await screen.findByText('TX1');
    expect(document.querySelector('a[href*="/configuration"]')).toBeNull();
  });
});

describe('a client on the transaction page', () => {
  it('a client transaction detail shows fees and no provider or margin', async () => {
    server({ '/transactions/TX1': TXN });
    at('/transactions/TX1');
    expect(await screen.findByText('2376****12')).toBeTruthy();
    expect(screen.getByText('OP-77')).toBeTruthy();
    expect(screen.getByText('transaction.succeeded')).toBeTruthy();
    expect(screen.getByText(/borne by project/)).toBeTruthy();
    for (const gone of [/margin/i, /provider/i, /ledger/i, /Configuration in force/i]) expect(screen.queryByText(gone)).toBeNull();
  });
});
