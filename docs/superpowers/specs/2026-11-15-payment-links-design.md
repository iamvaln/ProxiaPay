# Payment links

Status: design, awaiting approval · 2026-11-15

## Why

Today a payment through ProxiaPay starts only from the API, with a project's
key and secret. That suits an integrator with developers, like MonJeton. It
rules out three uses:
- a project that wants to be paid without writing code;
- a one-off invoice;
- a payment request sent over WhatsApp.

A payment link closes that gap. Someone on the project's team creates a link
in the console and shares it anywhere. Whoever opens it lands on a ProxiaPay
payment page, picks one of the payment methods the link allows, and pays.

The functional specification (`docs/spec/functional-specification.md` §1.3)
lists "Customer-facing checkout pages" as out of scope. This design reverses
that, deliberately, as the client-accounts design did for the merchant
dashboard.

## Decided by Valentine

- **Payment links come before partner withdrawals.**
  - Withdrawals are a separate project, designed next. They cover two paths:
    a direct mobile-money payout, or a bank-transfer request that Valentine
    pays and records in the console.
  - They also cover a working-capital account that Valentine replenishes, and
    reconciliation of "provider floats + working capital" against what the
    platform owes.
  - Until that project ships, money collected through links stays in the
    project's balance, as it does for any collection.
- **The payment page is a small dedicated page, separate from the console**
  (approach B below), served from its own subdomain:
  - production: `https://paylink.proxia-digital.com/<code>`;
  - sandbox: `https://sandbox-paylink.proxia-digital.com/<code>`.

## Approaches considered

- **A. A route inside the console app.** The fastest to build. It was
  rejected because the payer would download the whole admin console for a
  three-field page on a mobile connection, and an admin tool would share a
  public surface.
- **B. A dedicated page, built as a second Vite entry and served by the
  console's container on its own domain.** **Chosen.** The page is small and
  mobile-first, shares no code path with the console, and costs no new
  container or release step.
- **C. HTML rendered by the API.** The lightest page possible. It was rejected
  because it puts templates in the API, handles the payer's extra steps
  (code, redirect) and live status badly, and reuses none of the visual
  identity.

On top of B, Valentine chose a separate subdomain rather than a `/pay/` path on
`pay.proxia-digital.com`. The page then runs on another origin than the
console. A defect in the public page can never reach an administrator's
session, and the link reads well in a message.

## Goals

1. **Create a link from the console.** A project's team creates a link from
   the project page, in a new "Payment links" tab. A link holds:
   - a title, for example "Abonnement Pro – novembre";
   - an optional description;
   - an **amount type**, chosen by the creator (Valentine, 2026-11-15):
     - **fixed**: the creator sets the amount and the payer cannot change it;
     - **free**: the payer types the amount, for a donation for example. The
       creator may set a **minimum**, which defaults to 0. The route's own
       minimum and maximum still apply, so the effective floor is the higher
       of the link's minimum and the route's.
   - one currency;
   - **one country** (*my call*). A route is a country, an operator and a
     currency, so MTN in Cameroon and MTN in Côte d'Ivoire are two routes. One
     country per link keeps a single phone prefix on the page and makes a
     method code unambiguous;
   - the **payment methods it allows**, chosen among the project's active
     collection routes in that country and currency;
   - an optional expiry date;
   - **reusable** (the default) or **single use**.
2. **Share it.**
   - The console shows the URL with a **Copy** button and a QR code, using
     the existing `QrCode` component.
   - A link can be disabled at any time.
3. **Pay from the page.** Whoever opens the link sees:
   - the project's name, the title and the amount;
   - per method, **what the payer will be charged**: when fees are borne by
     the payer, the charged amount includes them.

   The payer then:
   - picks a method;
   - enters their number;
   - pays;
   - completes the extra step if the route asks for one: a code typed on the
     page, or a redirect to open.

   The page follows the payment to its outcome: succeeded, failed, or still
   pending with a "we are checking with the operator" message.
4. **An ordinary transaction.** Each payment is a normal transaction of the
   project:
   - it counts against the entitlement's limits;
   - it is visible in the console and filterable by link;
   - it sends the usual webhook;
   - it carries the link it came from.
5. **Per-link figures.** The console shows each link's payments: count, total
   collected, last payment.
6. **The sandbox is marked.** The sandbox page says plainly that no real money
   moves, and works with the simulator's test numbers.

## Non-goals

- Partner withdrawals (next project).
- Receipts by email or SMS. The page's final screen shows the reference.
- A per-client logo or colours, or custom domains.
- Disbursement links.
- Card or bank payment.
- Shopping carts, quantities and multiple items.

## Anti-goals

- **The page must not become a way to spam payment requests** at someone
  else's number. Requests are rate-limited per number, per address and per
  link.
- **The page must never expose project credentials, internal ids or
  ProxiaPay's economics**: provider, provider fees, margin. It shows only what
  the payer is charged.
- **A single-use link must never collect twice.**
- **A link must not let anyone pay into a project that cannot take money.**
  - A link refuses payments when it is disabled or expired, when the project is
    suspended, or when the route or entitlement is inactive.
  - The page says so in plain words, and a method that is no longer available
    disappears from it.

## The shape

### Data (migration `0005`)

**New `payment_link` table:**
- `id`;
- `code`: 10 random base62 characters, unique, used in the URL;
- `project_id`, `title`, `description`;
- `amount` (minor units), `currency_code`;
- `single_use`, `expires_at`;
- `status`: `active`, `disabled` or `completed`;
- `created_by`, `created_at`, `updated_at`.

**New `payment_link_route` table**, listing the routes a link allows.

**`transaction.payment_link_id`.** Link payments have no credential. How the
transaction records its origin is left to the builder; the constraint is that
every transaction says whether it came from a credential or from a link.

**New permission `links.manage`**, "Create and disable payment links", granted
to:
- `Owner`;
- `Configuration`;
- `Client owner`;
- `Client developer`.

Reading links falls under `projects.read`.

### Creating a link (console API)

- **Endpoints**, under `/console/projects/:id/payment-links`: `GET` list, `POST`
  create, `POST :lid/disable`, and `GET :lid` for detail with its payments.
  - All are client-accessible.
  - All check project reach with their own permission.
  - All bind `:lid` to `:id`, the same rules as other project sub-resources.
- **Validation at creation:**
  - a fixed amount sits within every chosen route's minimum and maximum;
  - a free link's minimum, when set, is not above any chosen route's maximum;
  - each route is an active collection route the project is entitled to, in
    the link's country and currency;
  - at least one route is chosen.
- **Audit:** creating and disabling a link are audited.

### Paying (public API)

The public routes live under `/pay-api/v1`. There is no session and no
credential, and nothing else in the API is reachable from the paylink domain.

- **`GET /pay-api/v1/links/:code`** returns what the page shows:
  - the project's name, the title and the description;
  - the amount type: the amount for a fixed link, or the minimum for a free
    one;
  - the currency and its exponent, and the country with its dialling prefix;
  - for each method: its code, its name, its own minimum and maximum, and
    whether a code or redirect step follows. For a fixed link, each method
    also carries the **charged amount**;
  - a sandbox flag.

  A disabled, expired, completed or unknown link answers one neutral "This
  link is no longer available", whatever the cause.
- **`POST /pay-api/v1/links/:code/quote`** takes `{ payment_method, amount }`
  on a free link. It answers the charged amount and the fees borne by the
  payer, computed as a preview would, without creating anything. The page
  calls it as the payer types. Its rate limit is that of reading a payment.
- **`POST /pay-api/v1/links/:code/payments`** takes
  `{ payment_method, msisdn }`, plus `amount` on a free link. A free link
  refuses an amount below the effective floor or above the route's maximum,
  with a plain message.
  - It creates the preview and confirms it in one step, server side, as the
    project would.
  - The project reference is generated as `PL-<code>-<unique suffix>`.
  - It returns an opaque **payment token**: random, stored hashed, valid 24 h.
    The page uses the token to follow the payment.
- **`GET /pay-api/v1/payments/:token`** returns:
  - the state and the extra step, if any (a code with its attempts left, or a
    URL to open);
  - the final outcome;
  - the transaction reference.
- **`POST /pay-api/v1/payments/:token/code`** sends the payer's code, through
  the same path as `POST /v1/transactions/:reference/code`.
- **Single use: never collect twice** (Valentine, 2026-11-15).
  - A single-use link accepts one payment at a time. Any payment that is not
    final holds the link, `undetermined` included, even if reconciliation
    takes days. A second payer gets "A payment is already in progress on this
    link" (for `undetermined`: "A payment on this link is being checked").
  - On success, the link becomes `completed`. On a final failure or expiry, it
    opens again.
  - If a correction later turns a failed payment into a success while another
    payment on the same link has already succeeded, an alert (category
    `treasury`, title "Single-use link collected twice") tells Valentine, who
    settles it by hand. Refunds do not exist yet.
  - If a correction turns the success that completed the link into a failure,
    the link opens again.
  - The transaction state changes that matter here (success, final failure,
    correction) update the link in the same database transaction as the state
    change.
- **Rate limits** (*my call*, values to tune):
  - creating a payment: 5 per minute per address, 3 per 10 minutes per number,
    30 per minute per link;
  - reading a payment: 60 per minute per token.

  A limited caller gets HTTP 429 with a plain message. These limits reuse the
  existing PostgreSQL-backed fixed-window limiter
  (`apps/api/src/project-auth/rate-limiter.ts`), which takes a window length
  and is already pruned by the worker.
- **Public surface.** These routes are public, so they skip `SessionGuard` and
  `ProjectAuthGuard`, and none is reachable from `pay.proxia-digital.com`.
  The project's origin rule does not apply: the call comes from ProxiaPay
  itself, not from the project.

### The webhook and the public API

- The transaction resource gains an optional `payment_link: { code }`
  (*my call*). It appears in `GET /v1/transactions/:reference` and in webhook
  payloads.
- The change is additive, so existing integrations are unaffected.
- The API reference and the OpenAPI files document it.

### The page

- **Build.** A second Vite entry (`pay.html`) in `apps/console`, with its own
  small bundle.
  - It shares no module with the console except the brand assets and
    stylesheet tokens.
  - It loads no third-party script and no web font from outside, the same rule
    as the console.
- **Routing.** Traefik routes `Host(PAYLINK_DOMAIN)` to the console container,
  except `PathPrefix(/pay-api)`, which goes to the api container.
  - The console's nginx serves `pay.html` for every path on that host. A
    `server_name` block, or a header Traefik sets, tells the two hosts apart;
    the builder chooses.
  - `pay.proxia-digital.com` never serves `pay.html`, and the paylink host
    never serves the console.
- **Security headers on the page:**
  - a strict CSP: same origin only, no inline script;
  - `frame-ancestors 'none'`;
  - `Referrer-Policy: no-referrer`.

  The payment token lives only in the page's memory and URL fragment, never in
  a cookie.
- **Language.** French or English, from the browser's language, with a
  toggle.
- **Screens.**
  1. **The link:** project, title, the amount (or an amount field with its
     minimum on a free link), methods with what the payer will be charged,
     number field with the country prefix.
  2. **Waiting for the payer to approve on their phone**, or the extra step:
     a code field, or an "Open the operator's page" button.
  3. **Outcome:**
     - success, with the reference;
     - failure, with a reason in plain words, and "try again" if the link is
       still usable;
     - pending, with "we are checking with the operator; you can close this
       page".
- **Sandbox.** The page shows a visible "Sandbox — no real money moves" band,
  the same environment marker as the console.

### Console

- **A "Payment links" tab on the project page:**
  - a list with title, amount (or "free, from X"), methods, status, payments
    and total collected;
  - a create form;
  - per link: Copy, QR code, Disable, and a link to its payments.
- **Transactions list:** a "Payment link" filter.
- **Wording.** Client accounts see the same tab, with the client wording rules
  already in place: no provider names.

### Configuration and deployment

- **New settings:**
  - `PAYLINK_BASE_URL`, used to build the links shown in the console;
  - `PAYLINK_DOMAIN`, the Traefik host.

  Both are set per environment. Without them, link creation is refused with a
  configuration error.
- **DNS.** Valentine creates `paylink` and `sandbox-paylink` A records on
  Cloudflare, with the grey cloud, pointing at `77.237.234.91`. Traefik
  obtains the certificates.
- **Docs.** The deployment docs gain the settings and the DNS records.

## Constraints

- Same codebase and migrations for the sandbox and production.
- `proxiapay_app` is granted the new tables.
- Everything a link payment does goes through the existing preview,
  confirmation, submission and ledger paths. No second payment path.
- Console and page copy are in English and French.

## Left to the builder

- How a link transaction records its origin, and how the project principal is
  built for a link.
- How nginx tells the two hosts apart.
- The rate limiter's implementation.
- The page's visual design, within the existing visual identity
  (`docs/superpowers/specs/2026-11-02-proxiapay-visual-identity-design.md`).
- How the page follows the payment: polling interval and back-off.
