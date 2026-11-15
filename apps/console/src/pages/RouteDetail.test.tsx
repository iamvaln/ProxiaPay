// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../lib/session';
import { RouteDetailPage } from './RouteDetail';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const ROUTE = {
  route: { id: 'r1', country_code: 'CM', payment_method_code: 'MOMO', direction: 'collection', currency_code: 'XAF', payer_instructions: { en: 'Approve with your PIN.', fr: 'Validez avec votre code.' } },
  current: { sequence: 1, active: true, processing_fee_bps: 100, processing_fee_fixed: 0, platform_fee_bps: 50, platform_fee_fixed: 0, processing_fee_bearer: 'counterparty', platform_fee_bearer: 'project', minimum_amount: 100, maximum_amount: 1000000, otp_required: false, browser_required: false, disbursement_fallback: false, valid_from: '2026-11-01T00:00:00Z', bindings: [], note: 'seed', fingerprint: 'f' },
  versions: [], projects_with_overrides: [], projects: [],
};
const serve = (permissions: string[]) => {
  const calls: { method: string; path: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace(/^\/console/, '');
    calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const me = { administrator: { id: 'a1', name: 'V', email: 'v@x.test', language: 'en', timezone: 'UTC' }, second_factor_complete: true, environment: 'production', permission_catalogue: {}, permissions };
    return new Response(JSON.stringify(path === '/auth/me' ? me : path === '/configuration/routes/r1' ? ROUTE : {}), { status: 200 });
  }));
  return calls;
};
const page = () => render(<SessionProvider><MemoryRouter initialEntries={['/configuration/routes/r1']}><Routes><Route path="/configuration/routes/:id" element={<RouteDetailPage />} /></Routes></MemoryRouter></SessionProvider>);

describe('the payer instructions of a route', () => {
  it('are edited in both languages and saved without opening a version', async () => {
    const calls = serve(['routes.read', 'routes.open_version']);
    page();
    const en = await screen.findByLabelText(/^English/);
    expect((en as HTMLTextAreaElement).value).toBe('Approve with your PIN.');
    fireEvent.change(en, { target: { value: 'Dial *126# to approve.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the instructions' }));
    expect(await screen.findByText(/Instructions saved/)).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/configuration/routes/r1/payer-instructions');
    expect(put.body).toEqual({ en: 'Dial *126# to approve.', fr: 'Validez avec votre code.' });
    expect(calls.some((c) => c.path.endsWith('/versions'))).toBe(false);
  });

  it('are not offered without routes.open_version', async () => {
    serve(['routes.read']);
    page();
    expect(await screen.findByText(/Current version #1/)).toBeTruthy();
    expect(screen.queryByLabelText(/^English/)).toBeNull();
  });
});
