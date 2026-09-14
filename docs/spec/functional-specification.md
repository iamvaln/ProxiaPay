# ProxiaPay — Functional Specification

**Version:** 1.0
**Date:** September 2026
**Status:** Reviewed and complete. Ready for implementation, with the questions in section 18 outstanding.
**Companion documents:** ProxiaPay Console — Interface Specification, ProxiaPay API Reference

---

## 1. Introduction

### 1.1 Purpose of this document

This document specifies the functional behaviour of ProxiaPay, an internal payment processing platform. It describes what the system does, the data it holds, the rules it enforces, and the interfaces it exposes. It is written to be read by someone joining the project without prior context, and it precedes implementation.

### 1.2 What ProxiaPay is

ProxiaPay is a payment aggregation layer that sits between the company's software products and the external payment providers that move money on their behalf.

Mobile money is the dominant consumer payment method across Central and West Africa. Each mobile network operator runs its own wallet system, each country has its own set of operators, and each aggregator that resells access to those operators does so with its own interface, its own vocabulary, and its own commercial terms. A product that wants to collect a payment in Cameroon and send one in Senegal would otherwise carry that complexity in its own codebase, and would carry it again for every new country and every change of commercial partner.

ProxiaPay absorbs that complexity once. Each internal product integrates against a single stable interface and describes payments in a single vocabulary. Behind that interface, ProxiaPay decides which provider handles a given payment, holds the commercial terms, tracks the money, records what happened, and presents the whole picture through an administration console.

The platform serves the company's own products. The design accommodates external clients as a later possibility, and this document notes the specific places where that possibility shaped a decision.

### 1.3 Scope

Within scope:

- Collection of funds from mobile money wallets, and disbursement of funds to them
- Administrator-initiated refunds against completed collections
- Routing of each payment to a chosen provider, with fallback to an alternative
- Commercial configuration per country, currency, payment method, and direction, held with full history
- A double-entry ledger tracking balances per product and funds held at each provider
- Recording and verification of the business's own withdrawals of collected funds
- Scheduled reconciliation against provider records, with a review and adjustment console
- An administration console covering configuration, treasury, transaction search, and reporting
- A programmatic interface for internal products, and event notifications to them

Outside scope for this version:

- Currency conversion within the payment path
- Card payments, bank transfers, and cryptocurrency
- Recurring payments and scheduled mandates
- Chargeback and dispute workflows
- Customer-facing checkout pages

### 1.4 Glossary

| Term | Meaning |
|---|---|
| **Aggregator** | A company that resells access to multiple mobile money operators through one interface. ProxiaPay integrates aggregators as providers. |
| **Platform fee** | What ProxiaPay charges for the service itself. Set per route, and separate from the cost of moving the money. |
| **Processing fee** | What ProxiaPay quotes a project to cover a provider's cost. Set per route and held steady across provider changes. |
| **Attempt** | One try at executing a transaction through one provider. A transaction may hold several attempts when fallback occurs. |
| **Available balance** | The portion of a project's balance free to spend. |
| **Binding** | The association of a provider account to a route, carrying that provider's commercial terms and its position in the fallback order. |
| **Business capital** | The account representing funds the business places at a provider or grants to a project. |
| **Cashout** | A withdrawal by the business of collected funds from a provider to a bank or cash destination, for operating purposes. |
| **Collection** | Movement of funds from a customer's wallet to the business. Also called a payin. |
| **Cover** | The period a float account can sustain disbursements at its recent rate before exhausting its free liquidity. |
| **Counterparty** | The person on the other side of a payment: the payer on a collection, the recipient on a disbursement. |
| **Direction** | Whether a transaction collects or disburses. |
| **Disbursement** | Movement of funds from the business to a recipient's wallet. Also called a payout. |
| **Double-entry** | An accounting method where every movement is recorded twice, as a debit on one account and a credit on another, so the books always balance. |
| **Entitlement** | Permission granted to a project to use a specific route. |
| **Failure reason** | The coded explanation recorded on a transaction that ended without moving money. |
| **Float** | Money held at a provider, available to fund disbursements or awaiting withdrawal. |
| **Float transfer** | Movement of funds between two wallets at the same provider, typically from collection to disbursement. |
| **Free liquidity** | The balance of a float account less the disbursements already submitted against it and still open. |
| **Idempotency** | The property that repeating a request produces the result of the first request instead of a second transaction. |
| **Ledger** | The append-only record of every movement of money through the system. |
| **Liquidity reserve** | The balance a float account retains through any withdrawal, expressed as a target period of cover. |
| **Minor units** | The smallest indivisible amount of a currency. Amounts are stored as whole numbers of minor units. |
| **MSISDN** | The full international telephone number identifying a mobile money wallet. |
| **OTP** | A one-time code the payer supplies to authorise a payment. |
| **Payment method** | A specific mobile money service, such as MTN Mobile Money or Orange Money. |
| **Permission** | The right to perform one named operation in the console. Defined by the platform. |
| **Preview** | A resolved, time-limited statement of what a payment will cost, confirmed once to create a transaction. |
| **Project** | An internal product consuming ProxiaPay, such as a marketplace or a personal finance application. |
| **Provider** | An external platform ProxiaPay calls to execute payments. |
| **Provider account** | One set of credentials at a provider, with a declared scope of countries, methods, and currencies. |
| **Provider fee** | The fee a provider charges ProxiaPay for a transaction. |
| **Rate change set** | One action opening new route versions across every route a commercial agreement touches. |
| **Reconciliation** | Scheduled comparison of ProxiaPay's records against provider records, producing discrepancies for review. |
| **Refund** | A disbursement returning funds for a completed collection, carrying a reference to it. |
| **Reserved balance** | The portion of a project's balance held against disbursements in flight. |
| **Role** | A named, editable set of permissions granted to administrators. |
| **Route** | The combination of country, currency, payment method, and direction that identifies a way to move money. |
| **Route version** | An immutable snapshot of a route's configuration, valid over a period of time. |
| **Scope** | The projects or provider accounts a role assignment applies to. |
| **Velocity cap** | A limit on transaction count or total value over a rolling window. |

---

## 2. System overview

### 2.1 Actors

**Projects** are internal products. Each holds credentials, a balance in each currency it uses, permission to use specific routes, and an address at which it receives event notifications. A project initiates transactions and reads its own history and balances.

**Administrators** operate the platform through the console. Each holds one or more roles, and each role assignment carries a scope limiting it to particular projects or provider accounts. Section 8 describes the permission model.

**Providers** are external. ProxiaPay calls them to execute payments and receives notifications from them.

### 2.2 Governing principles

**Records are append-only.** Configuration, ledger entries, and transaction history are written once. Change means writing a new record that supersedes its predecessor, and correction means writing an offsetting record. Nothing is edited or deleted.

**Terms are frozen at preview.** A transaction resolves its configuration when it is previewed and carries that resolution through confirmation to completion. Configuration changed afterwards applies to subsequent previews only, so the figures a payer was shown are the figures that govern.

**Certainty governs automatic action.** The system acts automatically where the outcome is known. Where a provider leaves an outcome undetermined, the transaction holds its position and waits for a human or for reconciliation to settle it.

**The configuration model belongs to ProxiaPay.** Each provider's own structure stays behind its adapter. Adding a provider changes adapter code and reference data, and leaves the shape of the configuration untouched.

### 2.3 Environments

Production and sandbox run as separate deployments with separate databases, separate provider credentials, and distinct domains, sharing one codebase.

Separation is structural rather than conditional, which removes the possibility of a sandbox credential resolving to a production provider account, and keeps environment out of every query and every report. A project exists as an independent record in each environment with its own credentials, entitlements, and balances. The administration console carries an explicit environment indicator.

Each environment holds its own credentials at each provider, so testing in one environment reaches nothing belonging to the other.

---

## 3. Configuration

### 3.1 Reference data

**Countries** carry a two-letter short code, a three-letter ISO code, a name, an international dialling prefix, the currencies they support, and an active flag. Cameroon is `CM` and `CMR`, dialling `+237`. Deactivating a country halts new transactions across every route within it, and serves as the coarse operational control during an incident.

**Currencies** carry a code, a display name, and the number of decimal places. XAF, XOF, and GNF have none. CDF and USD have two. The decimal count governs storage and rounding throughout the system.

**Payment methods** are a global catalogue of mobile money services, each with a code and display name, referenced by routes.

**Exchange rates** are a dated table serving reporting alone. Each entry records a currency pair, a rate, the date it takes effect, and its source. The payment path never reads it.

### 3.2 Routes

A **route** is the combination of country, currency, payment method, and direction. It is a stable identity that never changes once created. Collecting Orange Money in Senegal in XOF is one route. Disbursing to it is another.

Including currency in the identity handles countries supporting more than one currency without special treatment.

A **route version** is an immutable snapshot of how a route is configured, holding:

- The processing fee terms, as a percentage, a fixed amount, or both, with an optional floor and ceiling
- The platform fee terms, in the same form, defaulting to zero on a new route
- Who bears each of the two, being the counterparty or the project, with the effect of each choice set out in section 6.1. Routes carry counterparty-borne as their default for both
- Minimum and maximum transaction amounts
- Whether the route requires the payer to enter a one-time code or to complete a step in a browser
- An active flag
- An ordered list of provider bindings
- Validity dates, the administrator who created it, and a note explaining the change

Any change closes the current version and opens a successor. Reordering providers, adjusting a fee, and deactivating a route are all the same operation, which means the history of a route is a complete and uniform account of its commercial life.

Each version carries a fingerprint computed over its contents, supporting inexpensive comparison and detecting alteration.

### 3.3 Provider accounts and bindings

A **provider account** is one set of credentials at one provider, carrying:

- The provider it belongs to and the adapter that speaks to it
- Credentials, encrypted at rest and readable only by the service
- The base address of the provider's interface
- A declared scope of countries, payment methods, currencies, and directions it can serve
- An operational status, being active, degraded, or suspended

Providers structure accounts differently. One may issue a single account covering twelve countries, another an account per country. The declared scope lets either shape sit behind the same configuration, and the adapter handles the difference.

A **binding** associates a provider account with a route version and carries:

- The provider's expected fee terms for that route, marked indicative or contracted
- Position in the fallback order
- An enabled flag
- Minimum and maximum amounts, where the provider's limits are narrower than the route's

Provider fee terms live here rather than on the route because they vary by provider, while the fee charged to projects stays constant across a change of provider.

Expected terms begin as indicative, taken from a commercial proposal, and become contracted once an agreement is signed. The distinction governs the fee variance monitoring of section 6: a contracted rate produces a discrepancy on any difference, while an indicative rate is understood as a placeholder and stays quiet. The console shows which routes still carry indicative terms.

### 3.4 Project entitlements

A project gains access to a route through an explicit grant. An **entitlement** is versioned in the same append-only manner and carries:

- Minimum and maximum transaction amounts for this project on this route
- Velocity caps on count and on value, over rolling windows of twenty-four hours and thirty days
- Optional processing fee terms overriding the route's, left empty to inherit them
- Optional platform fee terms overriding the route's, left empty to inherit them
- An optional bearer for each of the two fees, overriding the route's, left empty to inherit it
- An active flag

Velocity caps bound the damage from compromised credentials or a defect in a project, and belong in place from the first day rather than added after an incident. Rolling windows avoid both a midnight cliff and an argument over which timezone governs. Succeeded and in-flight transactions consume a cap, and failed and expired transactions release it.

Products differ in where their economics sit. One whose customers receive funds and withdraw them charges on the withdrawal; one whose customers buy goods charges on the payment. A single rate across every product would therefore serve some badly, and everything a project is quoted may differ from the route's own terms: either rate, either bearer, or any combination. A high-volume product may hold a lower processing rate, a product being encouraged onto the platform may hold a platform rate of zero, and a product running a promotion may absorb a fee its neighbours pass on. What a provider charges stays outside this, since it is a cost the platform carries rather than a rate a project is quoted.

Resolution at preview reads the entitlement first and falls back to the route version, field by field, and the resolved values are what the preview returns and the transaction records.

A project's processing rate is checked against provider cost in the same manner as a route's. Granting a rate below what the binding is expected to charge raises the warning of section 6.2 at the moment of the grant, naming the shortfall per transaction, since a rate set per project would otherwise place a route below cost without the route's own terms changing.

A transaction passes four gates: the country is active, the route version is active, the project holds an active entitlement, and the amount and velocity fall within every applicable limit.

### 3.5 Configuration history

Every transaction records the identifier of the route version in force when it began, which establishes lineage and makes the question of which terms applied answerable exactly.

Every transaction also stores a copy of the terms themselves, comprising the processing fee rate, the platform fee rate, the provider fee rate, the bearer resolved for each of the two project-facing fees, and the limits checked. The copy keeps reporting fast, remains readable if configuration tables are later reshaped, and holds even if a provider account is reissued. An invoice records the price it charged for the same reason.

### 3.6 Rate change sets

A commercial agreement settles terms across many routes at once. A **rate change set** is a single administrative action carrying an effective date, a note, and an optional reference to the agreement, which opens new versions across every route it touches, all of them together or none.

Each version produced stays immutable and independent, and the set is the record of why they moved together. This keeps a fifty-route repricing from being fifty separate form submissions, where one route left on a superseded rate goes unnoticed for a month.

---

## 4. Treasury and the ledger

### 4.1 Purpose

ProxiaPay holds the company's money. Collected funds arrive at providers and belong to the projects that earned them. Disbursed funds leave from provider wallets and reduce project balances. The business withdraws collected funds to operate. The ledger is the authoritative record of all of it.

### 4.2 Structure

The ledger is double-entry and append-only. Every movement writes balanced debits and credits, entries are immutable, and correction takes the form of an offsetting entry that references the original.

Balances derive from the sum of entries. Periodic checkpoints per account record a balance at a moment, so current balances read from the most recent checkpoint plus subsequent entries.

Amounts are stored as whole numbers of minor units, with the currency's decimal count governing display. Fee rounding is half-up, and any remainder is recorded on the transaction, which keeps the ledger balanced to the unit.

### 4.3 Account types

**Project accounts**, per project and per currency:

- *Available* — free to spend
- *Reserved* — held against disbursements in flight

**Float accounts**, per provider account, country, currency, and direction. Providers separate collection wallets from disbursement wallets, so direction belongs in the identity, and a country supporting two currencies carries a wallet for each. Payment methods within one country share a wallet, so method is a reporting dimension on transactions rather than a balance: the platform reports how much MTN Mobile Money collected in Gabon, and holds one Gabon collection balance behind it.

Routes are finer-grained than wallets by design. Commercial terms differ per operator while the money pools per country, and the float account mirrors the wallet so reconciliation against provider balances compares like with like.

**Fee accounts**, per currency: processing revenue, platform revenue, and the expense of provider fees. Cost recovery and earnings are separate balances rather than one figure requiring interpretation.

**Settlement accounts**, representing bank or cash destinations receiving business cashouts. They mirror external destinations and accumulate by design, since nothing within the platform draws them down.

**Business capital accounts**, per currency, being the source of funds the business places at a provider or grants to a project.

**Suspense accounts**, holding value whose position is undetermined pending reconciliation.

### 4.4 Entry types

| Type | Effect |
|---|---|
| Collection | Credits project available and the collection float; records fees |
| Disbursement reservation | Moves value from project available to project reserved |
| Disbursement settlement | Consumes the reservation, debits the disbursement float, and records fees |
| Disbursement release | Returns a reservation to project available |
| Disbursement suspension | Moves a reservation to suspense |
| Float transfer | Moves value between two float accounts at one provider; records any fee the provider charged |
| Cashout | Debits a float account and credits a settlement account |
| Float funding | Debits business capital and credits a float account |
| Project funding | Debits business capital and credits a project balance |
| Adjustment | A correction, requiring justification and an identified actor |
| Reversal | Offsets a prior entry, referencing it |

Both funding entries, adjustment, and reversal are administrative actions and record the administrator, a reference, and a justification.

The two funding entries stand independent of each other. Placing money at a provider and granting a project a balance are separate acts, and the coverage ratio of section 4.8 is what detects a project funded without float behind it.

### 4.5 Reservation

Reservation is the mechanism that keeps disbursement safe.

When a disbursement begins, the amount plus whichever fees the project bears moves from its available balance to its reserved balance. The move is the solvency check, and it happens before any provider is contacted. A project cannot commit funds it does not hold.

On success, the reservation is consumed and the disbursement float is debited. On a definite failure, the reservation returns to available. Where the outcome is undetermined, **the reservation moves to suspense and stays held** until reconciliation resolves it. Returning an undetermined disbursement to available would let a project spend money that has already left.

Suspense resolves in one of three ways. Reconciliation establishing that the disbursement succeeded consumes the reservation and debits the disbursement float. Reconciliation establishing that it failed returns the value to project available. A position still unresolved after a configured period escalates to an adjustment, carrying a justification, an identified actor, and a second approver.

### 4.6 Liquidity

Project solvency and operational liquidity are separate conditions, and both must hold for a disbursement to proceed.

Solvency asks whether the project's available balance covers the amount and its fees. Liquidity asks whether the relevant disbursement float holds enough to execute. A project may be solvent in XAF while a specific disbursement wallet is empty because collected funds sit in the corresponding collection wallet.

The two conditions carry different meanings and receive different treatment. Insufficient project balance returns a client error. Insufficient float returns a distinct code identifying the condition as operational, and raises an alert to the treasury team.

The liquidity check reads free liquidity as defined below rather than the raw wallet balance, and the check and the reservation happen together under a lock held per float account. Concurrent disbursements on one route would otherwise each observe the same balance and jointly exceed it.

### 4.6.1 Liquidity monitoring

A float account's wallet balance overstates what can actually be spent from it, because disbursements already submitted and still open will draw on it. **Free liquidity** is the wallet balance less those open disbursements, and it is the figure monitoring works from.

Monitoring reports time to exhaustion rather than level. Free liquidity divided by the account's recent outflow rate yields hours of cover, and each account sits in one of three bands:

| Band | Condition |
|---|---|
| Healthy | Cover above the target period |
| Watch | Cover below the target period, alert raised, transfer proposed |
| Critical | Cover below the minimum period, alert escalated |

A level expressed in currency cannot serve this purpose across the platform's routes, since the same balance is comfortable on a low-volume route and nearly exhausted on a busy one. Target and minimum periods are configured as durations of cover, and the corresponding currency figures derive from the account's observed outflow at the 95th percentile of daily volume, recomputed on a weekly cycle. Any account may carry a manual override where judgement should govern.

The treasury dashboard presents every float account with its free liquidity, its cover, and its band, ordered so the accounts closest to exhaustion appear first.

### 4.7 Float transfers

A float transfer moves value between two float accounts at one provider, in one currency, most commonly from a collection wallet to the corresponding disbursement wallet. A transfer records source, destination, amount, any fee charged by the provider, the initiating administrator, and its status through to confirmation.

Providers differ in whether they expose transfers programmatically. The adapter declares its capability, and the platform follows one of two paths:

- **Where transfers are exposed**, the platform executes the transfer and confirms it from the provider's response.
- **Where they are not**, an administrator performs the transfer in the provider's own console and registers it in ProxiaPay. The transfer stays pending until reconciliation observes the corresponding change in both wallet balances, at which point it confirms.

The second path keeps the ledger truthful while an operation happens outside the platform, and reconciliation supplies the verification.

Transfers are the usual response to an account entering the watch or critical band described above. The alert carries a proposed transfer sized to restore the target period of cover, drawn from the paired collection wallet, and an administrator acts on it. Where the paired collection wallet lacks the balance to satisfy the proposal, the alert escalates to the business as a funding requirement instead.

Automatic execution of proposed transfers is a candidate extension, and the first version presents the proposal for an administrator to act on.

### 4.8 Cashouts and the solvency rule

A cashout debits a float account and credits a settlement account, recording the destination, the initiating administrator, the approving administrator, supporting documentation, and status through to confirmation.

Cashouts obey one rule, which the system enforces:

> The total float held at a provider backs the sum of all project available and reserved balances in that currency. Only the remainder is withdrawable.

That remainder comprises accumulated fee revenue, being processing and platform revenue together, and funds the business has placed there itself. Withdrawing beyond it converts project balances into claims with nothing behind them, and the ledger would continue to balance while the money was gone.

Solvency alone is an incomplete guard, because it treats a provider's collection and disbursement wallets as a single pot while disbursements can draw only on the latter. A cashout emptying a collection wallet leaves the business solvent and leaves client withdrawals failing within the day. Cashouts therefore observe a second constraint:

> A cashout leaves every affected float account above its liquidity reserve, including sufficient balance in a collection wallet to restore its paired disbursement wallet to the target period of cover.

The withdrawable amount is the lesser of the two constraints. The system computes both before accepting a cashout, rejects any request exceeding the lower, and presents both figures in the console so the binding constraint is apparent.

The treasury dashboard presents the coverage ratio, being total float over encumbered balances, as a standing figure per currency.

Cashouts above a configurable threshold require approval from a second administrator.

---

## 5. Transactions

Every transaction begins with a preview. The project describes the payment it intends to make, the platform resolves the configuration and returns the figures against a reference, and the project confirms that reference to create the transaction. A preview carries the whole intent, including the payer or recipient, so confirmation submits the preview reference alone and commits to what was already resolved. The preview holds the resolution, comprising the route version, the bearer resolved for each fee, the selected binding, and the limits checked, and confirmation reads it rather than resolving again. One path through fee resolution serves both directions, and the amount shown to a payer is the amount charged.

A preview holds no funds and reserves no liquidity. It stays confirmable fifteen minutes, and confirming after that window returns a distinct error in place of a silent reprice. What expires is the frozen resolution: a rate change would otherwise sit unapplied for as long as an open preview survived.

Confirmation consumes the preview and the window closes with it. Everything after that point runs on its own clock, since the payer completes the payment through the operator's own menu outside the platform.

Three separate periods govern a payment, and they share no boundary:

| Period | Runs from | Ends at |
|---|---|---|
| Preview validity | The preview | Confirmation, or fifteen minutes |
| Payer action window | Initiation | Confirmation by the payer, the code attempt limit, or its own expiry |
| Status sweep ceiling | Initiation | A conclusive outcome, or the move to undetermined |

The preview record itself persists under the same retention as transactions, including previews never confirmed. A payer previewing repeatedly without completing is a signal about a route, a wall they have hit, or a pattern worth examining, and discarding the record would lose it.

### 5.1 States

| State | Meaning |
|---|---|
| Created | Confirmed from a preview, carrying its resolution, funds reserved where applicable |
| Action required | Awaiting the payer, who must supply a code or complete a browser step |
| Submitted | Sent to a provider, provider reference held |
| Processing | Provider acknowledged, outcome pending |
| Succeeded | Complete, funds moved |
| Failed | Complete, funds did not move |
| Expired | The payer did not act within the permitted window |
| Undetermined | The provider gave no conclusive outcome; held for reconciliation |

The undetermined state exists because the alternative is a guess about money. A disbursement whose outcome is unknown holds its reservation, raises an alert, and waits.

Every state change writes to an append-only transaction event log recording the new state, its source, the time, and a reference to the raw payload that produced it. Sources are the provider's immediate response, an inbound notification, a scheduled status check, reconciliation, or an administrator. The log supports audit, timing analysis, and investigation.

A transaction that has reached a terminal state leaves it only through reconciliation, as described in section 9.7. The change writes as a further event and the prior state stands in the history, so a correction is visible as a correction in place of appearing as the state the platform held all along.

### 5.2 Collection flow

The project requests a preview, supplying the amount, the route, the payer identifier, and its own reference. The platform validates against the four gates, checks the payer identifier, resolves the route version and the bearer of each fee, selects the first enabled binding, and returns the amount charged, the fee breakdown, any payer interaction the route requires, and a preview reference with its validity window.

The project confirms the preview by its reference alone. The platform creates the transaction from the resolution the preview holds.

Validating the payer identifier at preview means a malformed number surfaces before the customer has been shown a price.

Identifiers are normalised to international form on receipt. A number supplied without its country's dialling prefix is prefixed from the country named on the route, and a number already carrying it passes through unchanged. The normalised form is what the platform validates, stores, matches against the duplicate guard, and sends to the provider, so one payer resolves to one identifier however a project supplied it. A number carrying a prefix belonging to another country is rejected rather than rewritten.

Routes complete in one of three patterns.

On a **standard route**, the payer completes the payment on their handset, through a menu the operator presents outside the platform. ProxiaPay learns the outcome from a provider notification and the status check that follows it.

On a **route requiring a one-time code**, the platform returns the transaction in the action-required state. The operator sends the payer a code, the project collects it and submits it through the interface, and a valid code confirms the payment. A code may be attempted a configured number of times within a window that opens at initiation, and the transaction expires where that window closes with no valid code. Each attempt is recorded in the transaction event log.

On a **route requiring a browser step**, the platform returns the transaction in the action-required state carrying an address. The project opens that address for its customer, who confirms the payment on the page served there, and the outcome reaches us through a provider notification and the status check that follows it, as on a standard route. The address stays usable for a window opening at initiation, and the transaction expires where that window closes with no confirmation.

That address authorises the payment for whoever holds it, so it goes to the payer and to nobody else. It stays out of list views, out of logs, and out of anything a support view renders by default.

Returning the payer to the project's own interface afterwards rests with the project. ProxiaPay supplies the address and reports the outcome, and the surrounding experience belongs to the product.

The platform submits to the provider, holds the provider's reference, and moves to processing. On confirmation it records the amounts and fees the provider reported, credits the project's available balance and the collection float, records processing revenue, platform revenue and fee expense, and notifies the project.

### 5.3 Disbursement flow

The project previews the disbursement, supplying the recipient identifier and its own reference, and confirms it by reference. Solvency and liquidity are examined at confirmation rather than at preview, so a preview returns its figures even where the balance falls short and a project can present a cost before it presents an error. On confirmation the platform reserves the funds, creates the transaction, and submits to the provider.

Where the provider confirms the payment, the reservation is consumed, the disbursement float is debited, fees are recorded, and the project is notified. On definite failure the reservation is released. Where the provider's response leaves the outcome open, the reservation moves to suspense and the transaction enters the undetermined state.

**Refunds.** Returning funds for a completed collection takes the form of a disbursement carrying a reference to the original transaction, initiated by an administrator. It moves money along the ordinary disbursement path, and the reference marks it as a refund in reporting and in the transaction detail view.

A refund returns the amount the project received and carries no fees of its own. The processing and platform fees on the original collection stay with the platform, and the provider fees on both legs stay an expense, since a provider charges for work it has already performed. A refund therefore costs the platform its margin on the original transaction plus the provider fee on the return, and reporting presents refunds separately for that reason.

### 5.4 Fallback

An attempt records the provider account used, a copy of that binding's terms, the provider's reference, and the outcome. A transaction may hold several attempts, and the fees recorded are those of the successful attempt.

Fallback proceeds only where the platform knows no money moved. That covers a provider being unreachable, authentication failing, the provider rejecting the request as invalid, and the provider declining on capability grounds. Where a request timed out or an outcome is undetermined, the transaction holds its position, because retrying would risk charging a payer twice or paying a recipient twice.

**Collection fallback operates by default. Disbursement fallback is enabled per route and starts disabled.** The consequences are asymmetric: funds duplicated on collection sit in our float with an identified payer to return them to, while funds duplicated on disbursement have left the platform.

A provider account accumulating failures beyond a configured count within a configured window is marked degraded and skipped during selection until it recovers. Each provider also carries a manual suspension control in the console, so responding to an incident is one action rather than an edit to every affected route.

### 5.5 Idempotency

A preview confirms exactly once. Repeating a confirmation returns the transaction the first one created, which makes retries safe and is a requirement for disbursement. The preview reference is the natural key for this, since one preview corresponds to one intent to pay.

Each project also supplies its own reference at preview, unique within that project, serving as its correlation handle. Reusing it for a different payment returns a conflict error. References are retained thirteen months, keeping a full year of reporting intact.

Beyond the replay of one preview, the platform guards against a payer being asked twice. A preview matching an open transaction on the same project, route, amount, and payer identifier returns that transaction with a distinct code reporting a similar payment already pending, in place of resolving a new one. Confirmation applies the same check, since a project may hold two previews raised before either was confirmed, and the check at confirmation is the authoritative one.

ProxiaPay sends its own transaction reference to providers as the external reference, so inbound notifications match back precisely.

Three references therefore identify one payment, and each answers a different question:

| Reference | Set by | Answers |
|---|---|---|
| Transaction reference | ProxiaPay | What the platform and its projects call this payment |
| Provider reference | The provider | What the provider calls it, and how their statements and notifications resolve to our records |
| Project reference | The project | What the project calls it in its own system |
| Operator reference | The mobile network operator | What the payer sees in their confirmation message, and what they quote when they call for help |

The operator's reference is recorded where a provider carries it and is absent where one does not, so it identifies a payment without being relied upon to.

The provider reference belongs to an attempt in place of the transaction, since a transaction that fell back holds one per attempt. A transaction's provider reference is the one from its current attempt, and the earlier ones stay against the attempts that produced them. All three are searchable, since an investigation begins from whichever one the person raising it happens to hold.

### 5.6 Status acquisition

Notifications from providers act as triggers. On receiving one, the platform queries the provider's status interface and treats that response as authoritative before changing state. This holds whatever the notification asserts, keeps a forged or replayed notification from moving money, and removes dependence on each provider's signing arrangements.

A scheduled sweep covers transactions in non-final states, following a decreasing frequency: frequent checks in the first minutes, then progressively less often, until a configured ceiling is reached. Transactions still open at the ceiling move to undetermined and enter reconciliation.

---

## 6. Fees

Three fees attach to a transaction, and a fourth figure derives from them.

The **processing fee** is what ProxiaPay quotes a project to cover the cost of moving the money. It comes from the route version and stays the same whichever provider executed the transaction.

The **platform fee** is what ProxiaPay charges for the service itself. It comes from the route version and is independent of the processing fee.

The **provider fee** is what the provider charges ProxiaPay. Its expected value comes from the binding, and its actual value comes from the provider's confirmation.

The **margin** is the processing fee less the actual provider fee. It may be negative, and it measures whether cost recovery is working rather than what the platform earned.

Separating the first two is what keeps a project's rate steady. A route quoting 2.5 percent processing across providers costing 2 and 3 percent earns half a point on one and loses half a point on the other, and the platform absorbs that variation in place of passing it on. The platform fee sits beside it untouched, so what ProxiaPay earns for the service is the same figure whichever provider served the payment and whatever that provider charged.

Each of the two project-facing fees carries its own bearer. A project may have the counterparty bear both, absorb both, or absorb one and pass on the other.

Both rates and both bearers may be set per project through its entitlement, so two products on one route can be quoted differently. A rate named here is whichever applied to the transaction in question, being the project's where one was granted and the route's otherwise.

Margin is computed rather than stored, deriving from the two recorded fees, which keeps it from drifting away from the figures it summarises.

The processing fee credits processing revenue, the platform fee credits platform revenue, and the provider fee debits fee expense. Cost recovery and earnings are therefore separate balances rather than one figure requiring interpretation.

The platform fee is zero until a route is configured otherwise. A route at zero charges the customer the requested amount plus its processing fee alone, and writes no platform revenue posting, since a posting of nothing adds noise to every entry. Raising the rate on a route is an ordinary route version, so the fee begins applying from the transactions that follow and the history stays exact about which rate governed each one.

### 6.1 Amount composition

Each fee is borne either by the counterparty, being the payer on a collection and the recipient on a disbursement, or by the project. The two fees are independent, so a payment may have one borne each way.

Writing R for the amount a project requests, X for the fees borne by the counterparty, Y for the fees borne by the project, and P for the actual provider fee:

| Direction | Counterparty | Project balance | Float movement |
|---|---|---|---|
| Collection | debited R + X | credited R − Y | collection float rises by R + X − P |
| Disbursement | receives R − X | debited R + Y | disbursement float falls by R − X + P |

One rule produces both lines. **A fee borne by the counterparty moves what the counterparty experiences; a fee borne by the project moves what the project's balance experiences.** On a collection the counterparty's fee is added to what they pay; on a disbursement it is taken from what they receive. The project's fee is deducted from what it is credited, or added to what it is debited, according to direction.

Processing revenue receives the processing fee and platform revenue receives the platform fee in every case, whichever side bore them, and fee expense receives P.

**The project transacts at exactly R** for the fees it passes on. The product it sells is priced at R regardless of what any provider charges, and a provider applying a rate other than the contracted one, or a fallback landing on a costlier provider, moves margin alone. The reservation computed at confirmation rests on R and Y and never waits for the provider's figure.

Two worked cases, at 2.5 percent processing, 0.5 percent platform and 2 percent provider.

A **collection of 1000 with the payer bearing both fees** charges the payer 1030, leaves 20 with the provider, raises float by 1010, credits the project 1000, and books 25 to processing revenue and 5 to platform revenue.

A **disbursement of 1000 with the recipient bearing both fees**, which is the shape of a customer withdrawal, debits the project 1000, sends 970 to the recipient, costs 20 at the provider, lowers float by 990, and books the same 25 and 5. The recipient receives less than the round figure, and the project's records show the withdrawal at the amount requested.

All three fees are computed on R rather than on any running total, so the order of application carries no significance.

### 6.2 Fee monitoring

Providers may apply a rate differing from the contracted one. Every transaction records the expected provider fee alongside the actual. A difference produces a discrepancy where the binding's terms are marked contracted, and passes without one where they remain indicative, so routes still carrying figures from a commercial proposal stay quiet until an agreement fixes their rate.

Margin is reported per route, per provider, per project, and over time. An alert raises where a route runs negative beyond a configured threshold or for longer than a configured period, since falling back to a costlier provider is precisely the event that erodes cost recovery quietly.

A negative margin on a collection carries past reporting into solvency. Float rises by less than the project is credited and the fees booked, so the shortfall sits against the coverage ratio of section 4.8 immediately and grows with volume. The alert therefore calls for the route's processing fee to be raised or its provider changed, and for the accumulated shortfall to be made good from business capital.

A binding whose expected provider fee exceeds the processing fee a project would pay is knowable the moment it is configured, ahead of any transaction. Opening such a route version, or granting an entitlement carrying such a rate, raises a warning naming the binding and the shortfall per transaction, and the administrator either accepts it deliberately or corrects the rate. Structural losses are cheaper to catch at configuration than to discover through an alert once volume has run over them.

Platform revenue is reported separately from margin. Conflating them would let a provider's rate change appear as a change in what the platform earns, which it is not.

### 6.3 Currency

Balances and the payment path are held per currency, and conversion stays outside both.

XAF and XOF are separate currencies under separate central banks, and moving between the zones goes through a bank at a real cost. GNF sits outside both zones entirely. CDF floats. Backing obligations in one currency with balances in another would place an open exchange position on every transaction.

A project therefore holds a separate balance per currency, and each funds the routes denominated in it. Conversion as a treasury operation is deferred to a later version, and the business converts outside the platform in the meantime.

Reporting consolidates into a reporting currency using a dated rate table. Each report snapshot stores the rate it used, so historical figures stay stable.

---

## 7. Project interface

The platform exposes two interfaces over HTTP. The one described here serves projects and reaches only the calling project's own data. The console runs on a separate interface that project credentials never reach, carrying everything cross-project: other projects' figures, float and coverage, margin, and reconciliation.

### 7.1 Authentication

A project's credential is a key and a secret, issued per environment. The secret is stored hashed and shown once at issue. Credentials carry scopes covering collection, disbursement, and read access.

Credentials rotate through two roles. A newly issued credential enters as **secondary**, and both credentials authenticate from that moment, so a project adopts the new one at its own pace and across its own deployment schedule. Promoting the secondary makes it primary and returns the former primary to secondary. Deleting the retired credential completes the rotation.

Rotation therefore ends when an administrator says it ends rather than when a period elapses. A credential expiring on a timer would expire at whatever moment it happened to fall, including the middle of a deployment, and the state of a rotation would be a matter of arithmetic rather than something the console can show.

A project holds at most one credential in each role and at least one at all times. Deleting a project's only credential is refused, as is deleting one currently primary, which keeps a rotation from ending with the project holding nothing that works.

Revocation stands apart from rotation and takes effect at once. A credential believed compromised is revoked outright, whatever role it holds, and a project left without a working credential in consequence is the intended outcome.

A project declares the addresses it calls from, as individual addresses or ranges, and the declaration covers every credential that project holds. Calls arriving from elsewhere are refused before authentication is considered, so a leaked key is worth nothing away from the project's own infrastructure.

Declaring at least one address is required in production and optional in sandbox. Every product consuming the platform runs on infrastructure whose addresses are known, and the sandbox exemption keeps early integration work from waiting on a network question.

The address a call is judged by comes from the hop the platform trusts, being its own load balancer or proxy, in place of any address the caller asserts. Honouring a forwarded address from an untrusted hop would let a caller name whichever origin it wished, which would leave the allowlist decorative.

Refusals on origin raise a security alert. A project whose calls begin failing on origin has either changed its infrastructure without declaring the change or has had its key used from somewhere it does not control, and both want looking at promptly.

Rate limits apply per credential.

#### Presenting a credential

A project exchanges its key and secret for a token, and carries that token on every subsequent call. The token is valid for a limited period, after which the project exchanges again.

The exchange keeps the secret off the ordinary request path. A secret travelling on every call is captured by any mishandled log, error report, or intermediary anywhere along that path, and what is captured is a credential with no expiry. A token captured the same way expires on its own, and revoking the credential it came from invalidates it immediately along with every other token issued under that credential.

**Tokens are concurrent and independent.** A project running several instances holds several tokens, all valid, and issuing one never invalidates another. Instances of a project have no reason to coordinate, and a project that scales out mid-day acquires tokens as its instances start.

Nothing caps the number of tokens a credential may hold. A ceiling reached during a traffic spike would stop a project scaling out precisely when it needed to, which is a worse outcome than the condition it guards against. Expiry bounds the total on its own, since the live count is the rate of issuance across the lifetime of a token.

The rate of issuance is limited instead. A project exchanging on every call rather than holding its token is the failure worth catching, and a limit on exchanges per credential catches it while leaving legitimate growth alone. An unusual number of tokens live against one credential raises a security alert, as a signal rather than as a refusal.

### 7.2 Operations

Amounts are whole numbers of minor units throughout the interface. The settings endpoint carries each currency's decimal count, so a client presents them correctly without holding that knowledge itself.

**Exchange credentials for a token.** Key and secret. Returns a token and the period it remains valid.

**Request a preview.** Amount, currency, country, payment method, direction, payer or recipient identifier, project reference, optional payer name and address, optional metadata. Returns a preview reference and its validity window, the amount charged to the payer or debited from the project, the fee breakdown, and whether the route requires payer interaction.

**Confirm a collection.** Preview reference. Returns the transaction, its state, the fee breakdown, and any required payer action, being a code challenge or an address to open depending on the route.

**Confirm a disbursement.** Preview reference, for a preview raised in that direction.

**Submit a one-time code.** Transaction reference and the code. Available on routes requiring one, and returns the transaction with its state and the attempts remaining.

**Read a transaction**, by ProxiaPay reference or by project reference. Returns its state, amounts, fee breakdown, failure reason where it ended without moving money, and its reconciliation status.

**List transactions**, filtered by state, direction, country, method, and date range, paginated.

**Read settings.** Returns what this project may currently do: enabled countries, currencies per country, payment methods, directions, the processing and platform fee rates resolved for this project with the bearer of each, limits and velocity caps, and whether each route requires payer interaction. The bearers together tell a project what to present to the customer. Projects build their payment screens from this rather than from assumptions held in their own code. The response carries the configuration fingerprint as a cache validator, so clients detect change inexpensively.

**Read balances.** Available and reserved per currency, for the calling project alone. Balances sit apart from settings because capability and money answer different questions and change at different rates.

A balance read is advisory. A project reading its balance and then confirming a disbursement is racing its own other transactions, and the authoritative check is the reservation taken at confirmation, which is atomic. Gating logic built on a balance read acts on a figure that may already be stale.

### 7.3 Notifications to projects

ProxiaPay notifies each project at a registered address when a transaction reaches a terminal state or requires payer action. It notifies again where reconciliation corrects an outcome after the fact, as a distinct event carrying the prior outcome, the corrected one, and the reconciliation run responsible. Each project holds its own signing secret, and notifications carry a signature and a timestamp.

An administrator sets the address and the project reads it. A credential able to repoint its own notification address would turn a leaked key into a redirection of payment events.

Delivery retries on a widening interval up to a configured ceiling. Every attempt is logged with its response, and administrators can replay a delivery from the console.

### 7.4 Errors and failure reasons

The platform distinguishes two things a project must handle separately.

A **request error** is returned in response to a call. No transaction exists, or the call left the existing one untouched. The project acts on it immediately.

A **failure reason** describes a transaction that was created and reached a terminal state. It appears on the transaction, in status responses, and in notifications, arriving after the call that created the transaction has already returned successfully.

Both draw on one catalogue of codes. Codes are stable strings: new ones may be added, and the meaning of an existing one never changes.

Every error carries a code, a message suitable for a log, and where relevant the offending field. Every code declares whether repeating the request is safe.

#### Authentication and access

| Code | Meaning |
|---|---|
| `CREDENTIALS_INVALID` | The key or secret is unrecognised |
| `CREDENTIALS_REVOKED` | The credential existed and has been withdrawn |
| `TOKEN_INVALID` | The token is unrecognised or was revoked with its credential |
| `TOKEN_EXPIRED` | The token's period elapsed; exchange again |
| `SCOPE_INSUFFICIENT` | The credential lacks the scope for this direction |
| `ORIGIN_NOT_ALLOWED` | The call came from an address outside the allowlist |
| `RATE_LIMITED` | The credential exceeded its request rate; safe to repeat later |

#### Request validation

| Code | Meaning |
|---|---|
| `FIELD_INVALID` | A field is missing or malformed; names the field |
| `AMOUNT_INVALID` | The amount is absent, negative, zero, or carries decimals in a currency without them |
| `CURRENCY_UNKNOWN` | The currency is unrecognised or unsupported in that country |
| `COUNTRY_UNKNOWN` | The country is unrecognised |
| `PAYMENT_METHOD_UNKNOWN` | The payment method is unrecognised |
| `PAYER_IDENTIFIER_INVALID` | The number is malformed for its country, or carries a prefix belonging to another |
| `PAYER_IDENTIFIER_MISMATCH` | The number belongs to an operator other than the one named |

#### Availability and entitlement

| Code | Meaning |
|---|---|
| `COUNTRY_DISABLED` | The country is deactivated platform-wide |
| `ROUTE_UNAVAILABLE` | No route exists for that combination |
| `ROUTE_DISABLED` | The route exists and its current version is inactive |
| `ENTITLEMENT_MISSING` | The project holds no grant for this route |
| `ENTITLEMENT_DISABLED` | The grant exists and is inactive |
| `AMOUNT_BELOW_MINIMUM` | Below the route or entitlement floor; carries the floor |
| `AMOUNT_ABOVE_MAXIMUM` | Above the route or entitlement ceiling; carries the ceiling |
| `VELOCITY_COUNT_EXCEEDED` | The count cap is reached; carries when the window reopens |
| `VELOCITY_VALUE_EXCEEDED` | The value cap is reached; carries when the window reopens |

#### Preview lifecycle

| Code | Meaning |
|---|---|
| `PREVIEW_NOT_FOUND` | The reference is unrecognised |
| `PREVIEW_EXPIRED` | The fifteen-minute window closed; raise a new preview |
| `PREVIEW_ALREADY_CONFIRMED` | Returned with the transaction the first confirmation created |
| `PREVIEW_DIRECTION_MISMATCH` | A collection preview was confirmed as a disbursement, or the reverse |
| `REFERENCE_CONFLICT` | The project's own reference is already in use for a different payment |
| `SIMILAR_PAYMENT_PENDING` | An open transaction matches this project, route, amount, and payer; returned with that transaction |

#### Funds

| Code | Meaning |
|---|---|
| `BALANCE_INSUFFICIENT` | The project's available balance falls short; carries the shortfall |
| `FLOAT_INSUFFICIENT` | Platform liquidity on that route falls short; carries no amounts, and is safe to repeat later |

#### Payer outcomes

These are failure reasons. A transaction exists and has ended.

| Code | Meaning |
|---|---|
| `PAYER_DECLINED` | The payer refused on their handset |
| `PAYER_UNRESPONSIVE` | The payer did not act before the operator's own timeout |
| `WALLET_NOT_FOUND` | No wallet exists for that number on that operator |
| `WALLET_INACTIVE` | The wallet exists and cannot transact |
| `WALLET_LIMIT_EXCEEDED` | The operator's own ceiling on the wallet was reached |
| `WALLET_BALANCE_INSUFFICIENT` | The payer's wallet lacks the funds, on a collection |
| `CODE_INVALID` | The submitted code was wrong; safe to repeat while attempts remain |
| `CODE_ATTEMPTS_EXHAUSTED` | The attempt limit was reached |
| `ACTION_WINDOW_EXPIRED` | The payer action window closed with no confirmation |

#### Provider and platform

| Code | Meaning |
|---|---|
| `PROVIDER_UNAVAILABLE` | The provider could not be reached; fallback applies |
| `PROVIDER_REJECTED` | The provider refused the request before moving money; fallback applies |
| `NO_PROVIDER_AVAILABLE` | Every binding on the route is disabled, degraded, or exhausted |
| `OUTCOME_UNDETERMINED` | The provider gave no conclusive answer; the transaction is held for reconciliation |

`OUTCOME_UNDETERMINED` is the one code a project must never respond to by repeating the payment. The money may have moved. The transaction stays open, and its resolution arrives through the status endpoint or a notification once reconciliation has settled it.

#### Mapping and disclosure

Adapters map each provider's errors into this catalogue. A provider error with no mapping becomes `PROVIDER_REJECTED`, with the provider's own code and message preserved on the attempt for investigation. Inventing a closer-looking mapping would make a transaction's recorded reason a guess.

`BALANCE_INSUFFICIENT` and `FLOAT_INSUFFICIENT` are separate codes because one is the project's condition and the other is ours, and they disclose accordingly. The first carries the shortfall, since the project needs it to act. The second carries no amounts, since it reports the platform's treasury position and the project's only recourse is to retry later.

---

### 7.5 Integration materials

Each project integrates against the same interface, so the materials supporting that work are produced once and serve every project.

**An interface specification** in a machine-readable form describing every operation, its parameters, its responses, and the error codes of section 7.4. It is generated from the implementation in place of maintained beside it, since a specification written by hand describes the interface as someone remembered it. It is published per environment carrying that environment's address, and versioned with the interface it describes.

**An integration guide** covering the sequence a project follows: exchanging credentials for a token and holding it, requesting a preview and presenting its figures, confirming, handling a route that requires payer interaction, verifying the signature on a notification, reading the settings endpoint in place of holding configuration locally, and responding to each class of error. It states plainly which conditions warrant a retry and which never do, and it notes that a customer contacting a product's support will quote the operator's reference, which the interface returns and filters on.

**A going-live checklist** covering what a project completes before its production credentials are issued: origins declared, notification address registered and verified, sandbox transactions completed across each route it will use, correction notifications handled, and behaviour confirmed against an undetermined outcome.

Per-project documentation stays deliberately thin. A project's own countries, routes, fees, limits, and payer interaction requirements come from the settings endpoint at the moment they are needed, so a written document describing them would be a second copy that goes stale the first time a route changes. What a project receives in writing is its credentials, its declared origins, and the routes it has been granted.

---

## 8. Administration console

### 8.1 Console areas

**Configuration.** Countries and their activation. Payment methods. Routes, with the full version history of each, the ability to open a new version, and rate change sets applying an agreement across many routes at once. Provider accounts, their declared scope, and their operational status. Projects, their credentials, and their entitlements.

**Treasury.** Balances per project and currency. Float per provider account, country, currency, and direction, presented against thresholds. Float transfers, initiated or registered. Cashouts, with the withdrawable amount enforced and second approval above the threshold. Manual funding and adjustment, with justification recorded.

**Transactions.** Search across projects and filters. A detail view showing the state history, every attempt, the configuration in force, the fee breakdown, and the raw exchanges with the provider. Previews are searchable alongside transactions, including those never confirmed, so support can see what a payer tried as well as what completed.

**Reporting.** Volume, value, fees, margin, and success rate, broken down by project, direction, country, payment method, provider, currency, and period. Failure reasons by frequency, drawn from the catalogue in section 7.4, which is what distinguishes a route losing payers from a provider losing requests. Time to completion. Reports read from the terms copied onto each transaction, so historical figures reflect the rates that actually applied.

**Reconciliation.** Run history, statement upload for providers without a listing, and the discrepancy queue with filters, assignment, comments, recurrence counts, and per-item acceptance or rejection. Covered in section 9.

**Audit.** Every configuration change and every treasury action records the administrator, the time, and the before and after state. Authentication history sits alongside it, covering sign-ins, failures, lockouts, and active sessions, with the ability to revoke a session.

**Alerts.** Open and cleared alerts, their acknowledgements and delivery history, the groups receiving each category, and the policies routing them. Covered in section 8.6.

### 8.2 Permissions

A **permission** is the right to perform one named operation. The platform defines the catalogue, since each permission corresponds to an operation the system actually performs.

| Domain | Permissions |
|---|---|
| Reference data | Read countries and methods; manage countries and methods |
| Routes | Read routes and their history; open route versions; set fee terms |
| Providers | Read provider accounts; manage accounts and credentials; suspend and restore an account |
| Projects | Read projects; create and manage projects; issue, promote, demote, delete and revoke project credentials; manage declared origins; manage entitlements |
| Treasury | Read balances; read float; initiate float transfers; initiate cashouts; approve cashouts; post funding; post adjustments; approve adjustments |
| Transactions | Search and read transactions; read unmasked payer identifiers; read raw provider exchanges; force a status re-check; replay a notification |
| Reconciliation | Read runs and discrepancies; upload provider statements; run reconciliation; accept or reject discrepancies; approve adjustments arising from them |
| Oversight | Read reports; export data; verify an export; read the audit log; read authentication history; read alerts; acknowledge alerts; manage alert policies and groups |
| Administration | Manage administrators; manage roles; revoke sessions |

Several separations carry specific weight:

- **Initiating and approving** a cashout or an adjustment are distinct permissions, so the two-person rule can be expressed.
- **Suspending a provider** is separable from managing its credentials, so incident response can be granted broadly while credential access stays narrow.
- **Unmasked payer identifiers and raw provider exchanges** are separable from reading transactions, so investigation rights carry no automatic access to personal data.
- **Setting fee terms** is separable from opening route versions, so commercial authority over rates can rest with the people who own the margin.

### 8.3 Roles and scope

A **role** is a named set of permissions, held as data and editable in the console. The platform seeds a starting set covering ownership, configuration, treasury, support, project team, analysis, and audit, and each is free to be rewritten as responsibilities change.

An administrator holds one or more role assignments. Each assignment carries a **scope**:

- **All**, granting the role across the platform
- **Assigned projects**, limiting it to a named list
- **Assigned provider accounts**, limiting it to a named list

Scope per assignment rather than per administrator allows one person to hold a platform-wide analytical role alongside support rights over two projects, which is the normal shape of a small team.

Scope applies to what a permission reaches, and the two axes reach different parts of the system. Transactions, balances, entitlements, notification endpoints, and reporting are project-scoped. Float, transfers, cashouts, and wallet reconciliation are provider-scoped, since float is pooled across projects by construction. Countries, payment methods, routes, provider accounts, and the audit log are platform-wide and sit outside both.

Scope is enforced where data is read rather than where it is displayed, so a record reached by direct reference is subject to the same limit as one reached through a list. Figures presented to a scoped administrator state the scope they cover, so a partial total is never read as a platform total.

### 8.4 Protecting the separations

Roles being editable means role management is itself a path to any other permission. Four measures hold the separations in place:

- **Two-person rules are enforced on identity.** The approver of a cashout or an adjustment is a different person from its initiator, whatever permissions either holds. Permissions govern who may approve, and identity governs whether this approval counts.
- **Changes to roles and to role assignments are audited** in the same manner as configuration, recording the actor, the time, and the before and after state.
- **An administrator cannot alter their own roles or scope**, and changes to roles carrying treasury or administration permissions require a second approver.
- **Role and administrator changes require a one-time code**, as described in section 10.1, so a session left open at an unattended console cannot be used to grant permissions.

---

### 8.5 Service health

Reporting answers questions someone thought to ask. Health monitoring raises the ones nobody asked, and it watches rates in place of individual transactions, since a route failing for every payer produces no individual record that looks alarming.

Monitored continuously, each against a rolling baseline drawn from that measure's own recent history:

- Success rate per route, per provider account, and per project
- Failure reasons by frequency, where a reason rising sharply indicates a cause that has changed
- Transactions entering the undetermined state
- Transactions reaching the action-required state and never completing, which is how a broken one-time code or browser flow presents
- Time to terminal state
- Notification deliveries failing to a project, which means outcomes are being recorded and never received
- Previews expiring unconfirmed across a route rather than per payer

Departures from baseline raise an alert naming the dimension that moved. A route whose success rate falls by a third is a defect somewhere, and finding it before customers report it is the difference between an incident and a complaint.

### 8.6 Alerts

Conditions worth someone's attention arise across the platform: float cover falling, a route's success rate departing from its baseline, a reconciliation run completing with findings, a transaction held undetermined past its period, repeated failed sign-ins. This section covers where they go.

#### Categories and routing

Alerts group into four categories, and each is routed by a policy naming its recipients:

| Category | Covers |
|---|---|
| Treasury | Float cover bands, coverage ratio, insufficient float refusals, negative margin, unconfirmed transfers |
| Service health | The measures of section 8.5 |
| Reconciliation | Runs completing with findings, stale undetermined transactions, resolved discrepancies recurring |
| Security | Failed sign-in runs, lockouts, calls refused on origin, role and permission changes, operations awaiting a second approver |

A policy carries the category, the severity at which it begins notifying, the groups it reaches, whether acknowledgement is required, and the period after which an unacknowledged alert escalates along with the group it escalates to.

#### Groups

Alerts are addressed to **groups** rather than to individuals. A group carries a name, its member administrators, and one delivery address per channel it uses. An administrator leaving is removed from the group, and the routing survives them.

Groups sit apart from roles. A role governs what someone may do, and a group governs who is told. The two correlate and diverge in practice: a developer on call needs service health alerts and has no business approving a cashout.

Three groups cover the platform as it stands, and the default routing is:

| Category | Group |
|---|---|
| Treasury | Finance |
| Reconciliation | Finance |
| Service health | Developers |
| Security | Administrators |

Policies are editable, so a category may reach more than one group where that serves better. Coverage falling below the balances it backs, for instance, warrants reaching finance and administrators together.

#### Channels

Delivery is by email in the first version. A group holds an address per channel, so adding a channel adds an address rather than changing the routing, and service health alerts reaching a developer chat platform is a matter of giving the developers group an address there.

Every alert carries a reference to the console operation that addresses it, whether that is funding a float account, reviewing a discrepancy, or acknowledging the alert itself. An email therefore arrives with the means to act on it, and the same reference serves a dedicated operations application should one follow.

**No category may be left without an active group.** The console refuses a policy change that would leave one unrouted, and reports any category whose groups have become empty. An alert delivered nowhere is worse than an alert never raised, because the platform appears to be watched.

Where an alert concerns one project, it reaches only those group members whose scope covers that project, following section 8.3.

#### Severity

Alerts carry one of three severities. **Informational** records a condition without demanding action, such as a reconciliation run completing cleanly. **Warning** calls for attention within the working day, such as float cover entering the watch band. **Critical** calls for action immediately, such as coverage falling below the balances it backs, float reaching the critical band, or a disbursement held undetermined.

Critical alerts require acknowledgement. An unacknowledged critical alert escalates after its configured period, which keeps a condition from resting on an assumption that somebody else saw it.

#### Lifecycle

A condition persists, and notifying on every evaluation would flood a channel until people muted it. An alert therefore has a life of its own:

- It is **raised** once when the condition first holds, against a fingerprint of the condition and its subject.
- While the condition continues, it is **not raised again**. Its occurrence count and last-seen timestamp advance.
- It is **re-notified** where severity rises, where acknowledgement lapses, or after a configured quiet period.
- It is **cleared** when the condition no longer holds, and the recipients are told it cleared.

The clearing notice matters as much as the raising one. A float alert that goes quiet tells nobody whether the wallet was funded or the alerting stopped working.

The console lists alerts open and cleared, with their history, acknowledgements, and the deliveries attempted for each.

---

## 9. Reconciliation

Reconciliation compares what ProxiaPay believes against what a provider records, and turns every difference into a discrepancy an accountant reviews. It is the mechanism by which a payment that went wrong is found before a customer reports it.

### 9.1 Cadence and scope

Runs execute weekly against each provider account, and on demand from the console.

A run covers three things: every transaction still in a non-terminal state, whatever its age; every transaction that reached a terminal state since the preceding run; and the balances of every float account at that provider.

Terminal transactions stay in scope deliberately. A collection recorded as failed that the payer in fact completed is terminal at our end and invisible to any sweep that examines open transactions alone. That case is the reason the run reaches backwards.

### 9.2 Automated comparison

Where a provider exposes a listing of its transactions over a period, the adapter retrieves it and the platform compares it against our records line by line.

### 9.3 Manual comparison

Where a provider exposes no such listing, the same comparison runs from a statement supplied by hand.

An accountant exports the transactions from the provider's own console and uploads the file. The platform parses it against the import format declared for that provider, reports any rows it could not read, and runs the identical comparison, producing the same discrepancy records as an automated run.

Each upload records the provider account, the period covered, the file and its checksum, the row count, the uploading accountant, and the resulting run. A file already uploaded is recognised by its checksum and rejected, so one statement cannot be processed twice. The declared period is checked against the rows the file actually contains, since a statement covering the wrong dates produces discrepancies that describe the export rather than the platform.

### 9.4 Discrepancy types

- **Float drift** — a provider's reported wallet balance differs from the corresponding float account
- **Fee variance** — the provider applied a rate differing from terms marked contracted
- **Orphan transaction** — the provider holds a transaction with no counterpart in ProxiaPay
- **Missing transaction** — ProxiaPay holds a transaction the provider does not recognise
- **State divergence** — both hold the transaction in conflicting final states
- **Stale undetermined** — a transaction has been undetermined beyond its permitted period
- **Unconfirmed transfer** — a registered float transfer has not appeared in wallet balances
- **Checkpoint mismatch** — a balance checkpoint disagrees with the sum of its entries

### 9.5 Review

The console lists discrepancies from a run with filters and assignment, and an accountant works them individually.

A discrepancy passes through three states. It is **open** when a run raises it, **under review** once an accountant takes it, and **resolved** once a decision is recorded. It carries the timestamp it was first detected, the timestamp it was last detected, the accountant who reviewed it, and the timestamp of the decision.

Resolution records one of two decisions. **Accepted** states that the provider's record is correct. **Rejected** states that ours is, and that the difference needs no action.

Whether an adjustment follows is a separate question from the decision. An accepted discrepancy posts a corrective ledger entry where the difference calls for one, and an accountant may accept a difference as real and leave the records untouched, as with a fee variance too small to be worth a correction or a drift explained by a timing difference that has since resolved. The discrepancy records which of the two happened and, where an entry was posted, which one.

Both decisions require a comment. A discrepancy carries comments from anyone who examined it, so the reasoning is attached to the conclusion rather than held by whoever reached it.

Accepted discrepancies posting an adjustment above a configured value require a second approver, and every decision records the accountant, the timestamp, and the resulting ledger entry where one exists.

### 9.6 Recognising a discrepancy already seen

Runs are weekly and a difference persists, so the same discrepancy would otherwise be raised again at every run, and an accountant would rework a decision already taken.

Each discrepancy carries a fingerprint over its type, its subject, and the difference itself. A run finding a matching fingerprint acts on what it finds:

- **Against an open discrepancy**, it updates the last-detected timestamp and the number of runs that have seen it, and raises nothing new.
- **Against a resolved discrepancy**, it records the recurrence and raises nothing. The decision stands and the accountant never sees it again.

A difference that has changed produces a new discrepancy, since a drift that grew from one amount to another is new information rather than the same finding. Including the difference in the fingerprint is what distinguishes the two cases.

A resolved discrepancy recurring across many runs is itself worth attention: a rejected finding that keeps returning suggests a systematic difference between the platform and the provider rather than an isolated one. The console surfaces recurrence counts for that reason.

### 9.7 Corrections and the transactions they touch

A transaction never changes by editing. Where reconciliation establishes that an outcome differed from what the platform recorded, the change is written as an event against that transaction, sourced to reconciliation and linked to the discrepancy that produced it. The prior state and the correction both stand in the transaction's history.

A transaction is touched only where an accepted discrepancy called for it. Accepting a difference without posting an adjustment leaves the transaction as it stands, and its reconciliation status records that it was examined.

Each transaction carries a reconciliation status readable through the status endpoint: **unreviewed** before any run has covered it, **matched** where a run found it consistent with the provider, **disputed** where a discrepancy is open against it, **examined** where a discrepancy against it was resolved without changing it, and **corrected** where an accepted discrepancy changed its outcome.

A transaction whose outcome changes after it went terminal emits a notification to its project, distinct from the ordinary outcome events. This matters more than the ledger correction that accompanies it: a collection we reported as failed and later established as paid leaves an order unfulfilled at the project's end, and the project acts on it only if told. Correcting our books without telling the project leaves the customer to complain.

---

## 10. Security

Provider credentials are encrypted at rest and never returned by any interface. Project secrets are stored hashed. Every administrative action is attributed and logged. Administrator rights follow the permission and scope model of section 8, which keeps configuration, treasury, and oversight separable and limits each administrator to the projects and provider accounts they are assigned.

Administrator access to the console is authenticated by email address and carries a second factor, on the reasoning that one console account can approve a cashout, issue project credentials, and alter roles. Sessions expire after a configured period and may be revoked individually or for an administrator entirely.

Every authentication attempt is recorded, successful or otherwise, with the address presented, its origin, and its outcome. Repeated failures lock the account for a configured period. The record covers addresses matching no administrator, since a run of attempts against an unknown address is a signal in its own right. Authentication history is readable in the console under its own permission and retained on the same terms as the audit log.

Payer identifiers and names are stored as needed to execute payments and are masked in list views. A preview holds the same identifier the project already keeps in its own customer records, and previews are retained on the same terms as transactions. Raw provider payloads are retained for a defined period for investigation, then discarded.

Rate limits apply per project credential. Velocity caps apply per project and route. Both bound the effect of a compromised credential.

### 10.1 Confirming sensitive operations

Certain operations require the administrator to confirm with a one-time code sent to them at the moment of the request, beyond the authentication that opened the session. The operations are:

- Initiating or approving a cashout
- Posting or approving an adjustment
- Funding a project or a float account
- Initiating or registering a float transfer
- Issuing, rotating, or revoking project credentials
- Creating or altering provider account credentials
- Creating or altering administrators, roles, and role assignments

The code authorises one operation rather than a period of activity. It is bound to the operation and to the values submitted with it, so a code confirming a cashout of one amount cannot carry a cashout of another. It is single use, expires shortly after issue, and admits a limited number of attempts before the operation is abandoned and must be started again.

Confirmation and second approval answer different questions and both apply where both are required. The code establishes that the person at the console is the administrator the session belongs to. A second approver establishes that a different person agreed. Neither substitutes for the other.

Each confirmation is recorded against the operation in the audit log, including codes that expired or were abandoned.

Where a one-time code and the second factor at sign-in reach an administrator by the same channel, both rest on that channel remaining under their control. Delivering them by different means removes that dependency.

---

## 11. Provider adapters

Each provider is reached through an adapter presenting one internal contract:

- Establish and maintain authentication, including token renewal where applicable
- Submit a transaction in either direction, returning a provider reference, an initial state, and any payer action required
- Read a transaction's status, returning a normalised state with amounts, fees, and the operator's own reference where the provider carries it
- Interpret an inbound notification into a normalised event
- Read wallet balances
- List the provider's transactions over a period, where the provider exposes one
- Transfer between wallets, where supported
- Declare capability, covering countries, methods, currencies, directions, whether transfers are exposed, whether transactions can be listed, and whether the provider offers a test environment
- Map the provider's errors into the platform's taxonomy

Normalisation is the substance of the integration. Each provider names amounts and states differently, and the adapter's work is to express them in the platform's vocabulary so that everything above it stays unchanged when a provider is added.

Where a provider offers no test environment, a simulator adapter presenting the same contract stands in for it in the sandbox deployment.

Where a provider exposes no transaction listing, reconciliation against that provider runs from uploaded statements as described in section 9.3, and the adapter declares the import format its statements follow.

---

## 12. Provider correspondence — first integration

This section holds the technical detail of the first provider, kept apart from the body so the specification stays independent of any one integration.

**Provider:** Ejara Pay. Documentation at `https://ejara-pay.vercel.app/docs`, collection at `https://ejara-pay.vercel.app/postman`.

**Authentication.** `POST /api/v1/accounts/authenticate`, with `client-key` and `client-secret` as headers, returning `accessToken` and `expiresIn` (3600 seconds). Subsequent calls carry the token as a bearer credential alongside both headers.

Tokens rotate through roles rather than expiring on issue. A newly generated token enters as secondary and the existing token continues to work; an administrator then demotes the former token to secondary and deletes it once nothing relies on it. Several tokens are therefore valid at once during a rotation, which is what allows every instance to share one credential set with no coordination between them.

**Submission.** `POST /api/v1/transactions/initiate-momo-payment`, carrying `phoneNumber`, `transactionType` (`payin` or `payout`), `amount`, `fullName`, `emailAddress`, `currencyCode`, `countryCode`, `paymentMode`, `externalReference`. One endpoint serves both directions.

**Status.** `GET /api/v1/transactions/{paymentReference}`.

The provider carries the operator's own transaction identifier, being what a payer sees in their confirmation message. The field holding it is identified at integration, since the documented response fields listed below omit it.

**Wallets.** `GET /api/v1/accounts/wallets`, filtered by `serviceType` (`collection` or `disbursement`), `currencyId`, `countryId`, and `status`. Wallets are issued per country and direction, with payment methods in one country sharing a wallet. The Democratic Republic of the Congo supports two currencies and therefore carries a wallet for each, and a transaction reaches the wallet matching the currency it names.

**Notifications.** Management endpoints under `/api/v1/accounts/webhooks`. Events: `payment.confirmed`, `payment.rejected`, `transfer.confirmed`, `transfer.rejected`.

**State mapping.** `pending` maps to processing. `confirmed` maps to succeeded. `rejected` maps to failed. Absence of a conclusive response within the sweep ceiling maps to undetermined.

**Amount mapping.** The status response carries `rawAmount`, `amount`, `fees`, `feePolicy`, `feeValue`, `providerAmount`, `providerCurrency`, `transactionCurrency`, `baseCurrencyPaidAmount`, and `specialOfferAmount`. In the documented example, a collection of 1000 with a 1.5 percent fee produced a total of 1015, indicating the fee was added to the amount charged to the payer and computed on the requested amount. The adapter maps `rawAmount` to the requested amount, `amount` to the amount charged, and `fees` to the actual provider fee. The rate in `feeValue` is compared against the binding's expected rate where that rate is marked contracted.

**Error mapping.** `INVALID_API_CLIENT` and `INCOMPLETE_REQUEST_HEADERS` map to authentication errors. `CLIENT_ERROR` maps to validation. `INSUFFICIENT_FUNDS` maps to insufficient float, as it reports the merchant position rather than the project's. `RESOURCE_NOT_FOUND` maps to an unknown reference.

**Capability.** Wallet transfers are performed in the provider's own console and registered in ProxiaPay, since the published interface exposes wallet reading only. The adapter declares transfers as unsupported, and confirmation comes from reconciliation against wallet balances. Transaction listing is likewise declared unsupported, so reconciliation runs from uploaded statements per section 9.3, pending the confirmation recorded in section 18.

**Coverage.** Fifty route entries across eleven countries, supplied separately as a commercial annex, denominated in XAF, XOF, GNF, CDF, and USD. The published interface currently names MTN Mobile Money and Orange Money as supported payment modes, so availability of the remaining operators is enabled per route as confirmed. Fee figures in the annex stand as indicative pending a signed agreement, and bindings seeded from it are marked accordingly.

**Catalogue corrections.** Four discrepancies in the annex were raised and settled, and the catalogue is seeded on this basis:

1. The country coded `CD` is the Democratic Republic of the Congo, carrying CDF and USD.
2. Guinea, coded `GN`, carries GNF in place of the XOF shown in the annex.
3. The Gabon disbursement entry naming Airtel Money against the code for Moov Money is Moov Money. Operator names follow their codes throughout.
4. One-time code and browser requirements are configured per route from the verified source in place of the columns in the annex.

---

## 13. Data model

This section names the entities the platform holds, their significant fields, and the rules that bind them. It describes structure rather than storage, and leaves indexing, partitioning, and physical types to implementation.

### 13.1 Conventions

Every entity carries an identifier and a creation timestamp; neither is repeated below. Monetary fields are integers in minor units and always accompany a currency. Fields marked optional may be absent.

Entities described as versioned follow one pattern: a stable parent row holding identity, and a chain of immutable version rows each carrying validity dates, the administrator who created it, and a note. Exactly one version per parent is open at a time, meaning its end date is unset.

### 13.2 Reference data

**Country** — two-letter short code, three-letter ISO code, name, international dialling prefix, active flag.

**Currency** — code, name, decimal count.

**Country currency** — country, currency. The Democratic Republic of the Congo holds two rows; every other country holds one.

**Payment method** — code, name.

**Exchange rate** — base currency, quote currency, rate, effective date, source. Read by reporting alone.

### 13.3 Providers

**Provider** — code, name, adapter key.

**Provider account** — provider, name, credential reference, base address, operational status of active, degraded or suspended, flags for whether the provider exposes wallet transfers and whether it offers a test environment. The credential reference points at the secret store; secrets are absent from this row.

**Provider account capability** — provider account, country, currency, payment method, direction. The declared scope of what this account can serve.

### 13.4 Routes and commercial terms

**Route** — country, currency, payment method, direction. Unique across those four, and never modified after creation.

**Route version** — route, sequence, processing fee percentage and fixed amount with its floor and ceiling, platform fee percentage and fixed amount with its floor and ceiling, processing fee bearer, platform fee bearer, minimum and maximum amount, one-time code required flag, browser step required flag, active flag, validity dates, author, note, fingerprint, optional rate change set.

**Route binding** — route version, provider account, expected provider fee percentage and fixed amount, terms status of indicative or contracted, priority, enabled flag, optional minimum and maximum narrower than the route's.

**Rate change set** — effective date, note, optional agreement reference, author. Groups the route versions one commercial agreement produced.

### 13.5 Projects and access

**Project** — name, code, status.

**Project credential** — project, key, secret hash, scopes, role of primary or secondary, status of active or revoked, issuing administrator, optional revocation timestamp and reason.

**Project token** — credential, token hash, issue and expiry timestamps, originating address, optional revocation timestamp. Revoking a credential revokes every token issued under it.

**Project origin** — project, address or range, description, active flag. A project holds at least one in production.

**Project notification endpoint** — project, name, address, signing secret reference, active flag.

**Entitlement** — project, route. Unique across the pair.

**Entitlement version** — entitlement, sequence, minimum and maximum amount, velocity caps on count and value over each window, optional processing fee terms override, optional platform fee terms override, optional processing fee bearer override, optional platform fee bearer override, active flag, validity dates, author, note.

### 13.6 Previews and transactions

**Preview** — reference, project, resolved route version, resolved entitlement version, selected binding, direction, requested amount, currency, processing fee, platform fee, the bearer resolved for each, charged amount, settled amount, expected provider fee, payer identifier, optional payer name and address, project reference, optional metadata, payer action required, expiry, status of open, confirmed or expired, optional resulting transaction.

The preview carries the resolution so confirmation performs no lookup of its own. Its status closes on confirmation or on expiry, and the row persists either way.

**Transaction** — reference, originating preview, project, route version, direction, state, reconciliation status of unreviewed, matched, disputed, examined or corrected, requested amount, charged amount, settled amount, processing fee, platform fee, the bearer resolved for each, expected provider fee, actual provider fee, currency, payer identifier, project reference, terms snapshot, limits snapshot, optional original transaction for a refund, payer action expiry, terminal timestamp, optional failure reason.

The terms and limits snapshots hold the values applied, alongside the route version reference that establishes lineage.

**Transaction attempt** — transaction, sequence, provider account, binding snapshot, provider reference, optional operator reference, state, actual provider fee, raw request and response references, start and end timestamps, optional failure reason. A transaction holds one attempt ordinarily and several where fallback occurred; the successful attempt supplies the recorded fees.

**Transaction event** — transaction, prior state, new state, source of provider response, notification, status check, reconciliation or administrator, optional actor, payload reference, timestamp. One-time code submissions record here, and attempts remaining derive from the count.

### 13.7 Ledger

**Ledger account** — type, currency, and the scope columns its type requires: project for project accounts, provider account with country and direction for float accounts, settlement destination for settlement accounts. Types are project available, project reserved, float, processing revenue, platform revenue, fee expense, settlement, business capital, and suspense.

**Ledger entry** — entry type, occurrence timestamp, optional transaction, optional author, optional justification, optional entry it reverses, optional discrepancy that prompted it. The entry is the header; it carries no amounts.

**Ledger posting** — ledger entry, ledger account, debit or credit, amount. An entry holds two postings or more, and they sum to zero.

A collection illustrates why postings sit apart from entries. A counterparty-borne collection of 1000 at 2.5 percent processing, 0.5 percent platform and 2 percent provider produces one entry with five postings: the collection float is debited 1010, the project's available balance credited 1000, processing revenue credited 25, platform revenue credited 5, and fee expense debited 20. A structure holding one debit account and one credit account per row could not express it.

**Ledger checkpoint** — ledger account, balance, the entry it includes up to, timestamp.

### 13.8 Treasury operations

**Float threshold** — float account, target and minimum periods of cover, optional manual override amount.

**Float transfer** — provider account, source and destination float accounts, amount, optional provider fee, status, execution path of platform or registered, initiating administrator, resulting ledger entry, confirmation timestamp.

**Cashout** — float account, settlement account, amount, status, destination reference, initiating administrator, optional approving administrator where the threshold required one, supporting document reference, resulting ledger entry, confirmation timestamp.

### 13.9 Reconciliation

**Reconciliation run** — provider account, mode of automated or manual, optional statement import, period covered, start and finish timestamps, status, counts of records compared and discrepancies raised.

**Statement import** — provider account, file reference, checksum, declared period, row count, rows rejected, uploading administrator, resulting run, status. The checksum prevents one statement being processed twice.

**Discrepancy** — raising run, type, subject reference, optional transaction, fingerprint over type, subject and difference, expected value, observed value, difference, status of open, under review or resolved, optional assignee, first and last detected timestamps, count of runs that have seen it, decision of accepted or rejected, whether an adjustment was posted, optional resolving ledger entry, optional resolving administrator, optional approving administrator, decision timestamp.

The fingerprint is what lets a later run recognise a finding already raised. A difference that changed produces a new discrepancy rather than updating this one.

**Discrepancy comment** — discrepancy, author, body, timestamp. A discrepancy carries one comment at minimum, since neither outcome is recorded without one.

### 13.10 Administration

**Administrator** — name, email address, status.

**Administrator session** — administrator, issue and expiry timestamps, optional revocation timestamp and revoking administrator, originating address, client description.

**Authentication event** — the email address presented, the administrator where one matched, outcome of success, failure or refusal against a locked account, reason, originating address, client description, timestamp. Failures record the address presented even where no administrator matches it, since repeated attempts against an unknown address are themselves the signal.

**Role** — name, description, seeded flag.

**Role permission** — role, permission key.

**Role assignment** — administrator, role, scope type of all, projects or provider accounts, granting administrator.

**Role assignment scope** — role assignment, and the project or provider account it names.

**Operation confirmation** — administrator, operation type, subject reference, fingerprint of the submitted values, issue and expiry timestamps, attempts made, outcome of confirmed, expired, abandoned or exhausted. Bound to one operation and consumed by it.

**Export record** — administrator, subject of the export, filters applied, row count, environment, signature, timestamp. Kept so a file presented later can be checked against what was produced.

**Audit record** — actor, action, subject type, subject identifier, prior state, new state, optional operation confirmation, optional approving administrator, timestamp.

**Alert policy** — category, minimum severity, groups notified, acknowledgement required, escalation period, escalation group. A category without an active group is refused.

**Alert group** — name, description, active flag.

**Alert group member** — group, administrator.

**Alert group address** — group, channel, address, active flag. One address per channel the group uses.

**Alert** — category, severity, subject reference, fingerprint of the condition, reference to the console operation that addresses it, raised timestamp, last seen timestamp, occurrence count, status of open, acknowledged or cleared, optional acknowledging administrator and timestamp, optional cleared timestamp.

**Alert delivery** — alert, group, channel, address, attempt number, status, response, timestamp.

**Notification delivery** — transaction, endpoint, event type, payload, attempt number, response status, status, delivery timestamp, next attempt timestamp.

### 13.11 Invariants

- Postings within one ledger entry sum to zero.
- Ledger entries and postings are never updated or deleted. Correction writes a reversing entry.
- One version per route and per entitlement is open at any moment.
- A transaction references a route version, never a route alone.
- A preview confirms once, producing at most one transaction.
- A project reference is unique within its project.
- Payer identifiers are stored in normalised international form, never as supplied.
- A project holds at most one primary and one secondary credential, and at least one active credential in production.
- A float account's type determines which scope columns are present, and no float account omits provider account, country, currency or direction.
- Amounts are integers in minor units, and no monetary field stands without its currency.
- A transaction in a terminal state carries either a settled amount or a failure reason.

---

## 14. Non-functional requirements

### 14.1 Availability and recovery

The project interface and the console carry different obligations. A console outage delays administrative work; a project interface outage stops payments in products that depend on it.

| Component | Target |
|---|---|
| Project interface | 99.5 percent monthly |
| Console | 99 percent monthly |
| Reconciliation and reporting | Best effort, subject to recovery within one working day |

Provider availability bounds our own. A route whose only provider is unreachable serves nothing, however healthy the platform is, and fallback across providers is what turns a provider outage into a degradation.

Recovery targets treat the ledger as the record that must survive intact:

- **Recovery point** — near zero for the ledger and transactions, through continuous archiving of the write-ahead log
- **Recovery time** — four hours to a working platform
- **Backups** — daily snapshots alongside continuous archiving, retained thirty-five days, held in a location separate from the running system
- **Restore rehearsal** — quarterly, into a scratch environment, recovering the key store alongside the database and verifying that balances reconstruct to the same figures

A restore procedure that has never been executed is a hypothesis rather than a capability, which is the reason the rehearsal appears here as a requirement.

**A restore is followed by reconciliation before the platform resumes serving.** Recovering to a point some minutes in the past leaves the providers holding transactions from the interval that the platform has no record of: payments confirmed, disbursements sent, fees charged. Reconciliation against every provider account over the interval is what recovers them, and resuming without it leaves those transactions permanently invisible and the ledger short by their value. Recovery is complete when the reconciliation is, rather than when the database is back.

**Key material is part of the backup rather than separate from it.** Provider credentials and signing secrets are held encrypted under keys in the key store, so a database restored without the corresponding keys yields records that cannot be read. The key store's own backup, and the procedure for recovering it, belong to the same plan and the same rehearsal.

**Backups and retention answer different obligations.** The thirty-five days above serve recovery from failure. The ten-year term of section 14.3 serves the obligations attaching to accounting records, and is met by archival that does not roll off, held apart from the backup cycle.

### 14.2 Performance

| Operation | Target |
|---|---|
| Preview | 300 ms at the 95th percentile |
| Confirmation | 2 seconds at the 95th percentile, excluding time spent at the provider |
| Transaction read | 200 ms at the 95th percentile |
| Settings read | 100 ms at the 95th percentile |
| Console report | 3 seconds at the 95th percentile |

Preview reaches no provider. It resolves configuration, validates, and computes, all against data the platform holds, which is what allows a target a provider call could never meet.

Confirmation is dominated by the provider. Calls to a provider carry a connection timeout of 5 seconds and a read timeout of 30 seconds, and a read timeout produces an undetermined outcome in place of a failure.

Initial capacity targets 20 transactions per second sustained with bursts to 100, sized to exceed the combined load of the company's products with room to grow.

### 14.3 Retention

| Data | Retained |
|---|---|
| Transactions, previews, attempts, ledger entries | Ten years |
| Audit records, authentication history | Ten years |
| Raw provider requests and responses | 90 days |
| Alerts and their deliveries | Two years |
| Application logs | 90 days |

Ten years matches the retention required of accounting records across the OHADA region, and should be confirmed against current obligations before launch. It is met by archival held apart from the backup cycle of section 14.1, since backups roll off after thirty-five days and serve recovery rather than retention.

The thirteen-month horizon of section 5.5 governs the uniqueness constraint on a project's own references, allowing one to be reused after that period. The transaction itself persists for the full retention term.

### 14.4 Security requirements

- Transport secured throughout, with connections below the current minimum version refused
- Database encrypted at rest, and payer identifiers encrypted at the column level
- Provider credentials and signing secrets held under envelope encryption in a managed key store, absent from configuration files and from the database in readable form
- Project secrets stored under a password hashing function designed for the purpose
- Keys rotated on a defined schedule, with rotation exercised before launch in place of documented alone
- Dependencies scanned continuously, with a defined window for applying security patches
- An independent security assessment completed before the first live transaction

Card data never enters the platform, so the obligations attaching to card handling do not arise. Mobile money credentials likewise stay with the operator; the platform holds a telephone number and a provider reference.

### 14.5 Observability

Every request carries a correlation identifier that follows the payment from preview through confirmation, each provider attempt, the inbound notification, and the outbound notification to the project. One identifier retrieves the whole history of a payment across every component.

Logs are structured, carry the transaction reference, and mask payer identifiers to their final digits. Secrets, codes, and browser addresses are absent from them entirely, since a log aggregator is read by more people than a database.

The measures of section 8.5 are exported as metrics rather than computed at read time, so alerting evaluates them continuously. Traces cover the payment path, where the question is usually which leg consumed the time.

### 14.6 Operational constraints

All timestamps are stored in Coordinated Universal Time and rendered in the operator's own zone. Rolling windows, preview expiry, and velocity caps all compare instants, and a platform spanning several countries has no single local day to reason in.

Deployments occur without interruption to the payment path, and schema changes remain compatible with the version they replace, because transactions are in flight during every deployment and a reservation raised by one version is settled by another.

---

### 14.7 Configured values

The platform's behaviour rests on a number of periods, limits, and thresholds named throughout this document. They are gathered here with the values they take and the reasoning behind each.

Every value is configurable, and those governing float cover and margin warrant revisiting once several weeks of traffic exist, since both depend on volumes the platform has yet to see. Monetary figures are stated in XAF, apply at the same figure in XOF, and convert for other currencies through the reporting rate table.

| Setting | Value | Reasoning |
|---|---|---|
| Session idle timeout | 30 minutes | Long enough for interrupted console work, short enough that an unattended screen closes itself |
| Session absolute lifetime | 12 hours | Covers a working day without carrying a session overnight |
| Project token lifetime | 1 hour | Short enough that a captured token has limited use, long enough that exchanges stay rare |
| Token exchange limit | 10 per minute per credential | Well above what any correct client needs, low enough to catch a client exchanging per call |
| Live token alert | Above 20 concurrent tokens on one credential | A signal that a client is exchanging where it should be holding |
| Failed sign-in lockout | 5 failures in 15 minutes, locking 30 minutes | Absorbs a forgotten password, stops sustained guessing |
| Operation confirmation validity | 5 minutes, 3 attempts | The administrator requested it deliberately and is at the console |
| One-time code window | 5 minutes from initiation, 3 attempts | Matches the period an operator's own code stays valid |
| Browser step window | 10 minutes from initiation | The payer loads a page and may authenticate with their operator |
| Preview alert | 5 previews expiring unconfirmed on one identifier within an hour | A payer who saw a price five times and never paid is a signal about the route |
| Cashout second approval | Above 500,000 XAF | Requiring it on every cashout is defensible while volumes are low |
| Adjustment second approval | Above 100,000 XAF | Lower than cashouts, since an adjustment corrects the record rather than moving funds outward |
| Float cover target | 7 days | Topping up a provider wallet runs through a bank and takes time |
| Float cover minimum | 3 days | Leaves room to fund before a route stops serving |
| Circuit breaker | 5 failures in 5 minutes marks degraded; a successful probe every 2 minutes restores | Distinguishes a provider incident from isolated failures |
| Status sweep ceiling, collections | 2 hours | Comfortably beyond the payer action window, after which nothing further will change |
| Status sweep ceiling, disbursements | 6 hours | Accommodates providers that settle in batches |
| Negative margin alert | Cumulative shortfall above 25,000 XAF on one route in 24 hours, or a route running negative for 6 hours | Catches erosion at a scale worth acting on, and at a duration that outlasts a transient provider variance |
| Critical alert acknowledgement | 30 minutes before escalation | Long enough to act, short enough that a night-time condition reaches someone else |
| Alert quiet period | 24 hours before re-notifying an unchanged condition | Keeps a persistent condition visible without flooding the channel |

Two ordering constraints bind these. Each payer action window sits inside the corresponding sweep ceiling, so a transaction never moves to undetermined while the payer still holds a valid code. The float cover minimum sits below the target, since the target is what a proposed transfer restores.

---

## 15. Technical architecture

This section records the shape the platform takes, the technology chosen, and the reasoning behind each. The properties named alongside a choice are what the choice exists to deliver, and a substitution that preserves them is sound.

The platform is written in TypeScript on NestJS, over PostgreSQL. One language serves the project interface, the console's server side, and the background work, which suits a small team and keeps the money path expressed once. Section 15.7 names the discipline that choice requires.

### 15.1 Shape

The platform deploys as one application built from a single codebase, running as two kinds of process: one serving requests, exposing the project interface and the console, and one carrying background work. NestJS module boundaries inside it separate configuration, treasury, transactions, providers, and reconciliation.

A single codebase is recommended over separate services for the first version. Reservations, ledger postings, and transaction state changes must commit together or not at all, and distributing them across services replaces a database transaction with a distributed protocol before there is any load justifying it. Module boundaries preserve the option of separating later.

The background process carries the status sweep, notification delivery, reconciliation runs, alert evaluation and delivery, and float cover calculation. It is deployed apart from the request-serving process because the two scale on different signals: request capacity follows traffic, while background work follows the volume of transactions already in flight.

### 15.2 Data store

A relational store with transactional guarantees is a requirement rather than a preference, and PostgreSQL serves it.

The properties that must hold:

- A reservation, its ledger postings, and the transaction that caused them commit atomically
- The check-and-reserve sequence of section 4.6 holds a row-level lock on the float account for its duration
- Monetary values are stored as 64-bit integers in minor units, with no floating point anywhere in the money path
- Ledger entries and postings are append-only, enforced by permission rather than by convention

### 15.3 Asynchronous work

Work deferred beyond a request — notifying a project, sweeping for status, running reconciliation, delivering an alert — is enqueued in the same database transaction that produced it. A state change that commits while its notification is lost, or a notification sent for a state change that rolled back, are both avoided by giving them one transaction rather than two systems.

The queue is held in PostgreSQL, with workers claiming jobs under a row lock that skips rows already claimed. This is what makes transactional enqueueing possible at all: a job written in the same transaction as the state change commits or rolls back with it, where a separate broker would require an outbox to reach the same guarantee. Mature job libraries for this pattern exist and are preferable to writing one.

A dedicated broker becomes worthwhile at volumes well beyond the initial capacity target, and the pattern of enqueueing transactionally survives the move.

Notification delivery retries on a widening interval, and each attempt is recorded per section 7.3.

### 15.4 Concurrency and idempotency

Correctness under concurrency rests on constraints in the store rather than on checks in application code, since a check performed in memory holds only for the instance that performed it:

- A project's own reference is unique within that project and within the retention horizon
- A preview confirms once, enforced by a conditional transition on its status
- A float account admits one check-and-reserve at a time, held under an advisory lock keyed on the account and released with the transaction
- A velocity cap is evaluated under a lock held on the entitlement, so simultaneous confirmations cannot each observe the same remaining allowance
- The duplicate payment guard of section 5.5 is evaluated under the same lock, for the same reason
- Inbound provider notifications are processed idempotently by provider reference and event, since a provider may deliver the same event more than once and two instances may receive the duplicates at once
- One open alert exists per condition fingerprint, so simultaneous evaluations raise one alert
- One reconciliation run is in progress per provider account
- Ledger postings within an entry sum to zero, enforced at write

Expiry is compared against the store's clock in place of an instance's own, since previews, payer action windows, and velocity windows are evaluated by whichever instance receives the request.

### 15.5 Provider integration

Each provider sits behind an adapter presenting the contract of section 11. Outbound calls carry explicit timeouts, and retries apply only where repeating the call cannot move money twice. A provider account accumulating failures trips the circuit breaker of section 5.4 and is skipped until a probe succeeds. Breaker state is held in shared storage, so every instance observes one view of a provider's health and a degraded provider is skipped everywhere at once.

Provider credentials are read from the key store at use. Access tokens are cached for the lifetime the provider grants them and renewed before expiry rather than at it, so a token never lapses while requests are in flight.

Where a provider permits several tokens to be valid at once, as the first integration does through the rotation described in section 12, each instance holds its own token and no coordination arises. A provider keeping one token active per client would instead require a shared token and a lock held across renewal, since each authentication would otherwise invalidate the token the other instances hold. The adapter declares which behaviour its provider exhibits.

### 15.6 Running more than one instance

Instances are interchangeable, and no instance holds state another instance needs. Requests reach whichever is available, and correctness follows from the store in place of from instance memory.

The money path satisfies this as specified. The float lock, the atomicity of ledger postings, and the uniqueness constraints of section 15.4 are enforced by the store and hold however many instances contend for them.

Four kinds of state require placing deliberately:

**Scheduled work** runs once rather than once per instance. Each due job is claimed under lock before it is carried out, and a claimed job is invisible to another instance. This applies to the status sweep, reconciliation runs, alert evaluation, and float cover calculation alike.

**Queued work** is consumed under the same discipline, so a notification is delivered once even where several background processes are running.

**Provider session state** requires placing according to the provider. Circuit breaker counters live in shared storage always, since counters held per instance would leave one instance skipping a provider while another continued calling it. Access tokens live per instance where the provider permits several to be valid at once, and in shared storage under a renewal lock where it does not, per section 15.5.

**Rate limit counters and console sessions** live in shared storage. Counters held per instance multiply a project's effective limit by the number of instances, and sessions held per instance require requests to return to the instance that issued them.

Timing follows the store's clock rather than an instance's, so two instances disagreeing by seconds cannot reach different conclusions about whether a preview has expired.

### 15.7 Handling money in TypeScript

The language has one numeric type, and it is a floating point number. Nothing in the platform's amounts approaches the precision limit, since the largest figures the platform will hold sit far below the point at which integers stop being exact. The hazard is arithmetic rather than magnitude: a percentage applied to an amount produces a fraction, and a fraction stored as an amount is a rounding error that reconciliation will eventually find.

Four measures keep the money path exact:

- **Amounts are integers in minor units**, as section 15.2 requires, and are read and written as such at every boundary. A value arriving from the database, from a provider, or from a project is validated as an integer before anything else happens to it.
- **Percentages are stored as integers too**, in hundredths of a percent, so a rate of 2.5 percent is held as 250. Configuration then carries no fractional value at all, and the rounding rule of section 4.2 applies at exactly one point: the moment a fee is computed.
- **Fee arithmetic lives in one module**, which takes integers and returns integers, applies the half-up rule, and records the remainder. Every fee in the system is computed by that module and nowhere else.
- **Arithmetic on monetary values elsewhere is refused by lint**, so the discipline holds against the ordinary erosion of a codebase rather than resting on everyone remembering it.

The database enforces what it can: monetary columns are 64-bit integers and reject a fractional value outright. The measures above are what keep a fraction from reaching them.

### 15.8 Verification

Beyond ordinary testing, three properties warrant direct verification:

- Ledger invariants, being that postings sum to zero and that every account's balance equals the sum of its postings
- Solvency, being that no sequence of collections, disbursements, transfers, and cashouts leaves float below the balances it backs
- Concurrency, being that simultaneous disbursements against one float account never jointly exceed it

The simulator adapter of section 11 serves these, alongside its role in the sandbox deployment.

---

## 16. Build sequence

Each stage below ends in something that works, and the ordering follows what each stage depends on rather than what is quickest to show. Two considerations shape it beyond dependency: properties that are expensive to introduce after the fact are built at the start even where nothing yet exercises them, and the paths where money can be lost come after the paths where it can be recovered.

The console is built through every stage in place of forming one of its own. Each stage names the surfaces it adds, and each is delivered alongside the behaviour it administers, since a capability nobody can see or operate is untested by the people who will rely on it.

### 16.1 Foundations

Two environments, the deployment path, the database, the key store, backups, and a restore rehearsal carried out once before anything depends on it. Administrator accounts, authentication, sessions, and the audit record.

The reference catalogue is seeded: countries with their codes and dialling prefixes, currencies with their decimal counts, payment methods, and the route entries from the commercial annex with their corrections.

Administration runs on a single role holding every permission at this stage. The audit record exists from the first day regardless, because every subsequent stage touches configuration that governs money, and attribution added later covers none of what came before.

*Console:* sign-in, administrator accounts, the reference catalogue as read-only views, and the audit record.

*Delivers:* a deployable platform holding its catalogue and recording who did what.

### 16.2 Collections

The first paying route, one project, one provider.

Project credentials, token exchange, declared origins. Preview, confirmation, status, listing, and settings. The provider adapter covering authentication, submission, and status. The status sweep. Notification delivery to the project.

The ledger arrives whole: accounts, entries, postings, checkpoints, and the collection posting of section 6.1. Introducing double-entry over transactions already recorded means reconstructing history from records that were never designed to carry it, so it is built before the first transaction rather than after the first thousand.

Alerting at this stage is a message to one address. The routing of section 8.6 comes later.

*Console:* transaction search and detail, project records, credential issue and rotation, declared origins, route and binding views, and project balances.

*Also delivered:* the interface specification, integration guide, and going-live checklist of section 7.5.

*First route:* MTN Mobile Money collection in Cameroon, in XAF. It completes on the standard pattern, with the payer acting on their handset outside the platform and the outcome arriving through a provider notification and the status check that follows. The annex marks it as requiring a browser step, which is confirmed as an artefact of the misaligned column recorded in section 12.

The interactive flows are therefore built later, and this stage carries the standard pattern alone.

*Delivers:* one internal product collecting real money, with every movement in the ledger.

### 16.3 Reconciliation

Statement import, the comparison, discrepancy records with their fingerprints and recurrence, the review queue with comments, and corrections reaching projects.

This precedes disbursements deliberately. An undetermined disbursement holds its reservation until reconciliation resolves it, so shipping disbursements first would ship a state with no exit: funds held, a payment of unknown outcome, and no mechanism to establish which. The order also means the collection path has been verified against the provider's own records before anything moves outward.

*Console:* statement upload, run history, and the discrepancy queue with assignment, comments, and per-item review.

*Delivers:* weekly proof that the ledger agrees with the provider, and a route for correcting it where it does not.

### 16.4 Disbursements

Confirmation of disbursements, reservation, the float liquidity check under its lock, suspense, and the undetermined state. Float accounts by direction, and float transfers registered by an administrator and verified by reconciliation.

*Console:* float accounts by direction, transfer registration, and reserved and suspended balances visible against the transactions holding them.

*Delivers:* products paying out, with reservations protecting against spending what is already committed.

### 16.5 Roles and alerting

Permissions as a catalogue, roles as editable data, scope by project and provider account, and confirmation of sensitive operations by one-time code.

Alert groups, policies, severities, and the alert lifecycle. Service health monitoring against baselines.

This precedes treasury operations because the two-person rules depend on it. An approval requirement means nothing while one role holds every permission and one person holds that role.

*Console:* the role editor, scope assignment, alert groups and policies, acknowledgement, and the health dashboards of section 8.5.

*Delivers:* a platform more than one person can operate safely, and one that reports its own condition.

### 16.6 Treasury operations

Cashouts under both the solvency and liquidity constraints, with second approval above its threshold. Float cover monitoring with its bands and proposed transfers. Business capital, project funding, float funding, and adjustments.

*Console:* cashouts with their approval path, the float cover dashboard, and funding and adjustment entry.

*Delivers:* the business withdrawing its earnings without compromising what backs project balances.

### 16.7 A second provider

The second adapter, fallback with its policy, the circuit breaker, and rate change sets.

None of this is exercised while one provider serves every route. Fallback across one binding is untestable, and a rate change set groups versions across an agreement that has yet to be signed.

*Console:* provider accounts, bindings with their priority ordering, operational status and manual suspension, and rate change sets.

*Delivers:* a provider outage becoming a degradation in place of a stoppage.

### 16.8 Breadth

Remaining countries and payment methods, the interactive route flows not already built, refunds, reporting depth, and the per-project fee overrides.

*Console:* reporting across every dimension, margin analysis, and refund initiation.

### 16.9 Environments and availability

The two deployments of section 2.3 exist from the first stage, and they open to their audiences at different moments.

| Moment | Sandbox | Production |
|---|---|---|
| End of foundations | Running, reachable by the team alone | Running, reachable by the team alone |
| End of collections | **Open to projects for integration** | First route live under a pilot: one project, one route, a capped transaction value, with every transaction checked by hand |
| End of reconciliation | Unchanged | **Open generally**, with the pilot's caps lifted |
| End of disbursements | Disbursement routes available | Disbursements enabled per project |

Sandbox opens first so integration work proceeds while production is still restricted. A project that has completed the going-live checklist against sandbox is ready for production credentials the moment its route is available.

The production pilot runs before reconciliation exists, which is acceptable at a volume someone can verify by hand and unacceptable beyond it. The capped value is what keeps that verification possible, and lifting the cap waits on the weekly comparison being in place.

### 16.10 Properties that resist deferral

Several things look postponable and are not. Each is inexpensive at the outset and costly once records exist that lack it.

| Property | Cost of adding it later |
|---|---|
| Double-entry ledger | History reconstructed from records never designed to carry it |
| Immutable configuration versions | Past transactions cannot be attributed to the terms that governed them |
| Uniqueness and locking constraints | Duplicates and overspend already in the data, requiring reconciliation to find |
| Audit record | No account of who changed what before it existed |
| Environment separation | Test traffic mixed into production figures, with no clean way to separate it |
| Normalised payer identifiers | One payer stored several ways, so duplicate detection and history are unreliable |
| Amounts as minor-unit integers | Rounding already applied and unrecoverable |

---

## 17. Planned iterations

Work identified during design, deliberately left out of the first version, and accommodated by the design as it stands.

**Deferred scope.** Automatic float transfers on threshold breach, currency conversion as a treasury operation, queuing of disbursements awaiting float, and console access for project teams. The project team role exists in the permission model, so enabling it later is a matter of interface work rather than design.

**ProxiaPay administration mobile application.** An application through which administrators receive alerts and carry out urgent work directly, in place of reaching a console from wherever they happen to be. Every alert carries a reference to the console operation that addresses it, per section 8.6, and that reference is what the application renders as an action. Approving a cashout, funding a float account, acknowledging a critical alert, and suspending a provider are the operations that most reward being available away from a desk, since each is time-sensitive and none takes long.

**Alert delivery to a chat platform.** Reaching the developers group on a chat platform in place of email alone requires giving that group an address on the new channel. A group holds one address per channel it uses, so the routing itself is unchanged.

---

## 18. Items to confirm

**Provider behaviour.** Three provider-side details remain undocumented: the call by which the provider accepts a submitted one-time code, the field carrying the address for a browser step, and whether the provider exposes a listing of transactions over a period. The first two are adapter concerns, neither affects the project interface, and neither falls in the first build stage, since the opening route completes on the standard pattern. The third decides whether reconciliation against this provider runs automatically or from uploaded statements, and the published interface shows no such listing, so manual comparison is assumed until confirmed otherwise. The documented examples use a currency without decimals, which leaves open whether the provider expects major or minor units for CDF and USD; a transaction on a two-decimal route settles it.

**Retention obligations.** The ten-year term of section 14.3 follows the retention required of accounting records in the OHADA region and should be verified against current obligations, along with any requirement attaching to payer identifiers held on behalf of the company's products.
