# Console Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One table component for every list in the console. Long lists are paged by the server with a total, and none is silently truncated. Columns stay narrow, a summary unfolds from the first column, and each row has at most three quick actions.

**Architecture:**

- **Server.** One helper (`paginate`) turns a Kysely query, a sort allow-list and the page query into `{ data, total, page, page_size }`. Every long-list endpoint under `/console/*` returns that shape.
- **Client.** One component (`DataTable`) renders every list in client or server mode. Its state (search, filters, sort, page, page size) lives in the URL through `useTableState`.
- **Pages** declare their columns, summary, actions and filters. Nothing else is per page.

**Tech Stack:** React 19, react-router 7, Vite 6 (console); NestJS 11, Kysely, PostgreSQL 16 (API); Vitest 3.

**Spec:** `docs/superpowers/specs/2026-11-03-console-tables-design.md`. The inventory it cites is in the conversation that produced it; the file and line references below come from it.

## Global Constraints

**Branch**
- Work on branch `feature/console-tables`, cut from `feature/visual-identity` (PR #1, not merged yet).

**Server contract**
- Request params: `page` (1-based), `page_size` ∈ {25, 50, 100}, `sort` (a key from the endpoint's allow-list), `order` ∈ {`asc`, `desc`}, `q`, and the list's own filters.
- Response: `{ data, total, page, page_size }`, plus `scoped` where the endpoint already returns it.
- Rows are ordered by the requested sort, then `id`, with offset/limit paging.
- An unknown `sort`, or a `page_size` outside {25, 50, 100}, is refused with the standard 400 validation error.
- A page past the end returns `data: []` with the true `total`.
- `q` on long lists matches references only, either exactly or by prefix. LIKE wildcards in `q` are escaped.
- `amount` sorts only when a single currency filter is set. Otherwise the response is a 400 that names the reason.
- Remove the console-only cursor parameters: `cursor`, `limit` and `before` on `/console/*`.

**Things that must not change**
- `/v1/*` does not change. `listTransactions` in `project-api/transaction-list.ts` keeps its cursor.
- Permissions, project scoping and confirmation codes stay exactly as today.
- A full payer number never appears in a list URL. Searching by payer number stays behind `transactions.read_identifiers` and is audited once per search.

**Interface**
- The identity holds: black header, states shown as colour + symbol + word, amounts via `Amount`, references in `.mono`, AA contrast, and the `styles.test.ts` checks.
- Each row has at most 3 actions. `Ouvrir` comes first when the item has a page. There is no "⋯" menu.
- Empty states say what would appear and what produces it (spec §3.3). With filters active: "Aucun résultat pour ces filtres", followed by "Retirer les filtres".
- Interface text goes through `i18n.ts`, in both `en` and `fr`.

**Process**
- Migrations go in new files only (`apps/api/migrations/0002_list_indexes.sql`). Existing migrations are never edited (`db/migrator.ts`).
- CI must stay green: `npm run typecheck && npm run lint && npm test && npm run build -w apps/console && npm audit --omit=dev --audit-level=high`.
- No `Co-Authored-By` trailer or "Generated with" line in commits.

## Review Focus

1. **A scoped administrator's counts.** `total` and every page must apply the same project scope as the rows. A count over all projects would reveal volumes the person cannot see. Pinned in Task 2: `scoped total counts only the scoped projects`.
2. **Search text with `%` or `_`** (`txn_` is a real prefix!). It must match literally, not as a wildcard. Pinned in Task 1: `escapes LIKE wildcards in a prefix search`.
3. **A filter that empties the list while you are on page 7.** The component must go back to page 1 and show the filtered empty state, not "page 7 of 0". Pinned in Task 4: `resets to page 1 when a filter changes` and `moves to the last page when the server says the page is past the end`.
4. **A hand-edited or stale URL** (`page=abc`, `page_size=7`, an unknown `sort`). The component must clean its state before requesting, so the person sees a list rather than a 400. Pinned in Task 4: `readTableState ignores invalid values`.
5. **Rows arriving between two page loads** (new transactions). Pages may shift by a row, but a row must never be shown twice within a page and keys stay stable. Pinned in Task 1: `ties broken by id give a stable order`.

---

### Task 1: Server pagination helper

**Files:**
- Create: `apps/api/src/console-api/pagination.ts`
- Test: `apps/api/src/console-api/pagination.test.ts`

**Interfaces:**
- Produces:
  - `pageQuerySchema` (zod): `{ page: number ≥1 default 1, page_size: 25|50|100 default 25, sort?: string, order: 'asc'|'desc' default 'desc', q?: string ≤128 }`.
  - `type PageQuery = z.infer<typeof pageQuerySchema>`.
  - `type Page<T> = { data: T[]; total: number; page: number; page_size: number }`.
  - `paginate<T>(query: SelectQueryBuilder<DB, any, T>, p: PageQuery, opts: { sorts: Record<string, string>; defaultSort: string; id: string }): Promise<Page<T>>`. Here `sorts` maps an allow-listed key to a column reference such as `'t.created_at'`, and `id` is the tie-break column.
  - `prefixPattern(q: string): string`, which escapes `\`, `%` and `_` and appends `%`, for use with `like`.
  - `class SortRefused extends ValidationError`, thrown for a key outside `sorts`, so the existing filter maps it to 400 with `field: 'sort'`.

- [ ] **Step 1: Write the failing tests.** They run against the test database (`createTestContext`) on a scratch table, or on `audit_record` rows inserted by the test.

```ts
it('returns one page, the total, and the page asked for')        // 60 rows, page 2 size 25 → 25 rows, total 60, page 2
it('returns an empty page past the end with the true total')     // page 9 → data [], total 60
it('refuses a sort key outside the allow-list')                  // expect SortRefused
it('ties broken by id give a stable order')                      // 30 rows sharing one created_at: pages 1+2 = 30 distinct ids, no repeats
it('escapes LIKE wildcards in a prefix search')                  // prefixPattern('txn_%') === 'txn\\_\\%%'; a row 'txnA' does not match 'txn_'
it('counts with the same filters as the page')                   // where clause on the query → total reflects it
```

- [ ] **Step 2: Run it**

  `cd apps/api && npx vitest run src/console-api/pagination.test.ts`

  Expected: FAIL, module not found.

- [ ] **Step 3: Implement `pagination.ts`.**
  - **Count:** build it from the same query with selection and ordering cleared, `select(count)`.
  - **Page:** order by `sorts[sort ?? defaultSort]` and then `id`, both in `order`; offset `(page-1)*page_size`; limit `page_size`.

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit.** Message: "Page console lists on the server, with a total".

---

### Task 2: Transactions on the new contract, and the indexes

**Files:**
- Modify: `apps/api/src/console-api/transactions.controller.ts`, around lines 19-88.
- Create: `apps/api/migrations/0002_list_indexes.sql`.
- Create: `apps/api/src/test/console-request.ts`.
- Test: `apps/api/src/console-api/transactions.list.test.ts`.

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - **`GET /console/transactions`**, which accepts today's filters plus `PageQuery`.
    - `sorts`: `{ created: 't.created_at', amount: 't.requested_amount' }`; default `created`.
    - `q`: matches `t.reference`, `t.project_reference`, `a.provider_reference` or `a.operator_reference`, each by prefix.
    - Returns `Page<Row> & { scoped }`.
  - **Export.** `transactions/export` keeps `baseQuery` and its 10,000 cap. Exports are the next project.
  - **Test helper.** `consoleRequest(ctx, opts?: { permissions?: string[]; scope?: string[] | null }): ConsoleRequest`. It builds a request with a real `Authorisation`, so controller methods can be called directly from tests.

- [ ] **Step 1: Write the failing tests.** Call `ctx.app.get(ConsoleTransactionsController).search(query, consoleRequest(ctx))`.

```ts
it('pages transactions with a total and no cursor')            // 30 txns: page_size 25 → 25, total 30; response has no next_cursor
it('sorts by amount only within one currency')                 // sort=amount without currency → 400; with currency=XAF → ordered by requested_amount
it('finds a transaction by the start of its reference')        // q=<first 8 chars of a reference> → that row
it('scoped total counts only the scoped projects')             // two projects, scope=[A] → total = A's count only   (Review Focus 1)
it('refuses a page size outside 25, 50, 100')                  // page_size=7 → 400
```

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`search()`:**
    - remove `cursor`/`limit` from `searchSchema` and merge in `pageQuerySchema`;
    - move the ordering out of `baseQuery`, which `paginate` now owns. The export orders explicitly by `created_at desc, id desc`;
    - add `q`;
    - add the amount-sort rule;
    - return `{ ...await paginate(...), scoped }`.
  - **`0002_list_indexes.sql`:**
    - `transaction (created_at DESC, id DESC)`, for unscoped listing;
    - `transaction (reference text_pattern_ops)`, for prefix search;
    - check `EXPLAIN` on the page and count queries for an unscoped, filtered page;
    - `audit_record (id DESC)` already serves audit, so add nothing there;
    - `alert (raised_at DESC, id DESC)`.

- [ ] **Step 4: Run them.** Expected: PASS. Also run `cd apps/api && npx vitest run`: the whole API suite passes.

- [ ] **Step 5: Commit.** Message: "Page the transaction list with a total, by reference search and sort".

---

### Task 3: Every other long list on the new contract

**Files:**
- Modify (endpoint, then its current limit):
  - `transactions.controller.ts`: `previews` (txC:211, `limit 100`) and `search` (txC:101, caps 50/20).
  - `reconciliation.controller.ts`: `discrepancies` (recC:88 → `discrepancy.service.ts:155`, 100) and `runs` (recC:35 → `reconciliation.service.ts:327`, 50).
  - `treasury.controller.ts`: `transfers` (trC:97, 100), `cashouts` (trC:118, 100), and `float/:id` entries (trC:76, 50; drop `accounts/:id/entries?before=`).
  - `oversight.controller.ts`: `alerts` (ovC:46, 200), `alerts/:id` deliveries (ovC:59, none), `exports` (ovC:176, 100), `audit` (ovC:182, 200 with cursor) and `authentication-history` (ovC:196, 200).
  - `projects.controller.ts`:
    - drop `origin_refusals` and `deliveries` from `GET /projects/:id` (prjC:79, 84);
    - add `GET /projects/:id/origin-refusals` and `GET /projects/:id/deliveries`, both under the permission `GET /projects/:id` needs;
    - drop `activity` (prjC:85). The page reads `/transactions?project=`.
- Test: `apps/api/src/console-api/lists.contract.test.ts`.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces, for each endpoint (`sorts`, then default; `q` targets):

  | Endpoint | `sorts` | Default | `q` matches |
  |---|---|---|---|
  | `previews` | `created` | `created` | reference |
  | `reconciliation/discrepancies` | `detected`, `type` | `detected` | none |
  | `reconciliation/runs` | `started` | `started` | none |
  | `treasury/transfers` | `created`, `amount` | `created` | none |
  | `treasury/cashouts` | `created`, `amount` | `created` | none |
  | `treasury/float/:id` entries | `when` | `when` | none |
  | `oversight/alerts` | `raised`, `severity` | `raised` | none |
  | `oversight/exports` | `created` | `created` | export reference |
  | `oversight/audit` | `when` | `when` | none |
  | `oversight/authentication-history` | `when` | `when` | none |
  | `projects/:id/origin-refusals` | `when` | `when` | none |
  | `projects/:id/deliveries` | `attempted` | `attempted` | none |

  - Treasury `amount` follows the single-currency rule from Task 2.
  - Filters are those in the spec's per-list table, under their existing param names where they already exist.
  - Float entries add `type`, `side`, `after` and `before`.
  - Alerts add `severity` and `category`.
  - Exports add `subject`, `requested_by` and the period.
  - Audit gains `after` and `before` in the UI; the server already has them.
  - Authentication history adds `administrator` and `outcome`.
  - Delivery rows must carry the transaction `reference`, which the replay route needs.
  - The discrepancy row adds `difference` and `recurrences`, which the spec requires as columns.
  - **`search`** returns `{ transactions, previews, capped: boolean }`. Its caps stay as they are, and `capped` reports when one was hit.

- [ ] **Step 1: Write the failing contract test.** It is one parametrised case per endpoint above.

```ts
for (const e of LONG_LISTS) {
  it(`${e.name} returns a page with its total`)       // seed 30 rows → page_size 25 → data.length 25, total 30, page 1
  it(`${e.name} refuses an unknown sort`)             // sort='nope' → 400
}
it('search says when it stopped at its cap')          // 60 matching previews → capped true
it('project detail no longer embeds capped sub-lists') // GET /projects/:id has no origin_refusals, deliveries, activity
```

- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Convert each endpoint**, using `paginate` and the table above. Remove the old `limit(...)` caps and the cursor code.
- [ ] **Step 4: Run it.** Expected: PASS. Then run the full API suite. Expected: PASS.
- [ ] **Step 5: Commit.** Message: "Page every long console list with a total; none stops silently".

---

### Task 4: The DataTable component

**Files:**
- Create: `apps/console/src/components/table/DataTable.tsx`
- Create: `apps/console/src/components/table/table-state.ts`
- Create: `apps/console/src/components/table/client-rows.ts`
- Create: `apps/console/src/components/table/pager.ts`
- Modify: `apps/console/src/styles.css`, for the toolbar, chips, sortable headers, pager, summary row, actions cell and empty state.
- Modify: `apps/console/src/lib/i18n.ts`
- Test: `apps/console/src/components/table/table.test.tsx`

**Interfaces:**
- Consumes: the server contract from Tasks 1-3.
- Produces:
  - `type TableState = { q: string; filters: Record<string, string>; sort?: string; order: 'asc' | 'desc'; page: number; pageSize: 25 | 50 | 100 }`
  - `readTableState(params: URLSearchParams, prefix: string, defaults: { sort: string; order: 'asc' | 'desc'; filterKeys: string[] }): TableState`. It drops invalid values. `prefix` namespaces the params when one page holds several lists, for example `del_` for deliveries.
  - `writeTableState(state: TableState, prefix: string, current: URLSearchParams): URLSearchParams`
  - `useTableState(prefix: string, defaults): [TableState, (patch: Partial<TableState>) => void]`. Any patch that changes `q`, `filters` or `sort`/`order` also sets `page: 1`.
  - `clientRows<T>(rows: T[], state: TableState, cols: Column<T>[]): { rows: T[]; total: number }`. It searches over `col.text(row)` for every column, applies the filters through `filter.match`, sorts by `col.sortValue`, then slices the page.
  - `pageItems(current: number, last: number): (number | '…')[]`. For example `pageItems(5, 49)` gives `[1, '…', 4, 5, 6, '…', 49]`.
  - `type Column<T> = { key: string; label: string; render: (row: T) => ReactNode; text?: (row: T) => string; sortValue?: (row: T) => string | number; sortKey?: string; align?: 'end'; mono?: boolean }`. `sortKey` is the server sort key; sortable in server mode means `sortKey` is set.
  - `type Filter<T> = { key: string; label: string; options: { value: string; label: string }[]; match?: (row: T, value: string) => boolean }`
  - `type RowAction<T> = { label: string; when?: (row: T) => boolean; to?: (row: T) => string; run?: (row: T) => void | Promise<void>; primary?: boolean }`. At most 3 actions are shown; a 4th is a programming error (`console.error` in dev).
  - `DataTable<T>(props: { rows?: T[]; fetch?: (state: TableState) => Promise<{ data: T[]; total: number; scoped?: boolean }>; prefix?: string; columns: Column<T>[]; filters?: Filter<T>[]; actions?: RowAction<T>[]; summary?: (row: T) => ReactNode; rowKey: (row: T) => string; defaultSort: string; defaultOrder?: 'asc' | 'desc'; searchLabel?: string; empty: { none: string; why: string }; bare?: boolean })`
    - **Mode.** Client mode when `rows` is given, server mode when `fetch` is given.
    - **`bare`.** Renders the look only: header, cells and actions, with no toolbar, no footer and no sort. It is for the small ordered tables that stay as they are.
    - **`summary`.** The summary row spans every column. It is also where a `run` action needing a `ConfirmedAction` is rendered, by passing `summary` a second argument `openAction?: string`.

- [ ] **Step 1: Write the failing tests.** Use pure functions plus `renderToStaticMarkup`.

```ts
it('readTableState ignores invalid values')                     // page=abc, page_size=7, order=up → page 1, 25, default order   (Review Focus 4)
it('writeTableState namespaces with a prefix')                  // prefix 'del_' → del_page=2
it('resets to page 1 when a filter changes')                    // useTableState patch {filters} from page 7 → page 1          (Review Focus 3)
it('clientRows searches what is shown, names included')         // a route row with country name 'Burkina Faso' found by 'burkina'
it('clientRows sorts and pages')                                // 60 rows, sort by name, page 3 size 25 → 10 rows, total 60
it('pageItems collapses long ranges')                           // pageItems(5,49) as above; pageItems(1,3) = [1,2,3]
it('shows the total and the range')                             // '1–25 sur 1 204' in fr, '1–25 of 1,204' in en
it('renders a summary toggle as a button with aria-expanded')
it('shows at most three actions, Ouvrir first')
it('explains an empty list, and offers to clear filters when filters are on')
it('moves to the last page when the server says the page is past the end') // fetch returns data [] total 30 at page 3 → requests page 2   (Review Focus 3)
```

- [ ] **Step 2: Run them.** `cd apps/console && npx vitest run src/components/table`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The look follows the mockup `.superpowers/brainstorm/*/content/table-expand.html`.
  - Chips open a small list of options, and an active chip shows its value with a ✕.
  - Sortable headers are `<button>` elements with `aria-sort` on the `<th>`.
  - The pager reads "‹", `pageItems`, "›", then a page-size `<select>`.
  - Strings live in `i18n.ts`: `table.search`, `table.range` ("{from}–{to} sur {total}"), `table.page_size`, `table.no_match`, `table.clear_filters`, `table.retry`, `table.actions`, `table.open`.
- [ ] **Step 4: Run them.** Expected: PASS. Then `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** Message: "One table component for the console".

---

### Task 5: Long lists on DataTable

**Files (pages):**
- `Transactions.tsx`, `Previews.tsx`, `Search.tsx`, `Reconciliation.tsx`, `Treasury.tsx`, `FloatDetail.tsx`, `Oversight.tsx`, `ProjectDetail.tsx`.
- The alert deliveries in `Oversight.tsx:50`.
- Test: `apps/console/src/pages/lists.test.tsx`

**Interfaces:**
- Consumes: Task 4, and Tasks 1-3's endpoints.
- Columns, summaries, actions and filters: exactly as in the spec's "Long lists (server mode)" table.
- **Actions with an existing flow:**
  - `Revérifier` calls the existing force re-check, through the same permission and flow as `TransactionDetail.tsx`.
  - `Acquitter` uses the existing POST.
  - `Agir` links to `action_reference`.
  - `M'attribuer` uses the discrepancy assign endpoint the detail page uses.
  - `Rejouer` POSTs to `/transactions/:reference/notifications/:deliveryId/replay` (txC:204).
- **Transactions page:**
  - it adds the `project` and `provider_account` filters (spec §5.1);
  - it reads `?project=` from the URL, so links from a project page work.
- **Project page:** activity is a `DataTable` over `/transactions` with `project` fixed and prefix `act_`.
- **Float entries:** a row links to `/transactions/<reference>`, no longer to `?q=`.
- **Search page:** when `capped`, it shows "50 premiers résultats ; affinez la recherche", and links out only for reference searches.

- [ ] **Step 1: Write the failing tests.** Render each page with a stubbed `get`, then assert structure:

```ts
it('the transaction list keeps to its columns and folds amounts into the summary') // headers = Référence, Projet, Type, Route, Montant, État, Rapprochement, Créée, Actions; 'Débité' only inside the summary
it('a project page shows its activity filtered to the project')                    // fetch called with project=<id>
it('float entries link to the transaction itself')                                 // href '/transactions/txn_…', never '?q='
it('search says when results stopped at the cap')
it('no list page renders a raw <table> outside DataTable')                         // grep-style test over src/pages: only bare kept tables and the non-list ones named in the spec
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Migrate each page.** Delete the hand-written table code each one replaces.
- [ ] **Step 4: Run them**, then the console suite and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit.** Message: "Put every long console list on the shared table".

---

### Task 6: Short lists on DataTable, and the bare tables

**Files:**
- Client mode: `Projects.tsx`, `Configuration.tsx` (routes, countries), `Treasury.tsx` (float accounts, project balances), `ProjectDetail.tsx` (entitlements, origins), `Approvals.tsx`, `Oversight.tsx` (administrators, roles).
- `bare`: credentials, route bindings, projects with own rates, payment methods, currencies.
- Projects needs `volume_30d` and `value_30d` per project from `GET /console/projects` (prjC:40). Add both there, with one grouped query and no N+1.
- Test: `apps/console/src/pages/short-lists.test.tsx`, plus a projects-endpoint case in `lists.contract.test.ts`.

**Interfaces:**
- Consumes: Task 4.
- Columns, summaries, actions and filters: as in the spec's "Short lists (client mode)" table.
- **Approvals.** `Approuver` and `Refuser` open the summary, which renders today's approve (`ConfirmedAction`) and decline (reason) panel unchanged.
- **Countries.** `Activer`/`Désactiver` opens the summary, which holds today's impact warning and Confirm.
- **Entitlements.** `Désactiver` keeps today's flow.

- [ ] **Step 1: Write the failing tests.**

```ts
it('routes are found by country name')                         // 'burkina' → BF rows (the bug the inventory found)
it('routes filter on every column the spec names')            // chips: country, method, direction, currency, provider, active, indicative
it('projects sort by 30-day volume')
it('approvals keep their code-confirmed decision in the summary')
it('route bindings keep priority order and offer no sort')     // bare
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Migrate.**
- [ ] **Step 4: Run them**, then the console suite, the API suite and the typecheck. Expected: PASS.
- [ ] **Step 5: Commit.** Message: "Put every short console list on the shared table".

---

### Task 7: Look at every list with data large enough to page

**Files:** only those a fix needs. Seed script: `apps/api/src/cli/seed-lists.ts`, dev only, refusing `PROXIAPAY_ENV=production`, which bulk-inserts about 300 transactions, audit records, alerts and discrepancies into a preview database.

- [ ] **Step 1: Start the local preview** as in this session (demo database on 5433, smoke script, `SANDBOX_ANY_SECOND_FACTOR=true`), then run `seed-lists`.
- [ ] **Step 2: Check every list in the browser at 1440 and 1024 px:**
  - the total and range are correct;
  - page 2, the last page and the page size work;
  - sort and filter work, and both reset the page to 1;
  - the summary unfolds;
  - there are three actions at most;
  - the empty state shows, with and without filters;
  - back and refresh keep the state;
  - there is no horizontal page scroll.
- [ ] **Step 3: Repeat the transactions list as a scoped administrator.** It shows only the scoped projects' rows and total.
- [ ] **Step 4: Fix what the visit found**, then run the CI gates. Expected: all pass.
- [ ] **Step 5: Commit.** Message: "Tune the shared table after a pass over every list". Skip the commit if nothing changed.
