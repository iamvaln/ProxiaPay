# Payment Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project's owner creates a payment link from the console, fixed or free amount, with methods across countries and the client's brand. Payers pay on a small branded page at `paylink.proxia-digital.com/<code>` and get a receipt, by email if they want.

**Architecture:**
- **API.** A `payment-links` module owns links, brand assets and link payments. Console endpoints live under `/console/projects/:id/payment-links` and `/console/projects/:id/brand`. Public endpoints live under `/pay-api/v1`, outside both guards.
- **Payments.** A link payment is an ordinary transaction. It is made through the existing `PreviewService.create` and `TransactionService.confirm` with a link principal, then submitted. A `payment_link_payment` row ties the transaction to its link and its hashed payer token.
- **Page.** A second Vite entry (`pay.html`) builds the payer page. The console's nginx container serves it on the paylink host, and Traefik routes `/pay-api` on that host to the api.

**Tech Stack:** NestJS 11, Kysely, PostgreSQL 16 (plain SQL migrations), zod, Vitest; React 19 + Vite (multi-page), Testing Library + jsdom; nginx; Traefik labels in `docker-compose.deploy.yml`.

**Spec:** `docs/superpowers/specs/2026-11-15-payment-links-design.md`

## Global Constraints

- **Who creates.**
  - New permission `links.manage` ("Create and disable payment links"), granted to `Owner` and `Client owner` only.
  - Reading links falls under `projects.read`.
- **What a link holds.**
  - One currency per link, and one or more routes in that currency, across any countries.
  - Amount type `fixed` (an amount) or `free` (a minimum, default 0). The effective floor is the higher of the link's minimum and the route's minimum. The route's maximum always applies.
  - `code`: 10 random base62 characters.
  - `single_use` defaults to false. `expires_at` is optional.
  - `status` is `active`, `disabled` or `completed`.
- **A single-use link never collects twice.**
  - Any non-final payment holds the link, `undetermined` included.
  - Success sets the link to `completed`. A final failure or expiry opens it again.
  - A correction that turns a failed payment into a success, while another payment already succeeded, raises an alert: category `treasury`, title "Single-use link collected twice".
  - A correction that turns the completing success into a failure opens the link again.
  - Link updates happen in the same database transaction as the state change.
  - Payer copy:
    - "A payment is already in progress on this link";
    - for `undetermined`: "A payment on this link is being checked".
- **Unavailable links.** A disabled, expired, completed or unknown link answers one neutral "This link is no longer available".
- **Public API.**
  - Every public route is under `/pay-api/v1`, with no session and no credential.
  - Methods are identified by an opaque **method key**, never a route id.
  - Project references are `PL-<code>-<unique suffix>`.
  - The payment token is random, stored hashed, and valid 24 h.
- **Rate limits** use the existing `RateLimiter.hit(key, limit, windowSeconds)` and answer HTTP 429 with a plain message:
  - creating a payment: 5/min per address, 3 per 600 s per normalised number, 30/min per link;
  - reading a payment, a quote, or sending a receipt: 60/min per token or address.
- **Brand.**
  - Logo: PNG, JPEG or WebP, ≤ 200 KB. No SVG. The type is checked from the magic bytes.
  - Logos are served with their exact content type and `nosniff`.
  - Colours: `#RRGGBB`. A colour is refused when its contrast with white text is below 4.5:1.
- **Receipt email.**
  - Optional, and at most 3 per payment, only for a succeeded payment.
  - Sender display name: `<Project name> via ProxiaPay`.
  - The address is not kept. Only the time sent and a masked address (`a***@gmail.com`) are stored.
  - A send failure shows "We could not send the email; save the receipt instead."
- **Branding wording.** "Powered by ProxiaPay" appears on the page, the receipt and the email. The sandbox page shows the band "Sandbox — no real money moves".
- **No exposure.** Nothing public exposes credentials, internal ids, provider names, provider fees or margin.
- **Copy.** Console and page copy are in English and French. There are no hard-coded user-facing strings in new UI.
- **Test database.** API tests run against `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/proxiapay_test_links`, a dedicated database the controller creates.
- **Commits.** Commit messages carry no AI-attribution trailer and no "Generated with" line (the repo owner's CLAUDE.md).

## Review Focus

1. **Two payers on a single-use link at the same instant.** Exactly one payment is created and the other gets "A payment is already in progress on this link". Pinned in Task 5.
2. **A free-amount payment with an amount below the floor, above the route maximum, zero, negative or fractional** for the currency exponent. Each is refused with a plain message, and no preview is created. Pinned in Task 5.
3. **A method key from another link, or a route that has since been deactivated.** It answers like an unavailable method, the page drops it, and no payment is created. Pinned in Task 4 and Task 5.
4. **A logo that is an SVG renamed `.png`, a 201 KB PNG, or a file with a PNG name and HTML content.** All are refused by magic bytes and size. Pinned in Task 2.
5. **The paylink host asked for `/console/...` or `/v1/...`, and `pay.proxia-digital.com` asked for `/pay-api/...`.** Neither reaches the API, and neither serves the other app. Pinned in Task 10 with config tests.

---

### Task 1: Schema and permission

**Files:**
- Create: `apps/api/migrations/0005_payment_links.sql`
- Modify:
  - `apps/api/src/permissions/permissions.ts`, adding `links.manage` to the catalogue, to `PLATFORM_PERMISSIONS` (via the catalogue) and to `CLIENT_ROLES` owner;
  - `apps/api/src/seed/seed.ts` if needed;
  - `apps/api/src/db/schema.generated.ts`.
- Test: `apps/api/src/payment-links/schema.test.ts`

**Interfaces:**
- Produces these tables:
  - `brand_asset`: `id uuid pk`, `project_id`, `bytes bytea`, `content_type text check in ('image/png','image/jpeg','image/webp')`, `sha256 text`, `created_at`.
  - `project_brand`: `project_id pk`, `logo_asset_id null`, `primary_color text`, `secondary_color text null`, `updated_at`.
  - `payment_link`:
    - `id`, `code text unique`, `project_id`, `title`, `description null`, `currency_code`;
    - `amount_type text check in ('fixed','free')`, `amount bigint null`, `minimum_amount bigint not null default 0`;
    - `single_use bool default false`, `expires_at null`;
    - `status text check in ('active','disabled','completed') default 'active'`;
    - `logo_asset_id null`, `primary_color`, `secondary_color null`;
    - `created_by`, `created_at`, `updated_at`;
    - a check that `amount` is set exactly when `amount_type = 'fixed'`.
  - `payment_link_route`: `id uuid pk` (the method key), `link_id`, `route_id`, unique (`link_id`, `route_id`).
  - `payment_link_payment`:
    - `id`, `link_id`, `transaction_id unique`, `token_hash bytea unique`, `expires_at`;
    - `receipts_sent int default 0`, `receipt_sent_at null`, `receipt_sent_to text null` (masked).
- Produces these changes to existing tables:
  - `transaction.payment_link_id uuid null references payment_link`, plus an index.
  - `route.payer_instructions jsonb null`, shaped `{ "en": string, "fr": string }`. This is the per-route text shown on the waiting screen.
  - `links.manage` is inserted into roles `Owner` and `Client owner`, idempotently.

- [ ] **Step 1: Write the failing test.** `schema.test.ts` asserts:
  - `Owner` and `Client owner` hold `links.manage`, and `Client developer`, `Client finance` and `Configuration` do not;
  - inserting a `fixed` link without an amount fails;
  - a `free` link with an amount fails;
  - a `brand_asset` with `image/svg+xml` fails.
- [ ] **Step 2: Run it.** `cd apps/api && TEST_DATABASE_URL=… npx vitest run src/payment-links/schema.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the migration, the permission and the generated types.**
- [ ] **Step 4: Run.** The same test, then `npx vitest run src/seed src/db` and `npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit.** "Schema for payment links, brand assets and link payments".

### Task 2: Brand, the logo and colours of a project

**Files:**
- Create:
  - `apps/api/src/payment-links/brand.ts`, holding the pure checks;
  - `apps/api/src/payment-links/brand.service.ts`;
  - `apps/api/src/payment-links/payment-links.module.ts`;
  - `apps/api/src/console-api/brand.controller.ts`.
- Modify: `apps/api/src/console-api/console-api.module.ts`, `apps/api/src/console-api/client-wall.test.ts` (allowlist), `apps/api/src/console-api/client-views.test.ts` (net).
- Test: `apps/api/src/payment-links/brand.test.ts`

**Interfaces:**
- Produces these pure checks:
  - `logoType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null`, by magic bytes;
  - `MAX_LOGO_BYTES = 200 * 1024`;
  - `contrastWithWhite(hex: string): number`;
  - `isUsableColor(hex: string): boolean`, meaning `/^#[0-9a-fA-F]{6}$/` and a contrast of at least 4.5.
- Produces `BrandService`:
  - `get(projectId): Promise<{ logo_asset_id: string|null; primary_color: string; secondary_color: string|null }>`, which defaults to ProxiaPay's brand primary when unset;
  - `setLogo(tx, projectId, bytes: Buffer, actorId): Promise<{ asset_id: string }>`;
  - `setColors(tx, projectId, { primary_color, secondary_color }, actorId)`.
- Produces these endpoints, all `@ClientAccessible()` and bound to the project through reach:
  - `GET /console/projects/:id/brand` (`projects.read`);
  - `PUT /console/projects/:id/brand` (`links.manage`), with `{ primary_color, secondary_color? }`;
  - `POST /console/projects/:id/brand/logo` (`links.manage`), with a JSON body `{ data_base64 }` (no multipart, see the multer note in the root `package.json`).
- Errors: `FIELD_INVALID` on `logo`, with the message "Use a PNG, JPEG or WebP image of at most 200 KB."; `FIELD_INVALID` on `primary_color` or `secondary_color`, with the message "This colour is too light for white text; pick a darker one."
- Every change is audited as `brand.logo` or `brand.colors`.

- [ ] **Step 1: Write the failing tests.**
  - `refuses an SVG renamed .png`: an SVG's bytes give `logoType` null and a 422.
  - `refuses a 201 KB PNG`.
  - `refuses HTML with a PNG name`.
  - `accepts PNG, JPEG and WebP by their first bytes`.
  - `refuses #FFFF00 and accepts #1A56DB`.
  - `a client developer cannot change the brand`: PERMISSION_DENIED.
  - `a client owner sets the brand of their own project only`: NOT_FOUND on another client's project.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/payment-links src/console-api`, then tsc and lint. Expected: PASS.
- [ ] **Step 5: Commit.** "Project brand: a checked logo and readable colours".

### Task 3: Managing links in the console API

**Files:**
- Create: `apps/api/src/payment-links/links.service.ts`, `apps/api/src/console-api/payment-links.controller.ts`
- Modify: the wall allowlist, the client-views net, `apps/api/src/config/config.ts` (`PAYLINK_BASE_URL: z.string().url().optional()`)
- Test: `apps/api/src/payment-links/links.test.ts`

**Interfaces:**
- Produces `LinksService`:
  - `create(tx, projectId, input: LinkInput, actorId): Promise<{ id: string; code: string; url: string }>`;
  - `disable(tx, projectId, linkId, actorId)`;
  - `list(projectId)` and `detail(projectId, linkId)`.
  - `url` is `${PAYLINK_BASE_URL}/${code}`. Without `PAYLINK_BASE_URL`, creation answers `RULE_VIOLATION` with the message "Payment links are not configured on this platform."
- `LinkInput` fields:
  - `title` (1-120), `description?` (≤ 500);
  - `currency`;
  - `amount_type: 'fixed'|'free'`, `amount?`, `minimum_amount?` (default 0);
  - `route_ids: string[]` (at least 1);
  - `single_use?`, `expires_at?` (in the future);
  - `brand?: { logo_asset_id?, primary_color?, secondary_color? }`. When absent, the project's brand is copied.
- Validation at creation:
  - every route is an active collection route the project is entitled to, in `currency`;
  - a fixed amount fits each route's minimum and maximum;
  - a free minimum is not above any route's maximum;
  - a brand `logo_asset_id` belongs to the project.
- Each list or detail entry carries:
  - `{ id, code, url, title, amount_type, amount, minimum_amount, currency, single_use, expires_at, status }`;
  - `methods: { country, payment_method, payment_method_name }[]`;
  - `payments: { count, succeeded, total_collected, last_at }`.
- Endpoints, each `@ClientAccessible()` with reach on its own permission and `:lid` bound to `:id`:
  - `GET /console/projects/:id/payment-links` (`projects.read`);
  - `POST /console/projects/:id/payment-links` (`links.manage`);
  - `GET /console/projects/:id/payment-links/:lid` (`projects.read`);
  - `POST /console/projects/:id/payment-links/:lid/disable` (`links.manage`).
- Creation and disabling are audited as `payment_link.create` and `payment_link.disable`.
- The 10-character base62 code comes from `crypto.randomBytes`. On a unique violation, retry the code.

- [ ] **Step 1: Write the failing tests.**
  - `a client owner creates a fixed link over routes of two countries in XAF`.
  - `refuses a route in another currency, an inactive route, a route without entitlement`.
  - `refuses a fixed amount below a route minimum`.
  - `copies the project brand when none is given`.
  - `a client developer cannot create or disable; finance can list`.
  - `refuses :lid of another project`.
  - `refuses creation when PAYLINK_BASE_URL is unset`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/payment-links src/console-api`, then tsc and lint. Expected: PASS.
- [ ] **Step 5: Commit.** "Payment links in the console API".

### Task 4: Public read, quote and logos

**Files:**
- Create: `apps/api/src/pay-api/pay-api.controller.ts`, `apps/api/src/pay-api/pay-api.module.ts`, `apps/api/src/payment-links/public-view.ts`
- Modify: `apps/api/src/app.module.ts` (register the module)
- Test: `apps/api/src/pay-api/read.test.ts`

**Interfaces:**
- Produces `PublicLinkView`:
  - `{ code, project_name, title, description, amount_type, amount|null, minimum_amount, currency, exponent, sandbox: boolean }`;
  - `brand: { logo_url|null, primary_color, secondary_color|null }`, where `logo_url = /pay-api/v1/assets/<id>`;
  - `countries: { code, name, dialling_prefix }[]`;
  - `methods: { key, country, name, minimum_amount, maximum_amount, payer_action: 'none'|'code'|'browser', charged_amount?: number }[]`. `charged_amount` is set only for a fixed link.
- Only currently usable methods are listed: the route is active, the country is active, the entitlement is active, and the project is active.
- Produces `linkPrincipal(link): ProjectPrincipal`, which fills `projectId`, `projectCode` and `scopes: ['collection']`, and sets `credentialId`, `credentialKey` and `tokenId` to `''`. The preview and transaction services read only `projectId` and `scopes`; verify this before relying on it.
- Endpoints:
  - `GET /pay-api/v1/links/:code` returns a `PublicLinkView`, or 404 `LINK_UNAVAILABLE` with "This link is no longer available" for an unknown, disabled, expired or completed link.
  - `POST /pay-api/v1/links/:code/quote` takes `{ method, amount }` and returns `{ charged_amount, fees_borne_by_payer }`. It is computed with `RouteResolver.resolve` and `computeFigures`, the same as a preview, and creates nothing. Rate limit: 60/min per address.
  - `GET /pay-api/v1/assets/:id` returns the bytes with their exact `content-type`, `x-content-type-options: nosniff` and `cache-control: public, max-age=31536000, immutable`. It is served only if the asset is referenced by an active link or a project brand; otherwise it answers 404.

- [ ] **Step 1: Write the failing tests.**
  - `shows a fixed link with per-method charged amount and no internal ids`: the JSON contains none of `route_id`, `project_id`, `provider`, `margin`, `expected_fee`.
  - `one neutral answer for unknown, disabled, expired, completed`.
  - `drops a method whose route was deactivated`.
  - `quote for a free link matches what a preview would charge`.
  - `a method key from another link is unknown`.
  - `an asset not referenced by an active link or brand is 404`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/pay-api src/payment-links`, then tsc and lint. Expected: PASS.
- [ ] **Step 5: Commit.** "Public view of a payment link, quotes and logos".

### Task 5: Paying through a link

**Files:**
- Create: `apps/api/src/payment-links/link-payments.service.ts`
- Modify: `apps/api/src/pay-api/pay-api.controller.ts`
- Test: `apps/api/src/pay-api/pay.test.ts`

**Interfaces:**
- **Two steps** (spec: review the total, then confirm).
  1. `LinkPaymentsService.preview(code, { method, msisdn, amount? }, clientAddress): Promise<{ token, review: { amount, fees_borne_by_payer, total, currency, method: { country, name }, msisdn_formatted, expires_at } }>`. It runs checks 1, 3 and 5 below, then step 6, and inserts `payment_link_payment` with the token hash and a null `transaction_id`. Make `transaction_id` nullable in Task 1's table, with a `preview_id` column.
  2. `LinkPaymentsService.confirm(token, clientAddress): Promise<{ reference }>`. It runs checks 2 and 4, then steps 7 and 8, and sets `transaction_id`. An expired preview answers "This total has expired; start again."
- The order of checks and steps across the two calls:
  1. Apply the rate limits in Global Constraints. Key the per-number limit on the normalised number, using the method's country.
  2. Lock the link row (`FOR UPDATE`).
  3. Refuse an unavailable link.
  4. For a single-use link, refuse when another payment's transaction is not in `TERMINAL_STATES`, with the copy from Global Constraints.
  5. Validate the free amount: an integer, above the floor, at most the route maximum. Refuse with `FIELD_INVALID` on `amount`, with the messages "The amount must be at least {min} {currency}." and "The amount must be at most {max} {currency}.".
  6. Create the preview with `PreviewService.create(linkPrincipal(link), {…, project_reference: 'PL-'+code+'-'+suffix})`.
  7. Call `TransactionService.confirm(principal, preview.reference, 'collection')`, then `SubmissionService.submit(transactionId)`.
  8. Set `transaction.payment_link_id` and insert `payment_link_payment` with the token hash and a 24 h expiry.
- Steps 3 to 8 run in one database transaction where the services allow it. Otherwise, the single-use check and the `payment_link_payment` insert share the link lock; document the choice in the report.
- Endpoints:
  - `POST /pay-api/v1/links/:code/previews` returns `{ payment_token, review }` with status 201.
  - `POST /pay-api/v1/payments/:token/confirm` returns `{ reference }`.
- An unconfirmed preview never holds a single-use link. The single-use check (4) runs at confirm.

- [ ] **Step 1: Write the failing tests.**
  - `a payer pays a fixed link: one transaction with project_reference PL-<code>-…, payment_link_id set, normal ledger and webhook`.
  - `free amount: refuses below floor (link minimum 500 over a 100 route minimum), above max, 0, -1, 10.5 for XAF`.
  - `two concurrent confirms on a single-use link: exactly one transaction, the other refused with "A payment is already in progress on this link"`, using two promises raced against the real DB.
  - `an unconfirmed preview does not hold a single-use link`.
  - `confirm after the preview expired answers "This total has expired; start again."`.
  - `rate limit per number: the 4th request within 600 s answers 429`.
  - `a method key of another link answers like an unavailable method`.
  - `entitlement limits still apply`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/pay-api src/payment-links src/transactions`, then tsc and lint. Expected: PASS.
- [ ] **Step 5: Commit.** "Pay through a link: one transaction, limits, single use".

### Task 6: Following a payment, single-use lifecycle, the link on the API resource

**Files:**
- Modify:
  - `apps/api/src/pay-api/pay-api.controller.ts`;
  - `apps/api/src/transactions/transaction.service.ts`: `finalizeSuccess`, `finalizeFailure`, `applyCorrection`, and wherever a transaction reaches `expired`;
  - `apps/api/src/transactions/transaction-reader.ts` (`toApi`);
  - `apps/api/src/docs/openapi.ts`, `docs/spec/api-reference.md`, and the OpenAPI JSON files if they are generated.
- Create: `apps/api/src/payment-links/link-lifecycle.ts`
- Test: `apps/api/src/pay-api/follow.test.ts`

**Interfaces:**
- Produces `onTransactionFinal(tx, txn, previous: string, next: string)` in `link-lifecycle.ts`. It is called from every state change named above, in the same database transaction, and does nothing when `txn.payment_link_id` is null. For a single-use link:
  - `succeeded` sets the link to `completed`;
  - `failed` or `expired` leaves the link `active`;
  - a correction from failed to succeeded, while another payment of the link already succeeded, raises an alert through `AlertService.raise` with:
    - category `treasury`, severity `warning`;
    - title "Single-use link collected twice";
    - fingerprint `link_collected_twice:<link id>`;
    - action reference `/projects/<project id>?tab=links`;
  - a correction from succeeded to failed on the payment that completed the link sets the link back to `active`.
- Endpoints:
  - `GET /pay-api/v1/payments/:token` returns:
    - `{ state, reference, amount, charged_amount, currency, method: { country, name } }`;
    - `action: { type: 'code', attempts_remaining, expires_at } | { type: 'browser', url, expires_at } | null`;
    - `outcome: { failure_reason_text } | null`;
    - `instructions: string | null`: the route's `payer_instructions` in the requested language (`?lang=fr|en`), or null so the page shows its generic text.

    `failure_reason_text` is a plain sentence from a fixed map, never a provider code. An unknown or expired token answers 404 "This payment is no longer available". Rate limit: 60/min per token.
  - `POST /pay-api/v1/payments/:token/code` takes `{ code }` and goes through `TransactionService.submitCode` with the link principal and the same adapter call as `project-api.controller.ts` `code()`. Extract a shared helper rather than duplicating it.
- `toApi` gains `payment_link: { code } | null`. It therefore appears in `GET /v1/transactions/:reference` and in webhook payloads, and is documented as optional.

- [ ] **Step 1: Write the failing tests.**
  - `follows a payment from created to succeeded; the link completes`.
  - `a failed payment reopens a single-use link`.
  - `an undetermined payment holds the link with "A payment on this link is being checked"`.
  - `a failed-then-corrected success after another success raises the alert`.
  - `a corrected failure of the completing payment reopens the link`.
  - `code step: wrong code decrements attempts; right code succeeds`, against the simulator.
  - `webhook and GET /v1/transactions carry payment_link.code`.
  - `an expired token is 404`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/pay-api src/transactions src/reconciliation src/docs`, then tsc and lint, then the full API suite once. Expected: PASS.
- [ ] **Step 5: Commit.** "Follow a link payment; single-use links never collect twice".

### Task 7: Receipt email

**Files:**
- Create: `apps/api/src/payment-links/receipt.ts`, which holds the mail text in English and French, branded
- Modify: `apps/api/src/pay-api/pay-api.controller.ts`, `apps/api/src/alerts/mailer.ts` (an optional `fromName` on `Mail`, sent as `"<fromName> <MAIL_FROM address>"`)
- Test: `apps/api/src/pay-api/receipt.test.ts`

**Interfaces:**
- Endpoint: `POST /pay-api/v1/payments/:token/receipt` takes `{ email, language?: 'en'|'fr' }`. It is accepted only for a `succeeded` payment, and refused once `receipts_sent >= 3`. It stores `receipts_sent + 1`, `receipt_sent_at` and `receipt_sent_to = mask(email)`, and never the raw address.
- `mask('aicha@gmail.com') === 'a***@gmail.com'`.
- The mail goes out after the response through `Mailer.send({ to, subject, text, fromName: '<Project name> via ProxiaPay' })`. Its body contains the project name, title, reference, date, amount, fees and total, method, the masked number, and "Powered by ProxiaPay".
- The answer is `{ status: 'sent' }`, or `{ status: 'failed' }` when the mailer throws. The page shows "We could not send the email; save the receipt instead."

- [ ] **Step 1: Write the failing tests.**
  - `sends a branded receipt with the sender "<Project> via ProxiaPay"`.
  - `stores only the masked address`: no column or audit row contains the raw email.
  - `refuses a 4th receipt`.
  - `refuses before success`.
  - `a mailer failure answers failed without throwing`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/pay-api src/alerts`, then tsc and lint. Expected: PASS.
- [ ] **Step 5: Commit.** "Receipt by email, in the client's brand, address not kept".

### Task 8: Console, brand and the Payment links tab

**Files:**
- Create: `apps/console/src/pages/PaymentLinks.tsx`, `apps/console/src/pages/Brand.tsx`
- Modify:
  - `apps/console/src/pages/ProjectDetail.tsx`, adding the tab `links`;
  - `apps/console/src/pages/Transactions.tsx` and `list-support.tsx`, adding a "Payment link" filter backed by a `payment_link` query parameter on `GET /console/transactions`, with an API change and its test;
  - `apps/console/src/lib/i18n.ts`.
- Test: `apps/console/src/pages/PaymentLinks.test.tsx`

**Interfaces:**
- **Brand section** (overview tab, owner only, by `has('links.manage')`):
  - logo upload: the file is read as base64 in the browser, refused client-side above 200 KB, and the server re-checks it;
  - two colour pickers, shown with the server's refusal message;
  - a live preview of the page header.
- **Platform route page** (`RouteDetail.tsx`, gated on `routes.open_version`): edits the route's payer instructions in English and French through a small `PUT /console/configuration/routes/:id/payer-instructions` endpoint. It is platform-only, audited as `route.payer_instructions`, and covered by an API test.
- **Links tab:**
  - a list: title, amount or "free, from X", methods, status, payments, total collected;
  - per link: **Copy** URL, QR code (existing `QrCode`), Disable (owner only), and "View payments", which opens `/transactions?payment_link=<id>`.
- **Create form** (owner only, `SubmitForm`):
  - title and description;
  - currency;
  - amount type as a radio (fixed: amount; free: minimum);
  - methods as checkboxes grouped by country, from the project's entitled collection routes in the chosen currency;
  - single use and expiry;
  - brand, prefilled from the project.

- [ ] **Step 1: Write the failing tests (jsdom).**
  - `an owner creates a free link over two countries`.
  - `a developer sees the list but no create or disable`.
  - `copy writes the URL`.
  - `refuses a 201 KB logo before upload`.
  - `the transactions filter sends payment_link`.
- [ ] **Step 2: Run** `cd apps/console && npx vitest run src/pages/PaymentLinks.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit -p .`. Expected: PASS.
- [ ] **Step 5: Commit.** "Console: project brand and payment links".

### Task 9: The payment page

**Files:**
- Create:
  - `apps/console/pay.html`;
  - `apps/console/src/pay/main.tsx`, `apps/console/src/pay/PayApp.tsx`;
  - `apps/console/src/pay/api.ts`, which calls only `/pay-api/v1`;
  - `apps/console/src/pay/country.ts`, `apps/console/src/pay/i18n.ts`;
  - `apps/console/src/pay/pay.css`, using only the tokens from `styles.css` plus the link's colours as CSS variables.
- Modify: `apps/console/vite.config.ts`: `build.rollupOptions.input = { main: 'index.html', pay: 'pay.html' }`.
- Test: `apps/console/src/pay/PayApp.test.tsx`, `apps/console/src/pay/country.test.ts`

**Interfaces:**
- The code is read from `location.pathname` (`/<code>`), so `pay.html` serves every path on the paylink host.
- `detectCountry(available: string[], tz = Intl.DateTimeFormat().resolvedOptions().timeZone, langs = navigator.languages): string`:
  - it maps time zones to countries, with at least `Africa/Douala`→CM, `Africa/Libreville`→GA, `Africa/Brazzaville`→CG, `Africa/Ndjamena`→TD, `Africa/Bangui`→CF, `Africa/Malabo`→GQ, `Africa/Abidjan`→CI, `Africa/Dakar`→SN, `Africa/Bamako`→ML, `Africa/Ouagadougou`→BF, `Africa/Lome`→TG, `Africa/Porto-Novo`→BJ, `Africa/Niamey`→NE;
  - it then tries the region of the language tags (`fr-CM`→CM);
  - it falls back to the first available country.
- **Layout: a web page first** (spec). A centred card about 960 px wide: the client's brand panel on the left (logo, name, title, description, amount, "Paiement sécurisé · Powered by ProxiaPay"), the form on the right. Below 720 px wide, the panel stacks above the form.
- **Screens:**
  1. **Link.**
     - The header shows the logo, project name and colours.
     - Then the title and description, and the amount or an amount field with its minimum.
     - A country selector is shown only when there are 2 or more countries.
     - A method select for the chosen country, then a number field with the prefix.
     - "Continue" calls `/previews`, and is disabled while it runs.
  2. **Review.** Amount, fees, **total to pay**, method and country, number, and how long the total holds. "Edit" goes back; "Confirm and pay <total>" calls `/confirm`.
  3. **Request sent.** "A payment request was sent to <number>. Approve it on your phone, or type the operator's payment code below." Then:
     - the route's `instructions` when present;
     - a code field with its attempts left and expiry when `action.type === 'code'`;
     - an "Open the operator's page" button for `browser`.

     Status is polled every 3 s, backing off to 10 s after 1 min, and stops on a final state.
  4. **Outcome.**
     - **Success:** the receipt (a print stylesheet; a "Save or print" button calls `window.print()`) and an optional email field with "Send me the receipt".
     - **Failure:** the plain reason, plus "Try again" when the link is still usable.
     - **Pending:** "We are checking with the operator; you can close this page."
- The token lives in memory and in `location.hash`, so a reload follows the payment. It never goes in a cookie or localStorage.
- "Powered by ProxiaPay" is the footer. The sandbox band shows when `sandbox` is true.
- Language: French or English from `navigator.languages`, with a toggle.

- [ ] **Step 1: Write the failing tests.**
  - `detects CM from Africa/Douala, falls back to the first country`.
  - `a fixed link goes form → review (total) → confirm → request sent → receipt`.
  - `request sent shows the route instructions and the code field`.
  - `a free link quotes as the payer types`.
  - `no country selector with one country`.
  - `code step submits the code`.
  - `success shows the receipt and sends the email`.
  - `an unavailable link shows the neutral message`.
  - `the page never calls a path outside /pay-api/v1`.
- [ ] **Step 2: Run** `cd apps/console && npx vitest run src/pay`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit -p . && npm run build -w apps/console`, then check that `dist/pay.html` exists and that its bundle imports nothing from `src/pages` or `src/components/table`. Expected: PASS.
- [ ] **Step 5: Commit.** "The payment page: branded, mobile-first, country detected".

### Task 10: Routing and deployment

**Files:**
- Modify:
  - `apps/console/nginx.conf`, adding a `server` block selected by a header Traefik sets on the paylink router (`X-ProxiaPay-Site: paylink`), or a `map` on `$http_host` with the domain in an env-substituted template. That block:
    - serves `pay.html` for every path except `/assets/`;
    - answers 404 for `/v1`, `/console`, `/providers` and `/docs`;
    - sends `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

    The console block never serves `pay.html`.
  - `docker-compose.deploy.yml`:
    - Router `${STACK}-payapi`: rule `Host(${PAYLINK_DOMAIN}) && PathPrefix(/pay-api)`, pointing to the api.
    - Router `${STACK}-paylink`: rule `Host(${PAYLINK_DOMAIN})`, lower priority, pointing to the console, with the header middleware.
    - The existing api router keeps `Host(${APP_DOMAIN})` and does not gain `/pay-api`, so `pay.proxia-digital.com/pay-api` never reaches the api.
  - `deploy/production.env.example` and `deploy/sandbox.env.example`: `PAYLINK_DOMAIN` and `PAYLINK_BASE_URL`, with `paylink.proxia-digital.com` and `sandbox-paylink.proxia-digital.com`.
  - `apps/api/src/docs/production-env.test.ts`.
  - `docs/production-deployment.md`, `docs/sandbox-deployment.md`: migration 0005, the two settings, and the DNS records, which already exist.
  - `docs/client-onboarding.md`: brand and payment links for the owner.
  - `docs/integration-guide.md`: the `payment_link` field.
- Test: extend `apps/api/src/docs/release-config.test.ts`, or create `apps/api/src/docs/paylink-routing.test.ts`.

- [ ] **Step 1: Write the failing tests**, parsing the compose file and nginx.conf as text:
  - `the api router on APP_DOMAIN has no /pay-api`;
  - `the payapi router is Host(PAYLINK_DOMAIN) && PathPrefix(/pay-api)`;
  - `the paylink nginx block refuses /v1 and /console and sends the CSP`;
  - `the console block never serves pay.html`;
  - `both env examples define PAYLINK_DOMAIN and PAYLINK_BASE_URL`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/docs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Check that `docker compose config` renders the routers with sample values: `PAYLINK_DOMAIN=sandbox-paylink.proxia-digital.com docker compose --env-file deploy/sandbox.env.example -f docker-compose.deploy.yml config >/dev/null`.
- [ ] **Step 4: Run** `npx vitest run src/docs`. Expected: PASS.
- [ ] **Step 5: Commit.** "Serve the payment page on its own domain".

### Task 11: Whole-branch verification and local preview

- [ ] **Step 1: Run the full suites.**
  - API full suite (background), tsc and lint.
  - Console tests, tsc and build.
- [ ] **Step 2: Local preview for Valentine,** on a dedicated database, with the console and the pay page on separate local ports. Show three things:
  - a client owner setting the brand and creating a free link over CM and GA;
  - paying it from the page with a simulator number, through the code step;
  - the branded receipt, with the email shown in the API log.
