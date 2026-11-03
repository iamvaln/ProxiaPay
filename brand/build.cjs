// Generates ProxiaPay's logo files from the mark's geometry and Manrope, then copies the
// favicons each app serves. Its two tools are kept out of the lockfile, so run it as:
//
//   T=$(mktemp -d) && npm install --prefix "$T" --no-save opentype.js@1.3.4 @resvg/resvg-js@2.6.2
//   NODE_PATH="$T/node_modules" node brand/build.cjs
//
// Every output is committed; nothing at build or run time depends on this script.
const { copyFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const opentype = require('opentype.js');
const { Resvg } = require('@resvg/resvg-js');

const root = join(__dirname, '..');
const out = (name) => join(__dirname, name);
const INK = '#0B0D12';
const WHITE = '#FFFFFF';

// The mark, on its 40-unit grid: a disc and two level bars — the books always balance.
const mark = (disc, bars) =>
  `<circle cx="20" cy="20" r="20" fill="${disc}"/>` +
  `<rect x="10" y="12.5" width="20" height="5" rx="1" fill="${bars}"/>` +
  `<rect x="10" y="22.5" width="20" height="5" rx="1" fill="${bars}"/>`;
const svg = (viewBox, body, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${label}">${body}</svg>\n`;

// The name as outlines, laid glyph by glyph so letter-spacing (−0.03 em) and kerning both apply.
// Cap height is half the disc (20 units), centred on it; the name starts a quarter-disc (10 units) after it.
const font = opentype.loadSync(join(root, 'node_modules/@fontsource/manrope/files/manrope-latin-700-normal.woff'));
const size = 20 / (font.tables.os2.sCapHeight / font.unitsPerEm);
const scale = size / font.unitsPerEm;
function name(x, baseline) {
  const glyphs = font.stringToGlyphs('ProxiaPay');
  const path = new opentype.Path();
  glyphs.forEach((g, i) => {
    path.extend(g.getPath(x, baseline, size));
    x += g.advanceWidth * scale - 0.03 * size;
    if (glyphs[i + 1]) x += font.getKerningValue(g, glyphs[i + 1]) * scale;
  });
  return path;
}
const text = name(50, 30);
const right = Math.ceil(text.getBoundingBox().x2);
const lockupBox = `-10 -10 ${right + 20} 60`; // clear space: a quarter of the disc on every side
const lockup = (disc, bars, ink) => mark(disc, bars) + `<path d="${text.toPathData(2)}" fill="${ink}"/>`;

const files = {
  'mark.svg': svg('0 0 40 40', mark(INK, WHITE), 'ProxiaPay'),
  'favicon.svg': svg('0 0 40 40', mark(INK, WHITE), 'ProxiaPay'),
  'logo.svg': svg(lockupBox, lockup(INK, WHITE, INK), 'ProxiaPay'),
  'logo-inverted.svg': svg(lockupBox, lockup(WHITE, INK, WHITE), 'ProxiaPay'),
};
for (const [file, body] of Object.entries(files)) writeFileSync(out(file), body);

const png = (source, width) => new Resvg(source, { fitTo: { mode: 'width', value: width } }).render().asPng();
writeFileSync(out('favicon-32.png'), png(files['favicon.svg'], 32));
// iOS rounds the corners itself and shows no transparency: a white square, the disc 140 px across.
writeFileSync(out('apple-touch-icon.png'), png(svg('0 0 180 180', `<rect width="180" height="180" fill="${WHITE}"/><g transform="translate(20 20) scale(3.5)">${mark(INK, WHITE)}</g>`, 'ProxiaPay'), 180));

for (const dir of ['apps/console/public', 'apps/api/assets/brand']) {
  mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png']) copyFileSync(out(file), join(root, dir, file));
}

// Not committed: the mark at browser-tab size, to look at after any change to the geometry.
if (process.env.PREVIEW_DIR) writeFileSync(join(process.env.PREVIEW_DIR, 'mark-16.png'), png(files['mark.svg'], 16));
