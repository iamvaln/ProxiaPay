// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmedAction } from './common';

// Rendered outside a SessionProvider: no administrator, English.
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** A fetch that answers every call in turn, recording what it was asked. */
const answers = (...bodies: { status?: number; body: unknown }[]) => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const a = bodies.shift() ?? { body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }));
  return calls;
};

const confirmWithCode = async (label: string) => {
  fireEvent.click(screen.getByRole('button', { name: label }));
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
};

describe('ConfirmedAction', () => {
  it('ConfirmedAction sends DELETE when asked', async () => {
    const calls = answers({ body: { confirmation_id: 'c1', expires_at: '' } }, { body: { status: 'deleted' } });
    render(<ConfirmedAction operationType="credential.delete" values={{ credential_id: 'k1' }} path="/projects/p1/credentials/k1" method="DELETE" label="Delete" />);
    await confirmWithCode('Delete');
    await screen.findByRole('status');
    expect(calls[1]).toMatchObject({ url: '/console/projects/p1/credentials/k1', method: 'DELETE', body: { credential_id: 'k1', confirmation: { id: 'c1', code: '123456' } } });
  });

  it('ConfirmedAction sends PATCH when asked', async () => {
    const calls = answers({ body: { confirmation_id: 'c2', expires_at: '' } }, { body: {} });
    render(<ConfirmedAction operationType="administrator.amend" values={{ id: 'a1', status: 'disabled' }} path="/oversight/administrators/a1" method="PATCH" label="Disable" />);
    await confirmWithCode('Disable');
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ url: '/console/oversight/administrators/a1', method: 'PATCH' });
  });

  it('still POSTs by default', async () => {
    const calls = answers({ body: { confirmation_id: 'c3', expires_at: '' } }, { body: {} });
    render(<ConfirmedAction operationType="credential.promote" values={{ credential_id: 'k1' }} path="/projects/p1/credentials/k1/promote" label="Promote" />);
    await confirmWithCode('Promote');
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.method).toBe('POST');
  });
});
