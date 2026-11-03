import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The logo's source of truth is brand/ at the repository root; each app serves copies of the files it needs.
const root = join(__dirname, '..', '..', '..', '..');
const bytes = (path: string) => readFileSync(join(root, path));
const read = (path: string) => bytes(path).toString('utf8');

describe('the brand files', () => {
  it('draws the mark on the agreed 40-unit grid', () => {
    const svg = read('brand/mark.svg');
    expect(svg).toContain('viewBox="0 0 40 40"');
    expect(svg).toMatch(/<circle[^>]*cx="20"[^>]*cy="20"[^>]*r="20"/);
    expect(svg).toMatch(/<rect[^>]*x="10"[^>]*y="12\.5"[^>]*width="20"[^>]*height="5"/);
    expect(svg).toMatch(/<rect[^>]*x="10"[^>]*y="22\.5"[^>]*width="20"[^>]*height="5"/);
  });

  it('sets the name as outlines, so the lockups render without the font', () => {
    for (const f of ['brand/logo.svg', 'brand/logo-inverted.svg']) {
      expect(read(f)).not.toContain('<text');
      expect(read(f)).toContain('<path');
    }
  });

  it('keeps every app copy identical to its source in brand/', () => {
    for (const f of ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png']) {
      expect(bytes(`apps/console/public/${f}`).equals(bytes(`brand/${f}`))).toBe(true);
      expect(bytes(`apps/api/assets/brand/${f}`).equals(bytes(`brand/${f}`))).toBe(true);
    }
  });
});
