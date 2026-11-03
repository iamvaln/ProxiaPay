import { renderToStaticMarkup as html } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EnvChip, EnvRibbon, LanguageSwitch } from './Environment';

describe('the environment marker', () => {
  it('draws the hazard ribbon on the sandbox, hidden from screen readers since the chip names it', () => {
    expect(html(<EnvRibbon environment="sandbox" />)).toBe('<div class="env-ribbon sandbox" aria-hidden="true"></div>');
  });

  it('names the environment in a chip, in the interface language', () => {
    expect(html(<EnvChip environment="sandbox" />)).toBe('<span class="env-chip sandbox">SANDBOX</span>');
    expect(html(<EnvChip environment="production" />)).toBe('<span class="env-chip production">PRODUCTION</span>');
  });

  it('draws nothing while the environment is still unknown', () => {
    expect(html(<EnvRibbon environment={null} />)).toBe('');
    expect(html(<EnvChip environment={null} />)).toBe('');
  });
});

describe('the language switch', () => {
  it('offers both languages by their own names, marking the current one', () => {
    const out = html(<LanguageSwitch lang="fr" onChange={() => undefined} />);
    expect(out).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Français<\/button>/);
    expect(out).toMatch(/<button[^>]*aria-pressed="false"[^>]*>English<\/button>/);
  });
});
