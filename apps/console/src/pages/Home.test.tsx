import { renderToStaticMarkup as html } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { HomeCards } from '../lib/home';
import { HomeView } from './Home';

const loadedAt = new Date('2026-11-03T10:00:00Z');
const view = (cards: HomeCards) => html(<MemoryRouter><HomeView cards={cards} loadedAt={loadedAt} /></MemoryRouter>);

const full: HomeCards = {
  verdict: { problems: [] },
  success_rate: { current: 0.97, baseline: 0.98, sample: 120 },
  collected_today: [{ currency: 'XAF', today: 500000, last_week: 400000 }],
  undetermined: 0,
  lowest_float: null,
  routes: { scoped: false, series: [] },
  awaiting_your_approval: [{ id: 'a1', type: 'cashout', summary: 'Cashout to bank', amount: 1000, currency: 'XAF', initiator: 'Awa', created_at: '2026-11-03T08:00:00Z' }],
  assigned_discrepancies: [{ id: 'd1', type: 'amount_mismatch', subject_reference: 'TX-1', difference: 500, currency_code: 'XAF' }],
  earnings: { period: '2026-11', scoped: false, rows: [{ currency: 'XAF', platform_revenue: 218000, margin: 104000 }, { currency: 'XOF', platform_revenue: 90000, margin: -5000 }] },
};

describe('the home', () => {
  it('lays the blocks out in order: verdict, headline, chart beside waiting on you, business line', () => {
    const out = view(full);
    const at = (s: string) => out.indexOf(s);
    const order = [at('class="verdict '), at('class="headline"'), at('route-chart'), at('card waiting'), at('business-line')];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain('Cashout to bank');
    expect(out).toContain('TX-1');
  });

  it('says beside each figure, the chart and the business line when the scope limits them', () => {
    const none = view(full);
    expect(none).not.toContain('Limited to your scope');
    const out = view({ ...full, routes: { scoped: true, series: [] }, lowest_float: { scoped: true, id: 'f1', provider: 'MTN', country: 'CM', currency: 'XAF', direction: 'disbursement', cover_hours: 4, band: 'critical', proposed_transfer: null }, earnings: { ...full.earnings!, scoped: true } });
    // three project-scoped figures, the lowest float, the chart card, the business line
    expect(out.match(/Limited to your scope/g)).toHaveLength(6);
    expect(out).toContain('Disbursement');
  });

  it('shows a dash when nothing was collected today', () => {
    const out = view({ ...full, collected_today: [] });
    expect(out).toContain('Collected today</span><span class="headline-value">—</span>');
  });

  it('renders only waiting on you when nothing else is sent, and never claims all is well', () => {
    const out = view({ awaiting_your_approval: full.awaiting_your_approval });
    expect(out).toContain('Cashout to bank');
    for (const absent of ['class="verdict', 'class="headline"', 'route-chart', 'business-line', 'Everything is running normally']) expect(out).not.toContain(absent);
  });

  it('shows revenue and margin as two figures per currency, a negative margin in the refused colour', () => {
    const out = view(full);
    expect(out.match(/class="business-row/g)).toHaveLength(2);
    expect(out).toContain('Platform revenue');
    expect(out).toContain('Margin');
    expect(out.match(/class="business-margin negative"/g)).toHaveLength(1);
  });
});
