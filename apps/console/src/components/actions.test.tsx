// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { ConfirmedAction, SubmitForm } from './common';

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

describe('SubmitForm', () => {
  it('SubmitForm disables while busy and shows the success message', async () => {
    let finish!: (m: string) => void;
    const onSubmit = vi.fn(() => new Promise<string>((r) => { finish = r; }));
    render(<SubmitForm onSubmit={onSubmit} submitLabel="Grant"><input aria-label="Note" defaultValue="n" /></SubmitForm>);
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
    const busy = await screen.findByRole<HTMLButtonElement>('button', { name: 'Working…' });
    expect(busy.disabled).toBe(true);
    // A second submit while the first runs reaches nothing: Enter on the field, or a click on the button.
    fireEvent.submit(busy.closest('form')!);
    fireEvent.click(busy);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => finish('Route granted.'));
    expect(screen.getByRole('status').textContent).toBe('✓ Route granted.');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Grant' }).disabled).toBe(false);
  });

  it('says it is done when the action returns no message of its own', async () => {
    render(<SubmitForm onSubmit={async () => undefined} submitLabel="Add"><span /></SubmitForm>);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((await screen.findByRole('status')).textContent).toBe('✓ Done.');
  });

  it('shows the error in words and lets the administrator try again', async () => {
    const onSubmit = vi.fn(async () => { throw new ApiError(400, 'FIELD_INVALID', 'platform_fee_bps: Invalid input: expected int, received number', undefined, 'platform_fee_bps'); });
    render(<SubmitForm onSubmit={onSubmit} submitLabel="Grant"><span /></SubmitForm>);
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));
    expect(await screen.findByText('Platform fee override: a whole number of basis points (250 = 2.5 %).')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Grant' }).disabled).toBe(false);
  });
});

describe('ConfirmedAction errors', () => {
  it('are shown in words', async () => {
    answers({ body: { confirmation_id: 'c4', expires_at: '' } }, { status: 400, body: { error: { code: 'FIELD_INVALID', message: 'processing_fee_bps: Invalid input', field: 'processing_fee_bps' } } });
    render(<ConfirmedAction operationType="x" values={{}} path="/x" label="Go" />);
    await confirmWithCode('Go');
    expect(await screen.findByText('Processing fee override: a whole number of basis points (250 = 2.5 %).')).toBeTruthy();
  });
});
