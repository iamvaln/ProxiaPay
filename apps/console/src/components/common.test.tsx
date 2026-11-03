import { renderToStaticMarkup as html } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Amount, Pill, Tag } from './common';
import { Lockup } from './Logo';

// Rendered outside a SessionProvider, the session's defaults apply: no administrator, English.
describe('a state badge', () => {
  it('shows the family colour, its symbol hidden from screen readers, and the word', () => {
    expect(html(<Pill value="failed" />)).toContain('class="tag refused"');
    expect(html(<Pill value="failed" />)).toMatch(/<span[^>]*aria-hidden="true"[^>]*>✕<\/span>failed/);
    expect(html(<Pill value="action_required" />)).toMatch(/◷<\/span>action required/);
  });

  it('gives a value that is not a state a plain tag, with no symbol', () => {
    expect(html(<Pill value="secondary" />)).toBe('<span class="tag">secondary</span>');
  });

  it('shows a muted dash when there is no value', () => {
    expect(html(<Pill value={null} />)).toBe('<span class="muted">—</span>');
  });

  it('can be set by family directly, keeping its title', () => {
    expect(html(<Tag family="checking" title="from a proposal">indicative</Tag>)).toMatch(/class="tag checking" title="from a proposal"><span[^>]*>!<\/span>indicative/);
  });
});

describe('an amount', () => {
  it('sets the figure and the currency apart', () => {
    expect(html(<Amount minor={125000} currency="XAF" />)).toMatch(/class="amount"><span class="amount-figure">125,000<\/span> <span class="amount-currency">XAF<\/span>/);
  });

  it('marks a negative amount', () => {
    expect(html(<Amount minor={-50400} currency="XAF" />)).toContain('class="amount negative"');
  });

  it('shows a dash for a missing amount', () => {
    expect(html(<Amount minor={null} currency="XAF" />)).toBe('<span class="amount"><span class="amount-figure">—</span></span>');
  });
});

describe('the lockup', () => {
  it('is one image named ProxiaPay, the mark on its pixel-snapped grid', () => {
    const out = html(<Lockup size={22} />);
    expect(out).toMatch(/role="img" aria-label="ProxiaPay"/);
    expect(out).toContain('y="12.5"');
    expect(out).toContain('y="22.5"');
  });
});
