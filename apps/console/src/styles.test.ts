import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The identity's colours live as custom properties in styles.css; every pair text is set in must reach WCAG AA.
const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');
const value = (name: string): string => {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`--${name} is not defined as a six-digit hex colour`);
  return m[1]!;
};
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(value(a)), luminance(value(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('the console palette', () => {
  it('defines the brand values', () => {
    expect([value('ink'), value('ink-2'), value('muted'), value('line'), value('soft'), value('surface')].map((v) => v.toUpperCase())).toEqual(['#0B0D12', '#454B59', '#5B6170', '#ECEEF2', '#F6F7F9', '#FFFFFF']);
  });

  const pairs: [string, string][] = [
    ['ink', 'surface'], ['ink-2', 'surface'], ['muted', 'surface'], ['muted', 'soft'],
    ['state-confirmed-text', 'state-confirmed-bg'], ['state-refused-text', 'state-refused-bg'], ['state-pending-text', 'state-pending-bg'],
    ['state-checking-text', 'state-checking-bg'], ['state-information-text', 'state-information-bg'], ['state-refused-text', 'surface'],
    ['ink', 'hazard'], ['surface', 'ink'],
  ];
  for (const [text, ground] of pairs) {
    it(`sets ${text} on ${ground} at 4.5:1 or better`, () => {
      expect(contrast(text, ground)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('what the components rely on', () => {
  it('defines every custom property a component uses, so no style silently vanishes', () => {
    const files = readdirSync(__dirname, { recursive: true }).map(String).filter((f) => f.endsWith('.tsx'));
    const used = new Set(files.flatMap((f) => [...readFileSync(join(__dirname, f), 'utf8').matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]!)));
    const missing = [...used].filter((name) => !new RegExp(`--${name}:`).test(css));
    expect(missing).toEqual([]);
  });

  it('keeps the environment chip in view on long pages: the sidebar stays put', () => {
    expect(css).toMatch(/nav\.side \{[^}]*position: sticky/);
  });

  it('sets placeholder text in the muted ink, not the browser default grey', () => {
    expect(css).toMatch(/::placeholder \{[^}]*color: var\(--muted\)/);
  });
});

describe('the brand colour is black', () => {
  // Wherever a coloured theme would put its accent, ProxiaPay puts ink.
  it('fills the active navigation item in ink', () => {
    expect(css).toMatch(/nav\.side a\.active \{[^}]*background: var\(--ink\)[^}]*\}/);
    expect(css).toMatch(/nav\.side a\.active \{[^}]*color: var\(--surface\)/);
  });

  it('gives checkboxes, radios and date pickers the ink accent instead of the browser blue', () => {
    expect(css).toMatch(/:root \{[^}]*accent-color: var\(--ink\)/);
  });

  it('highlights selected text in ink', () => {
    expect(css).toMatch(/::selection \{[^}]*background: var\(--ink\)[^}]*color: var\(--surface\)/);
  });
});

describe('the sign-in card', () => {
  it('takes its full 400 px rather than shrinking to its content inside the centred page', () => {
    expect(css).toMatch(/\.signin \{[^}]*width: 100%[^}]*max-width: 400px/);
  });
});
