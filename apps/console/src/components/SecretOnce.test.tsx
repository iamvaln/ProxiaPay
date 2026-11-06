// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretOnce } from './SecretOnce';

const writeText = vi.fn(async (_: string) => undefined);
beforeEach(() => { writeText.mockClear(); Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const items = [{ label: 'Key', value: 'pk_live_abc' }, { label: 'Secret', value: 'sk_live_xyz' }];

describe('a secret shown once', () => {
  it('shows each value with its label, and warns it is shown once', () => {
    render(<SecretOnce items={items} onDismiss={() => undefined} />);
    expect(screen.getByText('pk_live_abc')).toBeTruthy();
    expect(screen.getByText('sk_live_xyz')).toBeTruthy();
    expect(screen.getByText('Key')).toBeTruthy();
    expect(screen.getByText(/shown once/i)).toBeTruthy();
  });

  it('copy writes the value to the clipboard', async () => {
    vi.useFakeTimers();
    render(<SecretOnce items={items} onDismiss={() => undefined} />);
    const [, copySecret] = screen.getAllByRole('button', { name: 'Copy' });
    await act(async () => { fireEvent.click(copySecret!); });
    expect(writeText).toHaveBeenCalledWith('sk_live_xyz');
    expect(screen.getAllByRole('button', { name: 'Copied' })).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
  });

  it('stays until the administrator says it is copied', () => {
    const onDismiss = vi.fn();
    render(<SecretOnce items={items} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'I’ve copied it' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
