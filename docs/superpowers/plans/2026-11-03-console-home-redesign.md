# Console Home Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the console home's eight equal cards with a verdict, four headline figures, a 24-hour success-rate chart per route, "Waiting on you" and a business line.

**Architecture:** The API keeps one endpoint, `GET /console/home`, whose `cards` object is reshaped. Its queries move out of `HomeController` into a new `HomeService`; the decisions that need no database (alert grouping, the departing rule) live in pure functions in `home.logic.ts`. The console rewrites `Home.tsx` from small pieces: verdict wording and chart geometry are pure functions under `src/lib/`, rendered by two components. The chart is hand-drawn SVG; no chart library.

**Tech Stack:** NestJS + Kysely on PostgreSQL 16, Vitest (API, against the test database on port 5433); React 19 + Vite, Vitest with `renderToStaticMarkup` (console).

**Spec:** `docs/superpowers/specs/2026-11-03-console-home-redesign-design.md`. Read it first; this plan does not repeat its reasons.

## Global Constraints

- The unit of health is the route (`route.id`: country × payment method × direction). No query, figure, chart line or tooltip merges routes of one operator across countries.
- Never sum different currencies into one figure; every money figure is per currency.
- Platform revenue and margin stay two figures; a negative margin is shown in the refused colour, never folded.
- Every block, and every verdict problem, is gated by the permission behind its own data, with that permission's scope applied (spec, "Permissions and scope").
- "Today" is `date_trunc('day', now())`, as the existing home queries use.
- Every new console string goes through `t()` with `en` and `fr` (console spec 3.3).
- Colours come from custom properties in `apps/console/src/styles.css`, named for meaning. Operator colours: MTN MoMo `#2a78d6`, Orange Money `#eb6834`, Moov `#1baf7a`, Wave `#eda100`, Airtel `#e87ba4`, Free `#008300`, M-Pesa `#6250d6`.
- No new runtime dependency in either app.
- Commit messages carry no Claude attribution (no `Co-Authored-By`, no "Generated with").

## Review Focus

1. **A route with an open health alert but a small sample** must still be drawn as a line, because the verdict names it. Pinned in Task 1 (`isDeparting` with `alerted: true`, sample 12).
2. **A project-scoped administrator** must not see other projects' transactions in the success rate, the chart, "collected today" or "no known outcome". Pinned in Task 2 (`scoped to one project`).
3. **An administrator who can see no verdict source** gets no verdict block, not "everything is running normally". Pinned in Task 3.
4. **Hours with fewer than 5 terminal transactions** have no point, and the line breaks there instead of drawing a false 0 % or 100 %. Pinned in Task 5 (`points` returns `null`).
5. **"Collected today" with nothing collected last week** shows no comparison rather than "+∞ %" or "−100 %". Pinned in Task 4 (`changeVsLastWeek`).

---

### Task 1: Verdict grouping and the departing rule (pure)

**Files:**
- Create: `apps/api/src/console-api/home.logic.ts`
- Test: `apps/api/src/console-api/home.logic.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AlertRow { id: string; severity: 'informational' | 'warning' | 'critical'; category: string; subject_type: string; subject_reference: string; fingerprint: string; title: string; action_reference: string; raised_at: Date }
  export interface Problem { severity: 'warning' | 'critical'; kind: string; subject_type: string; subject_reference: string | null; subject_name: string | null; count: number; since: string; title: string; link: string }
  export function alertKind(fingerprint: string): string
  export function groupProblems(alerts: AlertRow[], names: Map<string, string>): Problem[]   // names keyed by `${subject_type}:${subject_reference}`
  export const DEPARTING = { margin: 0.05, minSample: 20 } as const
  export function isDeparting(r: { current: number | null; baseline: number | null; sample: number; alerted: boolean }): boolean
  ```

- [ ] **Step 1: Write the failing tests** in `home.logic.test.ts` (plain Vitest, no database):

  ```ts
  it('names the kind by the fingerprint prefix, keeping the dimension of a health alert', () => {
    expect(alertKind('undetermined:1b2c')).toBe('undetermined');
    expect(alertKind('health:success_rate:route:9f0e')).toBe('health:success_rate:route');
    expect(alertKind('coverage_ratio:XOF')).toBe('coverage_ratio');
  });
  it('groups per-transaction alerts into one problem, keeps one problem per route', () => {
    // 12 undetermined alerts (two critical), two route health alerts on different routes, one informational
    const p = groupProblems(alerts, new Map([['route:r1', 'Orange Money CI · collection'], ['route:r2', 'MTN MoMo CM · collection']]));
    expect(p.map((x) => [x.kind, x.count, x.severity])).toEqual([
      ['undetermined', 12, 'critical'],
      ['health:success_rate:route', 1, 'warning'],
      ['health:success_rate:route', 1, 'warning'],
    ]);
    expect(p[1]!.subject_name).toBe('Orange Money CI · collection'); // older alert first within a severity
    expect(p.some((x) => x.kind === 'approval')).toBe(false);       // informational never feeds the verdict
  });
  it('orders critical before warning, then oldest first, and dates a group from its oldest alert', ...);
  it('falls back to the subject reference when no name is known', ...);
  it('marks a route departing on an open alert, whatever its sample', () => {
    expect(isDeparting({ current: 0.5, baseline: 0.97, sample: 12, alerted: true })).toBe(true);
  });
  it('marks a route departing 5 points under its baseline on at least 20', () => {
    expect(isDeparting({ current: 0.91, baseline: 0.97, sample: 20, alerted: false })).toBe(true);
    expect(isDeparting({ current: 0.93, baseline: 0.97, sample: 20, alerted: false })).toBe(false);
    expect(isDeparting({ current: 0.5, baseline: 0.97, sample: 19, alerted: false })).toBe(false);
    expect(isDeparting({ current: 0.5, baseline: null, sample: 50, alerted: false })).toBe(false);
  });
  ```

- [ ] **Step 2: Run** `npm test -w apps/api -- home.logic` — expect FAIL (module not found).

- [ ] **Step 3: Implement** `home.logic.ts`. Group key: `kind` alone when `subject_type` is `transaction` or `payer`; otherwise `kind` + `subject_type` + `subject_reference`. A kind-only group has `subject_reference` and `subject_name` `null`. `link` is `/transactions?state=undetermined` for kind `undetermined`, otherwise the oldest alert's `action_reference`. `title` is the oldest alert's title (the console's fallback wording). `since` is the oldest `raised_at` as ISO. Drop `informational`.

- [ ] **Step 4: Run** `npm test -w apps/api -- home.logic` — expect PASS.

- [ ] **Step 5: Commit** — `git add apps/api/src/console-api/home.logic.ts apps/api/src/console-api/home.logic.test.ts && git commit -m "Group open alerts into home problems, and decide when a route departs"`

---

### Task 2: HomeService — the home's queries

**Files:**
- Create: `apps/api/src/console-api/home.service.ts`
- Modify: `apps/api/src/console-api/console-api.module.ts` (add `HomeService` to `providers`)
- Test: `apps/api/src/console-api/home.service.test.ts`

**Interfaces:**
- Consumes: `AlertRow`, `Problem`, `groupProblems`, `isDeparting` (Task 1); `TreasuryService.floatAccounts(db, scope)` (exists).
- Produces (all `scope` arguments: `string[] | null`, `null` = every project or provider, as `Authorisation.projectScope` returns):
  ```ts
  export interface RateVsBaseline { current: number | null; baseline: number | null; sample: number }
  export interface CollectedToday { currency: string; today: number; last_week: number | null }
  export interface RouteSeries { route_id: string; payment_method_code: string; payment_method_name: string; country_code: string; currency: string; direction: 'collection' | 'disbursement'; baseline: number | null; current: number | null; sample: number; alerted: boolean; departing: boolean; hours: { hour: string; terminal: number; succeeded: number }[] }
  class HomeService {
    problems(opts: { alerts: boolean; providers: boolean }): Promise<Problem[]>
    overallSuccess(scope: string[] | null): Promise<RateVsBaseline>
    collectedToday(scope: string[] | null): Promise<CollectedToday[]>
    undetermined(scope: string[] | null): Promise<number>
    routeSeries(scope: string[] | null): Promise<RouteSeries[]>
  }
  ```

- [ ] **Step 1: Write the failing tests** in `home.service.test.ts`, on `createTestContext()` like `reconciliation.test.ts`. Build transactions through the real flow (`previews.create` → `transactions.confirm` → `submission.submit` → `status.sweep`, `SimulatorAdapter.settleAfterMs = 0`), on routes CM/MOMO and CM/OM (seeded), then set `state`, `terminal_at`, `settled_amount`, `failure_reason` with `updateTable('transaction')` to place each one in time. A local helper `txn(route: 'MOMO' | 'OM', at: Date, state: 'succeeded' | 'failed', projectPrincipal?)` keeps the tests short.
  - `overallSuccess`: 3 succeeded + 1 failed in the last hour, 8 succeeded + 2 failed 2 days ago → `{ current: 0.75, baseline: 0.8, sample: 4 }`.
  - `routeSeries`: returns exactly 24 `hours` per route that has terminal transactions in the last 8 days, oldest first, the last bucket being the current hour; a failure 3 hours ago lands in `hours[20]`; CM/MOMO and CM/OM are two series, never one; `departing` is true for a route with an open `health:success_rate:route:<id>` alert (insert the alert row directly).
  - `collectedToday`: one succeeded collection today (settled 1 000 XAF), one failed today, one succeeded disbursement today, one succeeded collection 7 days ago earlier in the day (settled 400) → `[{ currency: 'XAF', today: 1000, last_week: 400 }]`; with nothing 7 days ago → `last_week: null`.
  - `undetermined`: two transactions set to `undetermined` → `2`.
  - **scoped to one project**: a second project's transactions are invisible to `overallSuccess`, `routeSeries`, `collectedToday` and `undetermined` called with `[firstProject.id]`; an empty scope `[]` returns zeros and no series.
  - `problems`: a suspended provider account yields a `critical` problem of kind `provider_suspended` named by the account name; with `{ alerts: false, providers: true }` alert-backed problems are absent; route subjects are named `"<payment method name> <country> · <direction>"`, provider accounts and projects by their `name`, float accounts by the float view's `"<account> <country> <currency> <direction>"`.

- [ ] **Step 2: Run** `npm test -w apps/api -- home.service` — expect FAIL.

- [ ] **Step 3: Implement** `HomeService` (`@Injectable`, injects `DB_TOKEN` and `TreasuryService`).
  - Scope filter as `home.controller.ts` builds it today (an empty scope matches the nil uuid).
  - `overallSuccess` and `routeSeries` follow `HealthService.successRates`: current = terminal in the last hour, baseline = terminal between 8 days and 1 hour ago, baseline `null` under 20 terminal.
  - `routeSeries`: one query grouped by `route_id` and `date_trunc('hour', terminal_at)` over the last 24 hours, joined to `route` and `payment_method`; fill missing hours with zeros in TypeScript. `alerted` = an open/acknowledged alert with fingerprint `health:success_rate:route:<route_id>`. `departing` = `isDeparting(...)`.
  - `collectedToday`: `direction = 'collection' and state = 'succeeded'`, sum of `settled_amount` by `currency_code`, `terminal_at >= date_trunc('day', now())`; last week = the same window shifted by 7 days and capped at `now() - interval '7 days'`; `last_week` is `null` when that window has no row.
  - `problems`: alerts `status in ('open','acknowledged') and severity <> 'informational'` when `opts.alerts`; suspended accounts when `opts.providers`, as synthetic problems `{ severity: 'critical', kind: 'provider_suspended', subject_type: 'provider_account', … , link: '/configuration/providers/<id>' }` added after grouping and sorted with the rest. Resolve names for route, provider_account, project and float_account subjects in at most one query per type.

- [ ] **Step 4: Run** `npm test -w apps/api -- home.service` — expect PASS. Then `npm run typecheck -w apps/api`.

- [ ] **Step 5: Commit** — `git commit -m "Compute the home's figures per route and per scope in a HomeService"`

---

### Task 3: Reshape `GET /console/home`

**Files:**
- Modify: `apps/api/src/console-api/home.controller.ts` (the `home()` handler only; approvals handlers untouched)
- Test: `apps/api/src/console-api/home.controller.test.ts`

**Interfaces:**
- Consumes: `HomeService` (Task 2); `ApprovalService.pending`, `TreasuryService.floatAccounts` (exist).
- Produces — the response the console reads; every key is absent when its permission is missing:
  ```ts
  interface HomeCards {
    verdict?: { problems: Problem[] }                                   // oversight.alerts.read and/or providers.read
    success_rate?: RateVsBaseline                                       // oversight.reports, project scope
    collected_today?: CollectedToday[]                                  // oversight.reports, project scope
    undetermined?: number                                               // oversight.reports, project scope
    lowest_float?: { id: string; provider: string; country: string; currency: string; direction: string; cover_hours: number | null; band: string; proposed_transfer: number | null } | null   // treasury.read_float, provider scope; null when no disbursement float has cover
    routes?: { scoped: boolean; series: RouteSeries[] }                 // oversight.reports, project scope
    awaiting_your_approval: { id: string; summary: string; initiator: string; created_at: string }[]   // as today
    assigned_discrepancies?: { id: string; type: string; subject_reference: string }[]                   // reconciliation.read
    earnings?: { scoped: boolean; rows: { currency: string; platform_revenue: number; margin: number }[] } // as today
  }
  ```
  Removed keys: `open_alerts`, `float_cover`, `coverage_ratio`, `open_discrepancies`, `todays_activity`, `provider_status`.

- [ ] **Step 1: Write the failing tests**, calling `HomeController.home(req)` with `req = { principal: { administratorId }, auth: new Authorisation(adminId, grants) }` (`Authorisation` from `admin-auth/authorisation.service`):
  - an administrator holding only `oversight.reports` gets `success_rate`, `collected_today`, `undetermined`, `routes`, `earnings`, `awaiting_your_approval` and no `verdict`, `lowest_float`, `assigned_discrepancies`;
  - an administrator holding only `providers.read` gets a `verdict` (suspended accounts only);
  - an administrator holding none of `oversight.alerts.read`, `providers.read` has no `verdict` key at all;
  - `lowest_float` is the float view with the smallest `coverHours`, scoped by `providerScope('treasury.read_float')`;
  - none of the removed keys appear.

- [ ] **Step 2: Run** `npm test -w apps/api -- home.controller` — expect FAIL.

- [ ] **Step 3: Implement** the handler on `HomeService`; keep the earnings query as it is. Update `docs/spec/api-reference.md` if it documents `/console/home` (check with `grep -n "console/home" docs/spec/api-reference.md`).

- [ ] **Step 4: Run** `npm test -w apps/api` (whole suite) and `npm run lint -w apps/api` — expect PASS.

- [ ] **Step 5: Commit** — `git commit -m "Serve the redesigned home: verdict, headline figures, route series"`

---

### Task 4: Console — verdict wording, headline figures, refresh

**Files:**
- Create: `apps/console/src/lib/home.ts` (the response types `HomeCards`, `Problem`, `RateVsBaseline`, `CollectedToday`, `RouteSeries`, copied field for field from Tasks 2–3; the console shares no code with the API)
- Create: `apps/console/src/lib/verdict.ts`, `apps/console/src/lib/verdict.test.ts`
- Create: `apps/console/src/components/Verdict.tsx`, `apps/console/src/components/Headline.tsx`
- Modify: `apps/console/src/components/common.tsx` (add `useEvery`), `apps/console/src/lib/i18n.ts`, `apps/console/src/styles.css`

**Interfaces:**
- Consumes: `HomeCards` (Task 3).
- Produces:
  ```ts
  // lib/verdict.ts
  export function verdictState(problems: Problem[]): 'confirmed' | 'checking' | 'refused'
  export function headline(problems: Problem[], lang: Lang): string
  export function problemText(p: Problem, lang: Lang): string
  export function changeVsLastWeek(today: number, lastWeek: number | null): number | null   // ratio −1…, null when lastWeek is null or 0
  // components/common.tsx
  export function useEvery(fn: () => void, ms: number): void     // runs fn every ms while document.visibilityState === 'visible', and once on becoming visible
  // components
  export function Verdict({ problems, loadedAt }: { problems: Problem[]; loadedAt: Date }): JSX.Element
  export function Headline({ cards }: { cards: HomeCards }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests** in `verdict.test.ts`:
  ```ts
  expect(verdictState([])).toBe('confirmed');
  expect(verdictState([warning])).toBe('checking');
  expect(verdictState([warning, critical])).toBe('refused');
  expect(headline([], 'fr')).toBe('Tout fonctionne normalement');
  expect(headline([a, b], 'fr')).toBe('2 problèmes demandent ton attention');
  expect(headline([a], 'en')).toBe('1 problem needs your attention');
  expect(problemText(routeHealth /* subject_name 'Orange Money CI · collection' */, 'fr')).toBe('Orange Money CI · collection décroche');
  expect(problemText(undetermined12, 'fr')).toBe('12 transactions sans issue connue');
  expect(problemText(unknownKind /* title 'Calls refused on origin' */, 'fr')).toBe('Calls refused on origin');   // fallback: the alert title, untranslated
  expect(changeVsLastWeek(1120, 1000)).toBeCloseTo(0.12);
  expect(changeVsLastWeek(500, null)).toBeNull();
  expect(changeVsLastWeek(500, 0)).toBeNull();
  ```
  Write a `problemText` case for every kind `HomeService` can emit that has its own sentence: `health:success_rate:route`, `health:success_rate:provider_account`, `health:success_rate:project`, `breaker_open`, `provider_suspended`, `float_cover`, `float_insufficient`, `coverage_ratio`, `undetermined`, `float_drift`, `notification_failing`; any other kind falls back to `title`. (Float cover alerts use fingerprint `float_cover:<id>`.)
  And in a `Verdict` render test (`renderToStaticMarkup`): with no problems the block carries class `verdict confirmed`; with a critical one, `verdict refused` and the problem's link.

- [ ] **Step 2: Run** `npm test -w apps/console -- verdict` — expect FAIL.

- [ ] **Step 3: Implement.** Sentences are `t()` keys under `home.verdict.*` with `{name}` / `{count}` variables; the subject line joins problem texts with ` · `, most severe first. `Verdict` shows the state colour (existing `--state-*` tokens), the headline, the subject line, and "updated {n} s ago" counting from `loadedAt`. `Headline` renders the four figures that are present, each linking to where you act: success rate → `/oversight` health, collected → `/oversight` reports, undetermined → `/transactions?state=undetermined`, lowest float → `/treasury/float/<id>`. Collected today shows one row per currency.

- [ ] **Step 4: Run** `npm test -w apps/console` and `npm run typecheck -w apps/console` — expect PASS.

- [ ] **Step 5: Commit** — `git commit -m "Word the home verdict in both languages and show the headline figures"`

---

### Task 5: Console — the route chart

**Files:**
- Create: `apps/console/src/lib/routeChart.ts`, `apps/console/src/lib/routeChart.test.ts`
- Create: `apps/console/src/components/RouteChart.tsx`
- Modify: `apps/console/src/styles.css` (operator tokens, chart classes), `apps/console/src/styles.test.ts`, `apps/console/src/lib/i18n.ts`

**Interfaces:**
- Consumes: `RouteSeries` from `apps/console/src/lib/home.ts` (Task 4).
- Produces:
  ```ts
  // lib/routeChart.ts
  export const MIN_POINT = 5
  export function points(s: RouteSeries): (number | null)[]                       // 24 rates, null under MIN_POINT terminal
  export function view(series: RouteSeries[], direction: 'collection' | 'disbursement', country: string | 'all'):
    { lines: { series: RouteSeries; dashed: boolean; label: string }[]; band: { lo: (number | null)[]; hi: (number | null)[]; count: number } | null }
  export function countryChips(series: RouteSeries[], direction: 'collection' | 'disbursement'): { country: string; departing: number }[]   // sorted by country code
  export function spreadLabels(ys: number[], gap: number): number[]                // pushes end labels apart, keeps order
  export function operatorColour(paymentMethodCode: string): string                // a CSS var(), e.g. 'var(--operator-momo)'
  // components/RouteChart.tsx
  export function RouteChart({ series }: { series: RouteSeries[] }): JSX.Element  // owns direction + country state
  ```

- [ ] **Step 1: Write the failing tests** in `routeChart.test.ts`:
  - `points`: an hour with 4 terminal → `null`; 20 terminal / 19 succeeded → `0.95`.
  - `view(…, 'collection', 'all')`: departing routes become lines, every other route of that direction goes into the band; `band.count` is their number; `band.lo[i]`/`hi[i]` are the min/max of their non-null points at hour `i`, `null` when none has a point.
  - `view(…, 'collection', 'CI')`: every CI collection route is a line, `band` is `null`; no route of another country appears.
  - MTN CM and MTN CI both departing: two lines, the second `dashed: true`; labels `'MTN MoMo CM'` and `'MTN MoMo CI'`.
  - `countryChips`: `{ country: 'CM', departing: 1 }` when one CM route departs.
  - `spreadLabels([100, 104, 150], 14)` → `[100, 114, 150]`.
  And in `styles.test.ts`: the seven `--operator-*` tokens are defined with the hex values from Global Constraints.

- [ ] **Step 2: Run** `npm test -w apps/console -- routeChart styles` — expect FAIL.

- [ ] **Step 3: Implement.** `RouteChart` draws an SVG with `viewBox="0 0 760 240"`: y from 50 % to 100 % (values below 50 % pin to the axis), grid lines every 10 %, x ticks every 4 hours with the last labelled "now"/"maint."; the band as one filled path in `--ink` at 8 % opacity with "N other routes" beside its right end; each line 2 px in its operator colour (`stroke-dasharray="6 4"` when dashed), a 4 px end dot and a direct label "name NN %" placed with `spreadLabels`. Above it: a Collection / Disbursement switch, then the chips ("All routes · N", then each country, with "● n" in the refused colour when `departing > 0`), then a legend. Hover: a dashed crosshair at the nearest hour and a tooltip listing each line's rate, terminal count and baseline, plus "N other routes between x and y %" in the all-routes view. The mockup `.superpowers/brainstorm/98153-1793723444/content/accueil-a-v7.html` is the visual reference.

- [ ] **Step 4: Run** `npm test -w apps/console` and `npm run typecheck -w apps/console` — expect PASS.

- [ ] **Step 5: Commit** — `git commit -m "Draw the success rate per route over 24 hours, with a country filter"`

---

### Task 6: Assemble the home, update the spec, show it locally

**Files:**
- Modify: `apps/console/src/pages/Home.tsx` (rewrite), `apps/console/src/lib/i18n.ts` (remove unused `home.*` keys), `apps/console/src/styles.css`
- Modify: `docs/spec/console-specification.md` §4.2

**Interfaces:**
- Consumes: `Verdict`, `Headline`, `useEvery` (Task 4); `RouteChart` (Task 5); `HomeCards` (Task 3).

- [ ] **Step 1: Write the failing test** `apps/console/src/pages/Home.test.tsx`: export a presentational `HomeView({ cards, loadedAt })` from `Home.tsx` and render it with `renderToStaticMarkup`:
  - with every key present, blocks appear in order: verdict, headline, chart beside "Waiting on you", business line;
  - with only `awaiting_your_approval`, no verdict, headline, chart or business line is rendered;
  - the business line shows revenue and margin as two figures per currency, a negative margin with class `negative`.

- [ ] **Step 2: Run** `npm test -w apps/console -- Home` — expect FAIL.

- [ ] **Step 3: Implement.** `HomePage` loads `/home` with `useLoad`, reloads with `useEvery(reload, 60_000)`, records `loadedAt` on each successful load, and renders `HomeView`. Layout: verdict full width; headline as a four-column grid that wraps on narrow screens; chart (about two thirds) beside "Waiting on you"; business line last, small and muted. Remove the `home.*` i18n keys no page uses any more.

- [ ] **Step 4: Rewrite console spec §4.2** to describe this home: the verdict and its sources, the four figures, the route chart and its departing rule (`DEPARTING`: 5 points under baseline on at least 20 terminal, or an open route health alert), "Waiting on you", the business line, and the permission table from the design. Keep the closing note that the screen is worth revisiting.

- [ ] **Step 5: Run** `npm test && npm run typecheck && npm run lint` at the repo root — expect PASS.

- [ ] **Step 6: Commit** — `git commit -m "Assemble the redesigned home and describe it in the console spec"`

- [ ] **Step 7: Show it to Valentine locally before any PR.** Start the preview as the memory note `show-locally-before-pr` describes (separate `proxiapay_preview` database, API + worker, `src/cli/smoke.ts`, Vite on 5173). The smoke run creates transactions only in the current hour, so spread them for the chart: run `smoke.ts` several times, then with `psql` set `terminal_at = now() - (random() * interval '23 hours')` on succeeded/failed transactions and turn a share of one route's last-hour transactions to `failed`. Give Valentine the link and wait for their reaction before opening a PR.
