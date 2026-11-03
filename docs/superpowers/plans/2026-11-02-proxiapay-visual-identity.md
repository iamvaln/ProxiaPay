# ProxiaPay Visual Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the console and the public documentation ProxiaPay's identity:

- black and white, with colour reserved for states;
- the equals-sign-in-a-disc mark;
- Manrope and IBM Plex Mono;
- a hazard ribbon on the sandbox.

**Architecture:**

- One `brand/` directory at the repository root holds the logo files and the
  script that generates them. Each app keeps byte-identical copies of the files
  it serves, and a test guards that they stay identical.
- The console takes the identity through named CSS values in `styles.css` and
  a handful of shared components: `Logo`, `Tag`/`Pill`, `Amount` and `Shell`.
- The docs page takes it through its own `:root` values and the Redoc theme.
- Fonts are self-hosted on both surfaces: bundled by Vite in the console, and
  served by `DocsController` on the docs page.

**Tech Stack:**

- React 19 and Vite 6 for the console;
- NestJS 11 for the API;
- Vitest 3;
- `@fontsource/manrope` and `@fontsource/ibm-plex-mono` 5.3.0, OFL-1.1;
- `opentype.js` 1.3.4 and `@resvg/resvg-js` 2.6.2, used only by the brand
  script and never added to the lockfile.

**Spec:** `docs/superpowers/specs/2026-11-02-proxiapay-visual-identity-design.md`

## Global Constraints

- Nothing loaded from a third-party host, neither fonts nor scripts, on either
  surface. No `fonts.googleapis.com`, no CDN.
- No change to routes, data, permissions, confirmation flows, i18n keys or
  wording. The one exception is the environment marker.
- Brand values:
  - `ink` `#0B0D12`
  - `ink-2` `#454B59`
  - `muted` `#5B6170`
  - `line` `#ECEEF2`
  - `soft` `#F6F7F9`
  - `white` `#FFFFFF`
- State families, as text / background:
  - confirmed `#0A6B40` / `#E3F6EC`, symbol ✓
  - refused `#A52A22` / `#FDECEB`, symbol ✕
  - pending `#454B59` / `#F1F2F5`, symbol ◷
  - checking `#7A5200` / `#FFF4DC`, symbol !
  - information `#454B59` / `#F1F2F5`, symbol i
  - plain tag: `line` outline, `ink-2` text, no symbol
- Sandbox hazard: `#F5B400` and `#0B0D12`. Only ever used as stripes or as
  the sandbox chip.
- Names are semantic (`--ink`, `--state-refused-text`), never literal
  (`--black`, `--red`).
- Shapes: radius 6 px for inputs and buttons, 10 px for cards, full round for
  chips. Cards have 1 px `line` borders and no shadows.
- Focus: a 2 px `ink` outline with 2 px offset on every interactive element.
- Contrast: WCAG AA, at least 4.5:1 for body text and 3:1 for text 18 px or
  larger.
- Size steps 12, 13, 14 (body), 16, 20, 28, 34 px, on a 4 px spacing base.
- Console: light only. Docs page: light and dark, following
  `prefers-color-scheme`. Redoc stays on a light surface in both.
- `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build -w apps/console` and `npm audit --omit=dev --audit-level=high`
  all pass. These are the CI steps.
- Commit messages carry no `Co-Authored-By` trailer and no "Generated with"
  line.

## Review Focus

These are the inputs most likely to bite once the identity ships, and the
tests that pin them:

1. **A state value the mapping doesn't know**, such as a new status the API
   adds later. It must render as a plain tag, never with a symbol that asserts
   a meaning. Pinned in Task 3: `stateFamily('brand_new_status') === 'tag'`.
2. **A null or missing value reaching `Pill`.** It renders the muted em dash,
   as today, not an empty chip. Pinned in Task 4, in the `Pill` test.
3. **Amounts in French, negative, null, or in a currency with decimals**
   (CDF, USD). The split figure and currency must still join back into
   exactly what `money()` prints today. Pinned in Task 3: the `moneyParts`
   tests.
4. **A font or brand file request with a path in it**
   (`/docs/fonts/..%2Fpackage.json`). It must be a 404, never a file read
   outside the allow-list. Pinned in Task 2.
5. **A brand file edited in one app but not regenerated.** The copies drift
   from `brand/`. Pinned in Task 1, with the byte-equality test.

---

### Task 1: Brand files

**Files:**
- Create: `brand/build.cjs`
- Create (generated): `brand/mark.svg`, `brand/logo.svg`,
  `brand/logo-inverted.svg`, `brand/favicon.svg`, `brand/favicon-32.png`,
  `brand/apple-touch-icon.png`
- Create (generated copies): `apps/console/public/favicon.svg`,
  `apps/console/public/favicon-32.png`,
  `apps/console/public/apple-touch-icon.png`,
  `apps/api/assets/brand/favicon.svg`, `apps/api/assets/brand/favicon-32.png`,
  `apps/api/assets/brand/apple-touch-icon.png`
- Create: `brand/README.md`. Short: what each file is for, the clear-space
  rule, and how to regenerate.
- Test: `apps/api/src/docs/brand.test.ts`

**Interfaces:**
- Produces: the files above. Task 2 serves `apps/api/assets/brand/*` at
  `/docs/brand/<file>`. Task 4 links `/favicon.svg`, `/favicon-32.png` and
  `/apple-touch-icon.png` from the console's `index.html`.

- [ ] **Step 1: Write the failing test** `apps/api/src/docs/brand.test.ts`.
  The repository root is `join(__dirname, '..', '..', '..', '..')`.

```ts
describe('the brand files', () => {
  it('draws the mark on the agreed 40-unit grid', () => {
    const svg = read('brand/mark.svg');
    expect(svg).toContain('viewBox="0 0 40 40"');
    expect(svg).toMatch(/<circle[^>]*cx="20"[^>]*cy="20"[^>]*r="20"/);
    expect(svg).toMatch(/<rect[^>]*x="10"[^>]*y="13"[^>]*width="20"[^>]*height="5"/);
    expect(svg).toMatch(/<rect[^>]*x="10"[^>]*y="22"[^>]*width="20"[^>]*height="5"/);
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
```

- [ ] **Step 2: Run it to make sure it fails**

  Run: `npx vitest run src/docs/brand.test.ts`, from `apps/api`.
  Expected: FAIL, with ENOENT on `brand/mark.svg`.

- [ ] **Step 3: Write `brand/build.cjs`.** It is CommonJS, so it resolves its
  two tools through `NODE_PATH` and they never enter the lockfile.

  - **Geometry:**
    - the mark is a disc (`cx=20 cy=20 r=20`, fill `#0B0D12`);
    - two bars, `x=10 width=20 height=5 rx=1`, at `y=13` and `y=22`, fill
      `#FFFFFF`;
    - inverted, the disc is white and the bars ink.
  - **Lockup:**
    - the mark, then "ProxiaPay" as a single `<path>`;
    - the path comes from opentype.js `font.getPath(...)` over
      `node_modules/@fontsource/manrope/files/manrope-latin-700-normal.woff`,
      with letter-spacing −0.03 em;
    - the name's cap height is half the disc's diameter (20 units);
    - the gap from disc to name is 10 units;
    - a 10-unit clear space on every side, inside the viewBox.
  - **`favicon.svg`:** the mark alone.
  - **`favicon-32.png`:** `mark.svg` rendered by resvg at 32 px, transparent
    background.
  - **`apple-touch-icon.png`:** 180 × 180 px, white square, the disc 140 px
    across and centred.
  - **Copies:** the script then copies the three favicon files into
    `apps/console/public/` and `apps/api/assets/brand/`.
  - **16 px check:** render the mark at 16 px, open it, and check that both
    bars are separate and sharp. If they aren't, adjust bar height and gap by
    at most one unit, and the test's numbers with them (spec: "the shape does
    not change").

- [ ] **Step 4: Generate**

```bash
T=$(mktemp -d) && npm install --prefix "$T" --no-save opentype.js@1.3.4 @resvg/resvg-js@2.6.2
npm install -w apps/api @fontsource/manrope@5.3.0 @fontsource/ibm-plex-mono@5.3.0   # Task 2 needs them too
NODE_PATH="$T/node_modules" node brand/build.cjs
```

- [ ] **Step 5: Run the test**

  Run: `npx vitest run src/docs/brand.test.ts`, from `apps/api`.
  Expected: PASS.

- [ ] **Step 6: Commit** `brand/`, the copies, `apps/api/package.json`,
  `package-lock.json` and the test.

  Message: "Draw ProxiaPay's mark and generate its files".

---

### Task 2: The documentation page

**Files:**
- Modify: `apps/api/src/docs/docs.module.ts`
- Modify: `apps/api/assets/docs.html`
- Test: `apps/api/src/docs/docs.test.ts`

**Interfaces:**
- Consumes: `apps/api/assets/brand/*` from Task 1;
  `@fontsource/manrope` and `@fontsource/ibm-plex-mono`, installed in Task 1.
- Produces:
  - `DocsController.font(file: string): StreamableFile`, at
    `GET fonts/:file`;
  - `DocsController.brand(file: string): StreamableFile`, at
    `GET brand/:file`.

  Both throw `NotFoundException` for any name outside their allow-list.

- [ ] **Step 1: Add failing tests** to `docs.test.ts`, under `/docs`.

```ts
it('serves its own fonts and brand files, and nothing outside the list', () => {
  expect(docs.font('manrope-latin-600-normal.woff2').getHeaders().type).toBe('font/woff2');
  expect(docs.brand('favicon.svg').getHeaders().type).toBe('image/svg+xml');
  expect(docs.brand('apple-touch-icon.png').getHeaders().type).toBe('image/png');
  for (const bad of ['../package.json', '..%2Fpackage.json', 'manrope-latin-900-normal.woff2', ''])
    expect(() => docs.font(bad)).toThrow(NotFoundException);
  expect(() => docs.brand('../docs.html')).toThrow(NotFoundException);
});
it('wears the identity: own fonts, the mark, the favicon, the sandbox ribbon', () => {
  const html = docs.guide();
  expect(html).toContain('/docs/fonts/manrope-latin-400-normal.woff2');
  expect(html).toContain('/docs/fonts/ibm-plex-mono-latin-400-normal.woff2');
  expect(html).toContain('href="/docs/brand/favicon.svg"');
  expect(html).toMatch(/<svg[^>]*aria-label="ProxiaPay"/);
  expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  expect(html).toContain('data-env="sandbox"');
});
```

- [ ] **Step 2: Run them to make sure they fail**

  Run: `npx vitest run src/docs/docs.test.ts`, from `apps/api`.
  Expected: FAIL, because `docs.font` is not a function.

- [ ] **Step 3: Implement the two routes.**
  - **Allow-lists:**
    - Manrope 400, 500, 600 and 700, plus IBM Plex Mono 400 and 500, latin
      woff2, resolved with `require.resolve('@fontsource/…/files/<name>')`;
    - `favicon.svg`, `favicon-32.png` and `apple-touch-icon.png` from
      `assets/brand`.
  - **Loading:** read everything into a `Map` in the constructor, as the page
    and Redoc already are.
  - **Response:** `new StreamableFile(buf, { type })`, with
    `cache-control: public, max-age=86400`.

- [ ] **Step 4: Restyle `docs.html`.**
  - **`@font-face`:** for the six files at `/docs/fonts/…`, with
    `font-display: swap`. `--sans` becomes `Manrope, system-ui, sans-serif`
    and `--mono` becomes `"IBM Plex Mono", ui-monospace, monospace`.
  - **Light `:root`:**
    - `--ink` `#0B0D12`, `--ink-2` `#454B59`, `--muted` `#5B6170`;
    - `--ground` and `--panel` `#FFFFFF`, `--panel-2` `#F6F7F9`, `--line`
      `#ECEEF2`;
    - `--accent` `#0B0D12` (links ink, underlined);
    - `--warn-bg` `#FFF4DC`, `--warn-line` `#F1DFB0`;
    - `--code-bg` `#0B0D12`, `--code-ink` `#F2F3F5`.
  - **Dark `:root`:**
    - `--ink` `#F2F3F5`, `--ink-2` `#C4C8D0`, `--muted` `#9AA0AC`;
    - `--ground` `#0B0D12`, `--panel` `#111318`, `--panel-2` `#14171D`,
      `--line` `#262A33`;
    - `--accent` `#F2F3F5`;
    - `--warn-bg` `#33270C`, `--warn-line` `#5C4714`;
    - `--code-bg` `#14171D` with a `--line` border, so code blocks don't
      vanish into the ground;
    - `--code-ink` `#F2F3F5`.
  - **Drop** `--sandbox` and `--production`.
  - **Masthead:** the text "ProxiaPay" becomes an inline SVG lockup with
    `aria-label="ProxiaPay"` and `role="img"`. Use the mark geometry with
    `currentColor` for the disc, so it inverts in dark mode, plus "ProxiaPay"
    as live Manrope 700 text. Keep the `<small>`.
  - **`.env[data-env="sandbox"]`:** the chip, `#0B0D12` text on `#F5B400`.
    The `.mast` also gets a 6 px top border of the hazard stripe
    `repeating-linear-gradient(-45deg, #F5B400 0 10px, #0B0D12 10px 20px)`.
  - **`.env[data-env="production"]`:** a 1 px `currentColor` outline chip, no
    stripe.
  - **Favicon:** `<link rel="icon" href="/docs/brand/favicon.svg" type="image/svg+xml">`,
    the 32 px PNG, and `apple-touch-icon`.
  - **Redoc theme:**
    - `primary.main` `#0B0D12`;
    - `text.primary` `#0B0D12`, `text.secondary` `#5B6170`;
    - fonts Manrope, headings Manrope 600, code IBM Plex Mono;
    - `sidebar.backgroundColor` `#F6F7F9`;
    - `rightPanel.backgroundColor` `#0B0D12`.

- [ ] **Step 5: Run the tests**

  Run: `npx vitest run src/docs`, from `apps/api`.
  Expected: PASS, including the existing assertions on
  `src="/docs/redoc.standalone.js"` and `id="…"`.

- [ ] **Step 6: Look at it.**
  - Start the API (`npm run dev:api`) and open `/docs` with the system set to
    light, then to dark.
  - Check:
    - the code blocks are visible in dark;
    - the chip is visible in both themes;
    - the Redoc section is readable;
    - the browser's network panel shows no request leaving the origin.

- [ ] **Step 7: Commit** with the message "Dress the documentation in
  ProxiaPay's identity".

---

### Task 3: Console foundations: values, fonts, states, amounts

**Files:**
- Modify: `apps/console/package.json`:
  - dependencies `@fontsource/manrope@5.3.0` and
    `@fontsource/ibm-plex-mono@5.3.0`;
  - devDependency `vitest@^3.2.0`;
  - script `"test": "vitest run"`.
- Modify: root `package.json`. `"test"` becomes
  `npm run test -w apps/api && npm run test -w apps/console`.
- Modify: `apps/console/src/main.tsx`. Import `@fontsource/manrope/latin-{400,500,600,700}.css`
  and `@fontsource/ibm-plex-mono/latin-{400,500}.css` before `./styles.css`.
- Rewrite: `apps/console/src/styles.css`
- Create: `apps/console/src/lib/states.ts`
- Modify: `apps/console/src/lib/format.ts`
- Test: `apps/console/src/lib/states.test.ts`,
  `apps/console/src/lib/format.test.ts`,
  `apps/console/src/styles.test.ts`

**Interfaces:**
- Produces:
  - `type StateFamily = 'confirmed' | 'refused' | 'pending' | 'checking' | 'information' | 'tag'`
  - `stateFamily(value: string): StateFamily`
  - `STATE_SYMBOL: Record<Exclude<StateFamily, 'tag'>, string>`
  - `moneyParts(minor: number | null | undefined, currency: string, lang?: Lang): { figure: string; currency: string }`
  - `money()` is unchanged in output.
- Produces these CSS classes, for Task 4:
  - `.tag` and `.tag.<family>`, `.tag-symbol`;
  - `.amount`, `.amount-figure`, `.amount-currency`, `.negative`;
  - `.lockup`, `.env-ribbon`, `.env-chip.sandbox`, `.env-chip.production`;
  - `.mono` for references;
  - `button.primary`, `button.danger` and default `button`, restyled.

  The existing layout classes (`.shell`, `nav.side`, `.card`, `.kv`,
  `.tabs`, `.warnbox`…) keep their names.

- [ ] **Step 1: Write the failing tests**

```ts
// states.test.ts: one assertion per family. Every value from the spec's table goes in its family.
expect(stateFamily('succeeded')).toBe('confirmed');   // likewise healthy … present
expect(stateFamily('declined')).toBe('refused');      // likewise failed … abandoned
expect(stateFamily('action_required')).toBe('pending');
expect(stateFamily('undetermined')).toBe('checking');
expect(stateFamily('acknowledged')).toBe('information');
expect(stateFamily('primary')).toBe('tag');
expect(stateFamily('secondary')).toBe('tag');
expect(stateFamily('float_drift')).toBe('tag');
expect(stateFamily('brand_new_status')).toBe('tag');   // Review Focus 1

// format.test.ts (Review Focus 3)
for (const [minor, cur, lang] of [[120487000, 'XAF', 'fr'], [-50400, 'XAF', 'en'], [12345, 'USD', 'fr'], [0, 'CDF', 'en']] as const) {
  const p = moneyParts(minor, cur, lang);
  expect(`${p.figure} ${p.currency}`).toBe(money(minor, cur, lang));
}
expect(moneyParts(null, 'XAF')).toEqual({ figure: '—', currency: '' });

// styles.test.ts: parse `--name: #hex` from styles.css; WCAG relative-luminance ratio.
// Pairs ≥ 4.5: ink/white, ink-2/white, muted/white, muted/soft, each state's text on its own background, ink on hazard yellow.
```

- [ ] **Step 2: Run them to make sure they fail**

  Run: `npx vitest run`, from `apps/console`.
  Expected: FAIL. The modules are missing, and the CSS variables are missing.

- [ ] **Step 3: Implement `states.ts` and `moneyParts`.** `money()` returns
  `` `${figure} ${currency}` `` from `moneyParts`, and null gives `'—'` as
  today.

- [ ] **Step 4: Rewrite `styles.css`.**
  - **Values:** the Global Constraints values as `:root` custom properties,
    using semantic names: `--ink`, `--ink-2`, `--muted`, `--line`, `--soft`,
    `--surface`, and `--state-<family>-text` / `--state-<family>-bg`.
    Also `--hazard` and `--font-sans` / `--font-mono`.
  - **Body:** Manrope 14 px, tabular figures wherever `.num` or `.amount`
    appears.
  - **Sidebar:** white, with a `line` right border. Items in `ink-2`; the
    active item in `ink`, 600, on `soft`, and no blue border.
  - **Buttons:** primary black on white text; danger in refused red; default
    white with a `line` border; disabled at 40% opacity.
  - **Links:** `ink`, underlined.
  - **Tables:** `soft` header, `line` rules.
  - **`.warnbox`:** the checking family.
  - **Focus:** `:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }`
  - **Hazard ribbon:** `.env-ribbon.sandbox` is a 6 px sticky stripe at the
    top; `.env-ribbon.production` is `display: none`.
  - **Remove:** every `.pill.*` colour rule. `.pill` becomes an alias of
    `.tag` until Task 4 removes the last raw use.

- [ ] **Step 5: Run the tests, typecheck and build**

  Run: `npx vitest run && npm run typecheck && npm run build`, from
  `apps/console`.
  Expected: PASS. The build emits the latin woff2 files under
  `dist/assets/`.

- [ ] **Step 6: Commit** with the message "Lay the console's identity: values,
  fonts, states and amounts".

---

### Task 4: Console components and screens

**Files:**
- Create: `apps/console/src/components/Logo.tsx`
- Modify: `apps/console/src/components/common.tsx` (`Pill`, `Amount`, a new
  `Tag`)
- Modify: `apps/console/src/components/Shell.tsx`
- Modify: `apps/console/src/pages/SignIn.tsx`
- Modify: `apps/console/index.html` (favicons)
- Modify the pages carrying a raw `<span className="pill …">`:
  `FloatDetail.tsx:25`, `Oversight.tsx:115`, `Reconciliation.tsx:30,37`,
  `Discrepancy.tsx:24`, `ProjectDetail.tsx:61`, `Configuration.tsx:27,28,51,54`,
  `RouteDetail.tsx:44`, `TransactionDetail.tsx:47,62`
- Test: `apps/console/src/components/common.test.tsx`

**Interfaces:**
- Consumes: `stateFamily`, `STATE_SYMBOL`, `moneyParts` and the CSS classes
  from Task 3; the favicon files from Task 1.
- Produces:
  - `Mark({ size }: { size: number })`, the disc SVG, `aria-hidden`;
  - `Lockup({ size }: { size: number })`, `Mark` plus "ProxiaPay" in Manrope
    700, with the role `img` and `aria-label="ProxiaPay"`;
  - `Tag({ family, children, title? }: { family: StateFamily; children: React.ReactNode; title?: string })`.

- [ ] **Step 1: Write the failing tests.** Render with
  `react-dom/server`'s `renderToStaticMarkup`, so no DOM library is needed.
  Mock `useSession` to `{ lang: 'fr' }`.

```tsx
expect(html(<Pill value="failed" />)).toContain('class="tag refused"');
expect(html(<Pill value="failed" />)).toMatch(/<span[^>]*aria-hidden="true"[^>]*>✕<\/span>failed/);
expect(html(<Pill value="secondary" />)).not.toContain('aria-hidden');     // a tag: no symbol
expect(html(<Pill value={null} />)).toBe('<span class="muted">—</span>');   // Review Focus 2
expect(html(<Amount minor={-50400} currency="XAF" />)).toContain('class="amount negative"');
expect(html(<Amount minor={125000} currency="XAF" />)).toMatch(/amount-figure">125 000<\/span>.*amount-currency">XAF</);
```

- [ ] **Step 2: Run them to make sure they fail**

  Run: `npx vitest run src/components`, from `apps/console`.
  Expected: FAIL.

- [ ] **Step 3: Implement `Logo.tsx`, `Tag`, `Pill` and `Amount`.**
  - **`Pill`:** `Tag` with `stateFamily(value)`. The word is unchanged:
    `value.replace(/_/g, ' ')`.
  - **`Amount`:** `<span class="amount [negative]"><span class="amount-figure">…</span> <span class="amount-currency">…</span></span>`

- [ ] **Step 4: Run the tests**

  Run: `npx vitest run src/components`, from `apps/console`.
  Expected: PASS.

- [ ] **Step 5: Shell, sign-in, favicons and raw badges.**
  - **Shell:**
    - `<div className={`env-ribbon ${me.environment}`} aria-hidden="true" />`
      above everything;
    - the sidebar starts with `<Lockup size={22} />`, then
      `<span className={`env-chip ${me.environment}`}>{t(`env.${me.environment}`)}</span>`;
    - the old `.band` goes away.
  - **Sign-in:** `<Lockup size={28} />` centred above the card, in place of
    `<h1>ProxiaPay</h1>`. The language selector stays at the right of the
    card's first row.
  - **`index.html`:**
    - `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`;
    - `<link rel="icon" href="/favicon-32.png" sizes="32x32">`;
    - `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`.
  - **Raw badges:** each `<span className="pill X">` becomes `<Tag family=…>`,
    with the same children and `title`:
    - `critical` and `failed` become `refused`;
    - `warning` becomes `checking`;
    - `active` becomes `confirmed`;
    - `primary` becomes `tag`.

    Then delete the `.pill` alias from `styles.css`.
  - **References:** add `className="mono"` where a transaction reference, ID
    or key is printed in a table cell or `dd`. Find them with
    `grep -rn "reference\|\.id\b\|key_prefix" src/pages`.

- [ ] **Step 6: Typecheck, lint, test and build**

  Run: `npm run typecheck && npm run lint && npm test && npm run build -w apps/console`,
  from the repository root.
  Expected: PASS.

- [ ] **Step 7: Commit** with the message "Dress the console in ProxiaPay's
  identity".

---

### Task 5: Look at every screen

**Files:** only those that need a spacing fix, found by looking.

- [ ] **Step 1: Launch the console** against a local API and seed, using the
  `run` skill. Sign in.
- [ ] **Step 2: Visit all fifteen routes at 1440 px and 1024 px wide**:
  - sign-in, home, transactions, a transaction, projects, a project,
    configuration, a route;
  - treasury, a float account, reconciliation, a discrepancy;
  - oversight (every tab), approvals, previews, search.

  On each, check:
  - every chip has a symbol and a word, or is a plain tag;
  - amounts align in columns;
  - references are in Plex Mono;
  - focus is visible when tabbing;
  - nothing overflows the page horizontally.
- [ ] **Step 3: Switch `PROXIAPAY_ENV`** between `sandbox` and `production`,
  restart, and confirm:
  - the ribbon and "Sandbox" chip appear in the sandbox only;
  - the outlined "Production" chip appears in production;
  - the sign-in page shows neither (`me` is null before sign-in, per the
    spec).
- [ ] **Step 4: Open each logo file** at 16, 32 and 180 px, plus
  `logo-inverted.svg` on black. The two bars must stay separate at 16 px.
- [ ] **Step 5: Fix what the visit found** within the spec's rules, then run
  `npm run typecheck && npm test && npm run build -w apps/console`.
  Expected: PASS.
- [ ] **Step 6: Commit** with the message "Tune spacing after a pass over
  every screen". Skip it if nothing changed.
