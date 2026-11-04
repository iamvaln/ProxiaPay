import { renderToStaticMarkup as html } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { TransactionsPage } from './Transactions';

describe('the transaction search', () => {
  it('starts from the filters carried by the address', () => {
    const out = html(<MemoryRouter initialEntries={['/transactions?state=undetermined&country=CI']}><TransactionsPage /></MemoryRouter>);
    expect(out).toContain('<option value="undetermined" selected="">undetermined</option>');
    expect(out).toContain('value="CI"');
  });
});
