# Console home redesign

Status: design, awaiting approval · 2026-11-03

## Why

The console home (`apps/console/src/pages/Home.tsx`, console spec 4.2) shows
eight cards of equal weight: approvals, alerts, float cover, coverage ratio,
discrepancies, today's activity, earnings, provider status. Every card is a
table. In Valentine's words, nothing stands out when you open it: it says
nothing about the state of the platform, yet it is dense, so it is useless.

The data is not the problem. Almost everything the new home needs is already
computed by the API. The problem is that nothing on the screen is ranked by
urgency, and nothing shows change over time.

The new home answers one question at a glance: **is the platform working, and
if not, where?**

## Goals

- Opening the console tells you in one line whether something is wrong and
  names it precisely.
- Four headline figures give the state of the platform without reading a table.
- A chart shows how each route's success rate has moved over the last 24 hours,
  and makes a failing route visible without hunting for it.
- Work waiting on this administrator is never missed (console spec 4.2 keeps
  "the approval card comes first" as a principle; here it stays on the first
  screen, beside the chart).

## Non-goals

- Redesigning other console pages. Treasury, Reconciliation, Oversight and
  Configuration stay as they are; this design only removes cards from the home
  and points to those pages.
- A merchant-facing dashboard. The console is for ProxiaPay administrators.
- New alerting rules. Every alert the verdict needs already exists.
- Dark mode. The console has none yet.

## Anti-goals

- **Never merge routes.** The unit of health is the route (payment method ×
  country, e.g. MTN MoMo CM). MTN CM and MTN CI are different countries,
  different operator entities, possibly different aggregators; a problem on one
  says nothing about the other. No chart, figure, filter or tooltip on the home
  aggregates an operator across countries. A country filter narrows the set of
  routes; it never merges them.
- **Never let the home become dense again.** Information that is only
  reassuring when healthy (provider active, coverage above 1) takes no space;
  it surfaces in the verdict when it goes wrong.
- **Never sum different currencies** into one figure. XAF and XOF are separate
  rows, as everywhere else in the console.
- Never show platform revenue and margin as one number (console spec 4.2).

## Decided by Valentine

- **Layout: "direction A", the verdict first.** Top to bottom: the verdict, a
  row of four headline figures, then the success-rate chart beside "Waiting on
  you", then one discreet business line. Valentine chose A over a route grid
  (tiles per country × operator) and over an action inbox.
- **The chart shows success rate, not volume.** Volume says whether there is
  activity; success rate says whether it works, which is the question the home
  answers.
- **The chart is a line chart**, chosen over an hour-by-hour heatmap.
- **One line per route, never per operator.** See the anti-goal above.
- **The four cards that leave the home**, as proposed and accepted:
  - Provider status: no card. A degraded or suspended provider account appears
    in the verdict.
  - Coverage ratio: no card. A ratio below 1 appears in the verdict; otherwise
    it lives in Treasury.
  - Discrepancies by type: only on the Reconciliation page. Those assigned to
    this administrator stay under "Waiting on you".
  - Revenue and margin: one discreet line at the bottom of the home, per
    currency, revenue and margin kept apart, a negative margin shown in the
    refused colour.

The validated mockup is
`.superpowers/brainstorm/98153-1793723444/content/accueil-a-v7.html`
(git-ignored, on Valentine's machine). Its numbers are invented.

## The home, block by block

Each block keeps the existing rule (console spec 4.2): it appears only where the
administrator holds the permission behind its data. The verdict only names
problems the administrator is allowed to see.

### 1. The verdict

One sentence, a state colour, and when it was last refreshed.

- **Healthy:** confirmed state colour, "Everything is running normally".
- **Problems:** the checking (amber) colour if the worst problem is a warning,
  the refused (red) colour if any is critical. The headline counts problems
  ("2 problems need your attention"); the line under it names each one in
  plain words, most severe first: "Orange Money CI is failing since 40 min ·
  Ejara CI float covers 6 h".

What feeds it *(Claude's call)*:

- **Every open or acknowledged alert of severity `warning` or `critical`**,
  whatever its kind: service health (route, provider account and project
  dimensions), float cover, coverage ratio below 1 (already raised by
  `TreasuryService.evaluateCover`), circuit breaker opening, held undetermined
  transactions, reconciliation divergences, float drift, failing notification
  deliveries, security. Restricting the verdict to a few kinds would let it say
  "everything is running normally" while critical undetermined disbursements
  are open. `info` alerts (e.g. "awaiting a second approver") never feed it.
- **A provider account in `suspended` status.** Suspension is manual and raises
  no alert, so read `provider_account.status` directly.

**Grouping.** One problem per alert kind and subject, not one per alert: twelve
"held undetermined" alerts read as one problem, "12 disbursements held
without a known outcome". The headline counts problems, not alerts. The
problem's severity is the worst among its alerts.

**Provider-account and project health alerts** are kept as their own problems,
named by account or project ("Ejara Pay success rate fell"). They describe the
account or the project as a whole, which is a fact of its own; they never
replace or merge the per-route problems, which keep naming the route.

Alert titles name subjects by id today (`Success rate fell on route <uuid>`).
The verdict must show names: payment method name and country code for a route,
account name for a provider account, project name for a project. Resolve them
server-side.

The alerts behind the verdict refresh at different paces: health every 60 s,
float cover and coverage ratio every 300 s (`worker.module.ts`).

### 2. Four headline figures

| Figure | Detail line | Data |
|---|---|---|
| Success rate, last hour, all terminal transactions | its 7-day baseline ("normal 97.8 %") | New aggregate, same method as `HealthService.successRates` but over all transactions |
| Collected today | per currency, one row each; change vs the same weekday last week | New query, see below |
| No known outcome | "to recheck with the provider" | `HealthService.counters().undetermined_open` |
| Lowest float cover | account, country, direction, proposed transfer | `TreasuryService.floatAccounts` (sorted ascending, `proposedTransfer` already computed) |

Each figure links to the page where you act on it (transactions filtered on
`undetermined`, the float account detail, etc.).

**"Collected today" is money actually collected** *(Claude's call)*: succeeded
collections, settled amount, counted by `terminal_at` since local midnight.
Today's `todays_activity` sums `requested_amount` over every transaction
created today in both directions and any state, which is not money collected;
do not reuse it for this figure. The comparison takes the same weekday last
week, up to the same time of day. Disbursement volume leaves the home; it stays
in Oversight reports.

### 3. Success rate by route, last 24 h

A line chart, y-axis 50–100 %, x-axis the last 24 hourly buckets ending now.
A Collection / Disbursement switch above it (collection by default).

- **Default view, all routes.** Routes that run normally are drawn as one grey
  band: at each hour, from the worst to the best success rate among them. Only
  routes that depart from their own baseline are drawn as coloured lines,
  labelled at their end with route name and current rate. With 50 routes the
  chart still shows one band and a few lines.
- **Country filter.** A row of chips: "All routes · N", then one chip per
  country that has routes. A chip carries a red dot and a count when that
  country has departing routes ("CM ● 1"). Clicking a country draws every one
  of its routes as its own line (typically 2–4), no band.
- **Colour follows the operator**, fixed per payment method, never by rank:
  MTN MoMo `#2a78d6`, Orange Money `#eb6834`, Moov `#1baf7a`, Wave `#eda100`,
  Airtel `#e87ba4`, Free `#008300`, M-Pesa `#6250d6`. When two departing routes
  share an operator in the all-routes view, the second is dashed. Every line is
  direct-labelled, so identity never relies on colour alone.
- **Tooltip** on hover (crosshair): the hour, then each drawn route's rate,
  transaction count and baseline; in the default view, the band's range ("30
  other routes between 94 and 100 %").
- An hour with fewer than 5 terminal transactions on a route has no point; the
  line breaks there.

**When a route counts as departing** (drawn as a line, and counted on its
country chip) *(Claude's call)*: **either** it has an open service-health
alert, **or** its last-hour rate is below its 7-day baseline by a margin on a
minimum sample. The first condition guarantees that a route named in the
verdict is always visible on the chart. The second shows a route sliding
before the alert fires, since the alert rule (`HealthService`: a drop of a
third on at least 10) only fires around 97 % → 64 %. The mockup used 5 points
on at least 20 transactions; exact values are left to the builder (see below).

### 4. Waiting on you

Unchanged in content from today's approval card plus discrepancies assigned to
this administrator: count, oldest age, a link each.

### 5. The business line

One line at the bottom, per currency: "Month to date · XOF: platform revenue
2.18 M · margin 1.04 M". Same figures as today's earnings card, same scope rule.

## Backend

All on `GET /console/home`, extending the `cards` object; no new endpoint.

1. **Verdict**: a list of problems `{ severity, kind, subject_name, count,
   text, link }` built from open alerts and suspended provider accounts,
   grouped and named as described above.
2. **Overall success rate**, last hour vs 7-day baseline.
3. **Collected today vs the same weekday last week**, per currency, up to the
   same time of day.
4. **Hourly success rate per route**, last 24 h, per direction: for each route,
   its payment method, country, currency, 7-day baseline, departing flag, and 24
   buckets `{ hour, terminal, succeeded }`. One grouped query on
   `transaction` by `route_id` and `date_trunc('hour', terminal_at)`.
The coverage-ratio alert the verdict relies on already exists
(`TreasuryService.evaluateCover`, fingerprint `coverage_ratio:<code>`).

## Permissions and scope *(Claude's call)*

The existing rule holds: each block, and each problem in the verdict, is gated
by the permission behind its own data, with that permission's scope applied.

| Block | Permission | Scope |
|---|---|---|
| Verdict, alert-backed problems | `oversight.alerts.read` | none (alerts are not scoped today) |
| Verdict, suspended provider accounts | `providers.read` | none |
| Overall success rate, collected today, no known outcome, the chart | `oversight.reports` | project scope, as `todays_activity` does today: rates, baselines and the departing flag are computed on the administrator's projects only, so a scoped administrator never sees other projects' volume |
| Lowest float cover | `treasury.read_float` | provider scope, as today |
| Waiting on you | as today | as today |
| Business line | `oversight.reports` | project scope, as today |

`HealthService.successRates()` and `counters()` are not project-scoped; the home
needs scoped variants. An administrator who can see none of the verdict's
sources gets no verdict block at all, never "everything is running normally",
which would be a claim they cannot verify.

## Frontend

- Rewrite `HomePage` in `apps/console/src/pages/Home.tsx`.
- The chart is hand-drawn SVG in a small component. The console has no chart
  library and does not need one for a single line chart.
- The home refreshes its data every 60 s while the tab is visible *(Claude's
  call)*; "updated 12 s ago" counts from the last load.
- Every new string goes through `t()` in English and French (console spec 3.3).
- Colours come from the existing state tokens in `styles.css`. Operator colours
  are new tokens there, named for what they mean (`--operator-mtn`, …).

## Spec to update

Console spec 4.2 ("Home") describes today's eight cards. Rewrite it to describe
this home. Its closing note already expects the screen to be revisited.

## Left to the builder

- The exact departing rule for the chart (margin and minimum sample), as long
  as it is tighter than the alert rule and documented in the spec.
- The wording of verdict sentences, in both languages.
- What "same weekday last week" does when last week has no data (show no
  comparison).
- Whether the headline figures stay four on narrow screens or wrap.
