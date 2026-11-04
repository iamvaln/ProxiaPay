import { renderToStaticMarkup as html } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const setParams = vi.fn();
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useSearchParams: () => [new URLSearchParams('page=9'), setParams] }));
const { useTableState } = await import('./table-state');

describe('table navigation', () => {
  it('replaces the history entry for the past-the-end correction and pushes for a user change', () => {
    let set!: ReturnType<typeof useTableState>[1];
    const Probe = () => { [, set] = useTableState('', { sort: 'name', order: 'asc', filterKeys: [] }); return null; };
    html(<MemoryRouter><Probe /></MemoryRouter>);
    set({ page: 2 }, { replace: true });
    expect(setParams.mock.calls[0]![1]).toEqual({ replace: true });
    set({ page: 3 });
    expect(setParams.mock.calls[1]![1]).toBeUndefined();
  });
});
