# ProxiaPay brand files

The mark is a black disc holding a white equals sign, its two bars level: the
books always balance. The full identity (colours, type, states, the
environment marker) is in
`docs/superpowers/specs/2026-11-02-proxiapay-visual-identity-design.md`.

| File | Use |
|---|---|
| `logo.svg` | The lockup, mark and name, on light backgrounds |
| `logo-inverted.svg` | The same lockup on black or dark backgrounds |
| `mark.svg` | The disc alone: avatars, social profiles, anywhere the name already appears |
| `favicon.svg`, `favicon-32.png` | Browser tabs |
| `apple-touch-icon.png` | Home-screen icon, 180 px on white |

## Rules

- **Clear space:** at least a quarter of the disc's diameter on every side,
  already included in the lockups' viewBox.
- **Never redraw the name in another typeface.** It is Manrope Bold, converted
  to outlines.
- **Colour:** black and white only. The inverted lockup is the only variant.

## Changing them

Edit `build.cjs`, never the outputs, then regenerate:

```sh
T=$(mktemp -d) && npm install --prefix "$T" --no-save opentype.js@1.3.4 @resvg/resvg-js@2.6.2
NODE_PATH="$T/node_modules" node brand/build.cjs
```

The script also copies the favicons into `apps/console/public/` and
`apps/api/assets/brand/`. A test (`apps/api/src/docs/brand.test.ts`) fails if
those copies drift from the files here.

The bars sit at y = 12.5 and 22.5 on the 40-unit grid. That puts both of their
edges on whole pixels at 16 and 32 px, so the favicon stays sharp. Moving them
blurs the bars together at browser-tab size. To check, run the script with
`PREVIEW_DIR=<dir>`, then look at `<dir>/mark-16.png`.
