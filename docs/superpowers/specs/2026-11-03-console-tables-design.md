# One table for the whole console

Status: design, awaiting approval · 2026-11-03 · first project of the console's UX review

## Why

The console has 44 tables across 15 screens, and each one is written by hand in
its page. They behave differently. Only the transaction list pages, and only
forwards. One table has a text filter, and nothing sorts. Twelve lists that
grow without limit are **cut off without saying so**: the endpoint returns the
latest 20 to 200 rows, and the page shows them as if that were everything.
Among them are the audit trail, alerts, discrepancies, float transfers and
cashouts.

In a payment console, that is how an operator misses a discrepancy or an
alert. The console specification already asks for better (§3.3, line 121):
*"Tables carry filters appropriate to their content, sort on their significant
columns, paginate, and export…"*

The table inventory behind this document lists every table with file and line,
endpoint, growth and current limit. It was taken on branch
`feature/visual-identity` on 2026-11-03.

## Goals

- **One table component** for every list in the console, with the same look
  and behaviour everywhere.
- **No list ever shows part of itself as if it were the whole.** Every list
  either shows all its rows, or pages through them and says how many there are.
- **Narrow lists.** Columns carry what helps scan and sort. The rest of an item
  is one click away in a summary that unfolds in place, and everything else is
  on the item's own page.

## Non-goals

- **Exports.** CSV on more tables, the spreadsheet format, and removing the
  10,000-row cap on the transaction export are the next project.
- **The home dashboard.** It gets its own redesign later.
- **Tables that are not lists stay as they are:**
  - the ledger T-accounts on a transaction;
  - the postings preview on a discrepancy;
  - the home cards;
  - the reporting pivot;
  - the health measures (success rates, failure reasons).
- **The project-facing API.** `GET /v1/transactions` keeps its cursor contract.
  Integrators depend on it. Only `/console/*` endpoints change.

## Anti-goals

These count as failures even if everything works:

- A list that stops at N rows without saying so.
- A list as wide as the old ones, with every amount and fee in its own column.
- A row with a wall of buttons.
- A quick action that skips the confirmation code the same action asks for on
  the detail page.

## What Valentine decided

1. **Long lists show their total and numbered pages.** For example
   "1–25 sur 1 204", previous, numbered pages, next, and a page size of 25, 50
   or 100. This was chosen over Previous/Next without a total, knowing that
   counting costs a little on large tables.
2. **An Actions column, last, with at most three quick actions per row.**
   Everything else is done from the item's detail page. There is no "⋯"
   overflow menu.
3. **Columns only for what helps scan and sort**, such as type, state, route,
   date and the one amount that matters. In Valentine's words: *"the
   information like type and status is more relevant than seeing every line of
   amounts and fees."*
4. **A ▸ on the first column unfolds a quick summary of the item**, for example
   amounts charged and settled, fees, payer and references for a transaction.
5. **The look is the identity's**: black header with white uppercase labels,
   search box, filters as chips (black when active, with a ✕), and ▲▼ on
   sortable headers. The mockups are `.superpowers/brainstorm/*/content/table-component.html`
   and `table-expand.html`. They are not committed.

## The component

### Two modes, one look

- **Client mode** is for lists bounded by configuration: routes, countries,
  providers, roles, administrators… The page loads the whole list. Search,
  filters, sort and pagination run in the browser, and the total is always
  known.
- **Server mode** is for lists that grow over time. Each page is a request, and
  the server filters, sorts, counts and returns one page.

Whichever mode a list uses, it looks and reads the same.

### Behaviour, both modes

- **Search** matches the text a person sees, names included, not only codes.
  Typing "Burkina" finds Burkina Faso, which today's route filter does not.
- **Filters** are chips. "+ État" opens the choice. An active chip shows its
  value with a ✕. Each list declares its own filters (see the table below).
- **Sort:**
  - clicking a sortable header sorts by it, and clicking again reverses;
  - one column at a time;
  - every list has a default sort;
  - ties are always broken by id, so pages never overlap or skip rows.
- **Pagination:**
  - "1–25 sur 1 204", ‹, numbered pages with ellipses, and ›;
  - page size of 25 (default), 50 or 100;
  - changing a filter, the search or the sort returns to page 1.
- **The summary row:**
  - ▸ in the first column, a real `<button>` with `aria-expanded`;
  - opening it inserts a full-width row below, holding a grid of labelled
    values;
  - several rows can be open at once;
  - a list without a summary has no ▸ column.
- **The Actions column:**
  - last and right-aligned, with at most three actions;
  - **Ouvrir** comes first whenever the item has a page;
  - which actions show depends on the row's state. Refund appears only on a
    succeeded collection, for example;
  - an action that needs a confirmation code runs the same `ConfirmedAction`
    flow as on the detail page, inside the row's summary, opened for the
    purpose;
  - a list where nothing can be done has no Actions column.
- **State in the URL.** Search, filters, sort, page and page size live in the
  query string. That makes three things work:
  - back and refresh keep your place;
  - a link can open a filtered list. `/transactions?project=…` from a project
    page, for instance, which today's Transactions page ignores;
  - a list can be shared.

  This is my call.
- **Empty, loading and error states:**
  - each list says what would appear there and what produces it, as spec
    §3.3 asks. For example: "Aucune alerte ouverte. Les alertes naissent des
    contrôles de rapprochement, de couverture et de santé." With filters on,
    it reads "Aucun résultat pour ces filtres", plus "Retirer les filtres";
  - a quiet loading line, with no layout jump;
  - an error line with "Réessayer".
- **Permissions and scope.** `ScopeNote` stays above a list whose results are
  narrowed by the administrator's scope. Actions an administrator cannot take
  are not shown.
- **Width.** The table still scrolls inside its card or the main column when
  the viewport is too narrow (the identity's rule). With narrow lists, that
  should be rare.

### Server contract, for every list endpoint in server mode

**Request** (query string):

| Param | Meaning |
|---|---|
| `page` | 1-based |
| `page_size` | 25, 50 or 100. Any other value is refused with the usual 400 validation error |
| `sort` | A column key from the endpoint's allow-list |
| `order` | `asc` or `desc` |
| `q` | Search text |
| other params | The list's own filters, named as today where they already exist |

**Response:**

```json
{ "data": [], "total": 1204, "page": 2, "page_size": 25, "scoped": false }
```

`scoped` appears only where it does today.

**Rules:**

- Pages are offset/limit over a stable order: the requested sort, then `id`.
- `total` is a `count(*)` over the same filters.
- A page past the end returns `data: []` with the true `total`. The component
  then moves to the last page.
- An unknown `sort` key is refused with 400.
- **Search (`q`) on the long lists matches references, exactly or by
  prefix**: transaction, preview and export references, provider and operator
  references. These stay index lookups, with no new database extension. Names
  are reached through the filter chips instead (project, country, provider
  account…), which the chips offer by name.
- **Search on the short lists**, done in the browser, matches every word a
  person sees, names included.

  This split is my call. Trigram search on names over millions of rows would
  need `pg_trgm` in production. That can come later if prefix plus filters
  proves too little.
- **Amount sorts only within a single currency.** On a list that mixes
  currencies, the amount header becomes sortable once a currency filter is set,
  and otherwise says why it isn't. Sorting raw minor units across XAF and USD
  means nothing. My call.
- One helper does this for every endpoint, from the query, the allow-list and a
  base Kysely query, so twelve endpoints don't each reimplement it.
- The existing cursor parameters on console endpoints (`cursor`, `before`, the
  audit's numeric cursor) are removed. They are console-only, and the console
  is their only client.

## Every list: mode, columns, summary, actions

These are my calls unless marked. Valentine reviews them here. "Sort" lists
the sortable columns, and the first one named is the default.

### Long lists (server mode)

| List (page) | Columns | Summary (▸) | Actions (≤3) | Filters | Sort |
|---|---|---|---|---|---|
| **Transactions** (Transactions) | reference, project, type, route, amount (requested), state, reconciliation, created | charged to payer, received by project, fees and bearer, payer (masked), provider and its reference, operator reference, terminal time, last event | Ouvrir · Revérifier (submitted, processing, undetermined) | spec §5.1: state, reconciliation, direction, project, country, payment method, provider account, currency, period, amount range, failure reason | created ▼, amount |
| **Previews** (Previews) | reference, project, route, amount, payer (masked), status, created | fees, expiry, payer action | Ouvrir la transaction (when one exists) | status, project, period | created ▼ |
| **Discrepancies** (Reconciliation) | type, subject, provider account, difference, status (with a *recurred ×N* tag beside it when it recurred, spec §9.3 *"shown prominently"*), assignee, detected | expected and observed amounts, runs seen, notes | Ouvrir · M'attribuer | spec §9.3: run, type, status, assignee, provider account, recurred | detected ▼, type |
| **Runs** (Reconciliation) | provider account, period, status, discrepancies, started | finished at, counts by type, who started it | Ouvrir (the discrepancies of that run) | provider account, status, period | started ▼ |
| **Float transfers** (Treasury) | from → to, amount, status, created | path, confirming run, references, administrators | none | status, account, period | created ▼, amount |
| **Cashouts** (Treasury) | float account, amount, status, requested by, created | destination reference, approvals with both administrators, confirmation | none | status, account, period | created ▼, amount |
| **Float entries** (FloatDetail) | when, type, side, amount | posting id, memo, related transaction | Ouvrir la transaction | type, side, period | when ▼ |
| **Alerts** (Oversight) | severity, title, subject, raised, occurrences, status | last seen, deliveries, what it addresses | Ouvrir · Acquitter (open) · Agir (the alert's action link) | status, severity, category, period | raised ▼, severity |
| **Export history** (Oversight) | export reference, subject, requested by, rows, created | filters recorded, environment, signature | none | subject, requested by, period | created ▼ |
| **Audit** (Oversight) | when, actor, action, subject | the change, before → after (today's JSON diff) | none | spec §10.7: actor, subject type, period | when ▼ |
| **Authentication history** (Oversight) | when, administrator, event, outcome, address | client description | none | administrator, outcome, period | when ▼ |
| **Origin refusals** (ProjectDetail) | when, address, credential | request id | none | period | when ▼ |
| **Notification deliveries** (ProjectDetail) | event, transaction, status, attempts, last attempt | response code and body excerpt, next retry | Rejouer (spec §6.2) | status, event | last attempt ▼ |
| **Project activity** (ProjectDetail) | the Transactions list, filtered to the project | as Transactions | as Transactions | as Transactions | as Transactions |

**Notes on these lists:**

- **New endpoints.** Origin refusals and notification deliveries become their
  own paginated endpoints, `/projects/:id/origin-refusals` and
  `/projects/:id/deliveries`. Today they are a fixed 20 and 25 inside
  `GET /projects/:id`.
- **Project activity** reuses the transactions endpoint and component, with the
  project filter fixed.
- **Search results** (Search) stays a results page, not a list. When the
  lookup returns more than its cap, the page says so ("50 premiers résultats ;
  affinez la recherche"). That removes the silent truncation without paging a
  search.

  A payer-number search stays where it is: behind
  `transactions.read_identifiers`, through the blind index, audited once per
  search. It doesn't link out, so a full phone number never lands in a list
  URL.
- **Alert deliveries** on an alert's page get a limit and the same component.

### Short lists (client mode)

| List (page) | Columns | Summary (▸) | Actions (≤3) | Filters | Sort |
|---|---|---|---|---|---|
| **Projects** (Projects) | name, code, status, volume over 30 days, created | value over 30 days, balances per currency, routes granted, credentials | Ouvrir | status | name ▲, volume, created |
| **Routes** (Configuration) | country, method, direction, currency, provider, active | fees and bearers, limits, indicative or contracted, 30-day volume | Ouvrir | spec §7.2 *"filters on every column"*: country, method, direction, currency, provider, active, indicative | country ▲, method, volume |
| **Countries** (Configuration) | name, code, currency, active | routes in the country, impact of deactivating | Activer or Désactiver (today's impact warning, then confirm) | active | name ▲ |
| **Float accounts** (Treasury) | provider, country, currency, direction, cover band, balance | free liquidity, open disbursements, recent outflow, cover hours | Ouvrir | band, currency, direction | cover ▲ (spec §8.2) |
| **Project balances** (Treasury) | project, currency, available, reserved | none | Ouvrir le projet | currency | project ▲ |
| **Entitlements** (ProjectDetail) | route, active, version | limits, velocity caps, fee overrides, bearers, version history | Désactiver (today's flow) | active | route ▲ |
| **Declared origins** (ProjectDetail) | address range, description, added | none | Retirer | none | added ▼ |
| **Approvals** (Approvals) | request, subject or amount, requested by, waiting | the decision panel of today's expansion: approve with code, or decline with reason | Approuver · Refuser (both open the summary) | type | waiting ▼ |
| **Administrators** (Oversight) | name, email, status, last sign-in | roles (each removable, today's flow), language, time zone | Désactiver or Réactiver | status, role | name ▲ |
| **Roles** (Oversight) | name, members, permissions | the permission list | Modifier | none | name ▲ |

**Notes on these lists:**

- **Kept as they are**, ordered and too small to need search or paging:
  - credentials on a project, a rotation sequence with its own three actions,
    no sort;
  - route bindings, ordered by priority, which must not be re-sorted;
  - projects with their own rates;
  - payment methods;
  - currencies;
  - **providers**, which stay cards: each card carries suspend and restore, and credential replacement behind a code, and there is no provider page to move those to. A provider page belongs to a later project.

  They take the component's look (header, cells, Actions column) without the
  toolbar or footer.
- **Approvals.** "Approuver" and "Refuser" both unfold the row's summary,
  where the decision is made. That keeps the confirmation code and the decline
  reason exactly as today.

## Answers to the builder check

The builder check raised six questions. Five are settled above as my calls:

- **Discrepancies keep their difference column and a prominent recurrence tag.**
  The spec asks for both, and the difference is the one amount that matters
  there.
- **Transactions keep a reconciliation column**, because it is a status. The
  terminal time goes into the summary.
- **Projects show 30-day volume**, which the spec asks for and which helps
  sort.
- **Providers stay cards.**
- **Payer numbers never enter list URLs.**
- **Search on long lists matches references, and amount sorts only within one
  currency.**

The sixth, refunds, was Valentine's call. See the last section.

## Found during the inventory, fixed here

These all touch the lists above:

- **Float entries.** The link to a transaction goes to `/transactions?q=…`,
  which the Transactions page ignores. The new link opens the transaction.
- **Transactions.** The page drops the `project` and `provider_account`
  filters that the endpoint supports, and that spec §5.1 lists. The page will
  offer both.
- **The audit page ignores `next_cursor`, and authentication history returns
  none.** Both are superseded by the server contract above.
- **Notification deliveries have no replay button on the project page**,
  though spec §6.2 asks for one. It becomes that list's quick action.

The health tables' broken "departed → transactions" link (Oversight.tsx:57) is
left for the dashboard and oversight redesign.

## Constraints

- **Kysely on PostgreSQL 16.** `count(*)` with the same filters as the page
  query.
- **Indexes.** The builder checks the sort and filter columns of the
  transactions, audit and alerts tables against existing indexes, and adds what
  a page query needs to stay an index scan.
- **No change to `/v1/*`.**
- **Permissions and scoping** stay exactly as each endpoint applies them today.
  `scoped: true` keeps showing `ScopeNote`.
- **Confirmation codes** stay exactly where they are required today.
- **The identity's rules hold:**
  - black header;
  - states as colour, symbol and word;
  - amounts with their currency set smaller;
  - references in IBM Plex Mono;
  - AA contrast;
  - the `styles.test.ts` checks.
- **CI's existing gates pass:** typecheck, lint, both test suites, the console
  build and the audit.

## Left to the builder

- The component's API in React: column definitions, the summary renderer, the
  action definitions, mode.
- How each server endpoint builds its search over the fields it shows.
- Styling details within the identity: chip menu, pager, empty state.
- The order of migration across pages, as long as each commit leaves every
  page working.
- How to verify. The minimum:
  - each list viewed in the browser on demo data large enough to page (the
    smoke script plus generated rows);
  - a test that no server-mode endpoint returns a page without `total`;
  - a test that past-the-end and unknown-sort requests behave as above.

## Refunds

The transaction page's "Initiate refund" button has no action behind it
today (`TransactionDetail.tsx:84`), and the console has no refund. Valentine
decided that refunds will be designed as their own flow, started from the
transaction's detail page and never as a quick action in a list. The button
stays where it is, as that flow's entry point. Building the flow is a separate
project that follows this one. Functional specification §5.3 already gives its
model: a disbursement referencing the original collection, returning what the
project received, with no fees of its own.
