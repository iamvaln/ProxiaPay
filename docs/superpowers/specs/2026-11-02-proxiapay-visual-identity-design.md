# ProxiaPay visual identity, applied to the console and the documentation

Status: design, awaiting approval · 2026-11-02

## Why

ProxiaPay carries merchants' revenue. Today it looks like a generic admin
template: system fonts, a navy sidebar, a blue accent, pastel badges, no logo.
Nothing about it says that a payment specialist is behind it.

The identity has one job: **a merchant, a developer or an operator should feel
they are dealing with a payment expert they can trust with their money.** It
should feel close to businesses in Central and West Africa while meeting
international standards: precise, calm, sure of itself. Those words, and every
decision marked *decided* below, come from Valentine.

## Goals

- One identity, defined once as named values, used by the admin console
  (`apps/console`) and the public documentation (`apps/api/assets/docs.html`,
  served at `/docs` and `/v1/docs`).
- A logo and an icon, delivered as files.
- Every console screen restyled to the identity.
- The documentation page restyled to the identity, Redoc reference included.

## Non-goals

- **No change in how the console works, in this project.** The console's UX
  will be reviewed: what each screen shows, in what order, and how tasks
  flow. That review is a separate project that follows this one and builds
  on it. Ideas raised earlier, such as ⌘K search, version history views and
  before/after panels, belong to it. Here, the routes, data, permissions,
  confirmation flows, i18n keys and wording stay as they are. The one
  exception is the environment marker, described below.
- No merchant landing page. It comes later and will reuse this identity.
- No dark mode in the console.
- No trademark search. Valentine decided against it.

## Anti-goals

These are failures even if everything technically works:

- **Folklore.** No wax patterns, masks, maps of Africa or flag colours. The
  closeness to the region is carried by tone, not by motifs.
- **Looking like a provider.** No MTN yellow, no Orange orange, and no colour
  that could be read as one provider's.
- **Flash.** No gradients, glows, glassmorphism or decorative illustration.
  Experts don't decorate.
- **A state told by colour alone.**
- **A claim the interface cannot guarantee.** For example "no money is really
  debited": the sandbox can be wired to a real provider, as it was for the
  Ejara tests, and then the sentence becomes false.

## The identity

### Colour (decided: black and white)

**The brand colour is black** (`ink`). Wherever a coloured theme would put its
accent, ProxiaPay puts ink:

- primary buttons;
- links;
- the active navigation item, filled;
- the active tab;
- focus outlines;
- selected text;
- checkboxes, radios and date pickers (`accent-color`);
- the outline of a selected card.

Pages are white. The only hues on screen say what state something is in, so
they stand out.

Brand values:

| Name | Value | Use |
|---|---|---|
| `ink` | `#0B0D12` | text, the logo, primary buttons, the active navigation item |
| `ink-2` | `#454B59` | secondary text |
| `muted` | `#5B6170` | labels, captions, the currency next to an amount |
| `line` | `#ECEEF2` | borders, table rules |
| `soft` | `#F6F7F9` | table headers, quiet panels, inputs |
| `white` | `#FFFFFF` | page and card background |

State families. Each family always shows a colour, a symbol and a word:

| Family | Symbol | Text | Background | Values that reach `Pill` today |
|---|---|---|---|---|
| Confirmed | ✓ | `#0A6B40` | `#E3F6EC` | succeeded, healthy, active, matched, delivered, confirmed, approved, completed, resolved, cleared, done, present |
| Refused | ✕ | `#A52A22` | `#FDECEB` | failed, expired, critical, suspended, exhausted, revoked, declined, rejected, dead, disabled, deleted, abandoned |
| Pending | ◷ | `#454B59` | `#F1F2F5` | processing, submitted, pending, action_required, created, submitting, pending_approval, under_review, running, queued, half_open |
| Needs checking | ! | `#7A5200` | `#FFF4DC` | undetermined, watch, warning, disputed, degraded, open, unreviewed |
| Information | i | `#454B59` | `#F1F2F5` | informational, acknowledged, examined, corrected |

The table covers the `.pill.*` rules in `apps/console/src/styles.css` and the
values the pages actually pass to `Pill`, checked against the API's CHECK
constraints. All the placements are my calls. Two of them change a meaning
and deserve a word:

- `undetermined` moves from purple to *needs checking*, because an
  undetermined payment is one a person must look at.
- `action_required` goes in *pending*, because the person who has to act is
  the payer, not the operator.

**Values that are not states get a plain tag, with no symbol and no colour.**
That means an outline in `line` with `ink-2` text. Two of them reach `Pill`
today:

- the credential roles `primary` and `secondary`;
- the discrepancy types on Home (`float_drift`, `fee_variance`…).

A symbol on those would assert a meaning they don't have.

A value not listed anywhere also gets the plain tag, never a symbol. The
builder then adds it to the right family. Negative amounts use the refused
text colour and keep their minus sign.

Names are semantic (`ink`, `muted`, `state-refused-text`…), never literal
(`black`, `red`), so a dark theme can be added later by redefining values
only.

### The logo (decided: the equals sign in a disc)

A black disc with a white equals sign, its two bars level. Next to it, the
name **ProxiaPay**. The meaning, told once and then remembered: *the books
always balance*. Every franc collected matches a franc paid out, which is the
double-entry ledger at the heart of the product.

Geometry, on a 40 × 40 grid:

- the disc has radius 20, centred;
- the bars are 20 wide and 5 high, corner radius 1, at x = 10, one at
  y = 12.5 and one at y = 22.5.

The bars were first drawn at y = 13 and 22. They moved half a unit so their
edges fall on whole pixels at 16 and 32 px, where the first position blurred
them together.

The builder may adjust bar thickness and gap by a unit if the 16 px rendering
needs it. The shape does not change.

- **Lockup:** disc, then "ProxiaPay" in Manrope 700 with letter-spacing
  −0.03em. The cap height of the name is about half the disc's diameter. The
  gap between disc and name is about a quarter of the diameter.
- **Clear space:** at least a quarter of the disc's diameter on every side.
- **Inverted:** on black, the disc turns white and the bars black.
- **Icon:** the disc alone. It is used for the favicon, the app icon and
  avatar-sized uses.
- **Files to produce:**
  - `logo.svg` (lockup), `logo-inverted.svg`, `mark.svg` (disc alone);
  - `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (180 px).

  The name in the SVG lockups must be converted to outlines, so the files
  render without the font installed.

### Typography (decided: Manrope)

- **Manrope** for everything: the name, headings, text, labels and amounts.
  Weights 400, 500, 600, 700.
- **IBM Plex Mono** for anything a person might copy or compare character by
  character: transaction references, IDs, API keys, codes, the docs' code
  samples. Weights 400 and 500. This is my call, so 0 and O are never
  confused.
- **Amounts:**
  - tabular figures, so columns line up;
  - the figure in Manrope 600, the currency code after it in a smaller size in
    `muted`;
  - grouping as `format.ts` already does it.

  The headline amount on a screen is the largest text on that screen.
- **Size steps:** 12, 13, 14 (body), 16, 20, 28, 34 px. Headings are set
  slightly tight, and uppercase is reserved for small labels.
- **Self-hosted, both fonts.** The docs module states it: *"a payment host
  loads no third-party script"*. The same rule applies to fonts, so there are
  no Google Fonts requests. Both fonts are SIL Open Font License.
  - The console bundles them through Vite.
  - The API serves its own copies for the docs page, the way it already
    serves `redoc.standalone.js`.
  - woff2, Latin subset including French accents.

### The environment marker (decided: the ribbon, and no claims)

Console spec section 2 requires that *"the environment is unmistakable"*.

- **Sandbox:**
  - a 6 px stripe of diagonal yellow-and-black hazard bands
    (`#F5B400` / `#0B0D12`), across the full width at the very top, sticky;
  - a "Sandbox" chip next to the logo, black text on `#F5B400`.

  The chip's word comes from the existing i18n key `env.sandbox`.

  The hazard yellow is deliberately more vivid than the *needs checking*
  amber, and it only ever appears as stripes or as this chip, so the
  environment and a state can't be confused.
- **No sentence about what money does.** Buttons and confirmations read the
  same as in production. This was Valentine's decision, because any such claim
  can become false.
- **Production:** no stripe. The spec asks for a persistent marker that
  *names* the environment, and silence does not name it. So production shows a
  quiet "Production" chip next to the logo, black outline and black text. My
  call, to satisfy section 2 without bringing back today's red band.
- **The docs page:** the same stripe on its header in the sandbox. Its
  existing `env` pill takes the chip styles above.

### Dark mode

- **Console:** light only (decided).
- **Documentation:** the page already follows the reader's system setting
  (`prefers-color-scheme`). Removing that would be a regression on a public
  page, and Valentine expects public sites to offer a dark mode. So it keeps
  its dark theme, re-coloured with the identity:
  - the ground is near-black `#0B0D12`;
  - text is white;
  - the logo is inverted;
  - state colours are lightened until they reach AA contrast.

  My call.
- **The Redoc reference** stays on an explicitly light surface in both themes,
  as it does today, because its stylesheet is light-only.

### Shape and spacing

- **Radii:** 6 px for inputs and buttons, 10 px for cards, full round for
  state chips.
- **Borders and shadows:** cards have 1 px `line` borders and no shadow. Depth
  comes from spacing, not shadow.
- **Spacing:** a 4 px base step. Generous white space around amounts and
  headings.
- **Focus:** a 2 px `ink` outline with 2 px offset, on every interactive
  element.

### Accessibility

- All text at least WCAG AA: 4.5:1 for body text, 3:1 for text 18 px and
  larger.
- Every state readable without colour: symbol and word.
- Focus always visible. Nothing conveyed by hover alone.

## Applying it

### The console

The screens are the routes in `apps/console/src/pages`: sign-in, home,
transactions and detail, projects and detail, configuration and route detail,
treasury and float detail, reconciliation and discrepancy, oversight,
approvals, previews, search.

The work is mostly `styles.css` and the shared pieces in
`components/common.tsx` and `components/Shell.tsx`. Page files change only
where they hard-code styles.

- **Shell:**
  - the dark navy sidebar becomes white, with a `line` border on its right;
  - the lockup at the top;
  - navigation items in `ink-2`, the active one in `ink`, weight 600, on
    `soft`;
  - the administrator's name, time zone and sign-out at the bottom;
  - search stays where it is, restyled.

  The environment marker sits above everything, as specified.
- **Buttons:**
  - primary is black with white text;
  - secondary is white with a `line` border and `ink` text;
  - danger is refused red with white text;
  - disabled is 40% opacity.
- **Links:** `ink`, underlined. There is no accent colour left to mark them.
- **Tables:**
  - `soft` header row with small uppercase `muted` labels;
  - `line` rules;
  - numbers right-aligned and tabular;
  - references in Plex Mono.
- **`Pill`:**
  - adds the family's symbol before the word, from the table above;
  - the word stays as today (`value` with underscores replaced);
  - the symbol is decorative, `aria-hidden`.
- **`Amount`:** the amount treatment described above.
- **Sign-in:** the lockup centred above the form, and nothing else added.
- **Warnings and callouts** (`.warnbox`): the *needs checking* family.
- **Favicon and title:** the icon files, and `<title>` unchanged.

### The documentation page

- **`docs.html`:**
  - new values for its `:root` variables, in both its themes;
  - Manrope and Plex Mono replace the system stacks;
  - the lockup replaces the text "ProxiaPay" in the masthead;
  - favicon;
  - code blocks stay dark, on `ink`.
- **Redoc theme options:**
  - primary colour `#0B0D12`, text `ink` and `muted`;
  - Manrope for text and headings, Plex Mono for code;
  - the sidebar on `soft`;
  - the right panel on `ink`.

## Constraints

- Nothing loaded from a third-party host, neither fonts nor scripts, on either
  surface.
- The console and the docs page remain separate builds (`apps/console`,
  `apps/api`). How the shared logo and font files reach each one is the
  builder's call. Both Docker builds use the repository root as their context.
- `npm run build` and the existing tests keep passing. `docs.test.ts` asserts
  on the page's script tag, so it must keep doing so.
- The CI audit gate fails on new advisories, so any font package added must be
  clean.

## Left to the builder

- Exact token names and how they are organised in CSS.
- The exact icon set or glyphs for the state symbols, as long as they match
  the four families.
- Where the brand files live in the repository, and how fonts are packaged.
- Fine spacing on each screen, within the rules above.
- How to verify. The minimum:
  - each console screen viewed in both environments;
  - the docs page in light and dark;
  - the logo checked at 16, 32 and 180 px;
  - contrast of every text and background pair checked.

## Reference

The mockups from the brainstorm are in `.superpowers/brainstorm/` (not
committed): `identity-accents.html` (option 1), `logo-equals.html` (option 1),
`typefaces.html` (option C) and `sandbox-marker.html` (option 1, without
banner sentences).
