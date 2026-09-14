# ProxiaPay Console — Interface Specification

**Version:** 1.0
**Date:** September 2026
**Status:** Reviewed and complete.
**Companion to:** ProxiaPay Functional Specification, ProxiaPay API Reference

---

## 1. Introduction

### 1.1 Purpose

ProxiaPay is an internal payment platform that moves money between the company's software products and the mobile money operators serving Central and West Africa. It collects payments from customers, sends payments to recipients, holds the balances those movements create, and records every step.

This document specifies the web console through which the platform is operated: the screens it presents, what each shows, the actions it offers, and the permissions governing them. The behaviour behind those screens is defined in the functional specification, which this document refers to by section throughout rather than restating.

It is written for whoever builds the interface, and for the people who will use it to check that what is described matches the work they actually do.

### 1.2 What the console is for

Four kinds of work happen here.

**Configuration** sets what the platform will do: which countries are open, which routes exist, what they cost, which providers serve them, and which products may use them.

**Treasury** manages the money the platform holds: balances owed to products, funds sitting at providers, moving funds between provider wallets, and withdrawing the business's own earnings.

**Investigation** answers questions about individual payments: what happened, when, through which provider, at what cost, and why a particular one failed.

**Oversight** covers the platform's own condition: reconciliation against provider records, alerts, reporting, and the record of who did what.

Most time is spent reading. Configuration changes are infrequent and deliberate, treasury actions are occasional and consequential, and investigation is continuous. The interface is shaped accordingly.

### 1.3 Glossary

| Term | Meaning |
|---|---|
| **Administrator** | A person with access to the console. |
| **Binding** | The association of a provider account to a route, carrying that provider's expected fee and its position in the fallback order. |
| **Collection** | A payment taken from a customer's mobile money wallet. Also called a payin. |
| **Cashout** | A withdrawal by the business of collected funds from a provider to a bank or cash destination. |
| **Cover** | The period a provider wallet can sustain payouts at its recent rate before running empty. |
| **Platform fee** | What ProxiaPay charges a project for the service itself. |
| **Processing fee** | What ProxiaPay quotes a project to cover a provider's cost. |
| **Discrepancy** | A difference between the platform's records and a provider's, raised by reconciliation for someone to decide on. |
| **Disbursement** | A payment sent to a recipient's mobile money wallet. Also called a payout. |
| **Entitlement** | Permission granted to one product to use one route. |
| **Float** | Money held at a provider, in a wallet belonging to one country, currency and direction. |
| **Ledger** | The record of every movement of money, written once and never altered. |
| **Permission** | The right to perform one named operation in the console. |
| **Preview** | A quotation a product requests before taking a payment, fixing the amount and fees for fifteen minutes. |
| **Project** | One of the company's products, consuming the platform through its programmatic interface. |
| **Provider** | An external payment company the platform calls to move money. |
| **Reconciliation** | Scheduled comparison of the platform's records against a provider's. |
| **Role** | A named set of permissions, assigned to administrators. |
| **Route** | A way to move money, being one country, currency, payment method and direction together. |
| **Route version** | An immutable record of a route's configuration over a period. |
| **Scope** | The projects or provider accounts an administrator's role applies to. |
| **Transaction** | One payment, in either direction. |

---

## 2. Principles

**Money is shown unambiguously.** Every monetary figure carries its currency. Every total states what it covers and over what period. A figure limited by the viewer's scope says so beside itself, so a partial total is never mistaken for a platform total.

**Records that cannot be edited are not presented as editable.** Configuration versions, ledger entries, and transaction history are written once. The interface offers *open a new version* where a lesser system would offer *edit*, and presents history as a sequence rather than as a current value with a hidden past.

**Consequential actions show their consequence first.** Anything that moves money, changes what a route charges, or alters who can do what presents the resulting state before it is committed. A cashout shows the balance it leaves behind; a route version shows what changed against the version it replaces.

**Provenance travels with the record.** Every figure and every change carries who, when, and why. An administrator investigating a payment six months later should need nothing beyond the screen in front of them.

**Permissions and scope behave differently.** An action the administrator lacks permission for is visible and inactive, with a note naming the permission, since knowing a capability exists is how someone knows what to request. Data outside their scope is absent entirely, since it belongs to someone else.

**The environment is unmistakable.** Production and sandbox are separate deployments with distinct addresses, and the console carries a persistent band naming the environment. Sandbox figures reaching a report presented as production is the mistake this prevents.

---

## 3. Structure

### 3.1 Navigation

Seven areas:

| Area | Covers |
|---|---|
| Home | Condition summary, outstanding work, and the approval queue |
| Transactions | Search, detail, previews |
| Projects | Products, credentials, origins, entitlements |
| Configuration | Countries, methods, routes, providers |
| Treasury | Balances, float, transfers, cashouts, funding |
| Reconciliation | Runs, statements, discrepancies |
| Oversight | Alerts, health, reporting, exports, administrators, audit |

An area is present where the administrator holds at least one permission within it.

### 3.2 Global search

A single field accepting any reference the platform knows: a transaction reference, a project's own reference, a provider's reference, an operator's reference where one was captured, a preview reference, or a payer's telephone number. It resolves to the matching record, or to a list where a number matches several.

Support work begins with a customer quoting a number or a reference, so this is the most travelled path in the console and warrants being present on every screen. The reference a customer holds is usually the operator's, taken from their confirmation message, which is why it is searchable alongside the platform's own.

Searching by telephone number requires the permission covering unmasked payer identifiers, and the search is recorded.

### 3.3 Conventions

**Amounts** are displayed with their currency code and the decimal places that currency uses. Ledger and treasury screens show full precision without abbreviation.

**Language.** The console operates in French and English. Each administrator chooses theirs, the choice persists on their account rather than on the browser, and it may be changed at any time.

Interface text is translated. Content people entered stays as they wrote it: project names, route notes, justifications, discrepancy comments, and provider messages appear in the language of whoever typed them, since translating a justification would misrepresent what its author said.

Numbers and dates follow the chosen language, so the decimal mark and the grouping of thousands differ between the two. Currency codes stay as codes in both, and every amount carries one, so a figure is unambiguous whichever language rendered it.

Messages the platform sends an administrator, being alerts and one-time codes, follow that administrator's chosen language. An alert reaching a group at a shared address uses English, since no single recipient owns it.

English is the default. A new administrator starts there and changes it if they prefer.

**Timestamps** are displayed in the administrator's own time zone, with the zone named, and show the underlying value in Coordinated Universal Time on hover.

**Tables** carry filters appropriate to their content, sort on their significant columns, paginate, and export where the data is something someone will work with elsewhere. Exports are offered as CSV and as a spreadsheet file, the first for anything that will be read by another system and the second for work an accountant will do by hand.

Every export carries a block naming what produced it: an export identifier, the administrator who requested it, the time, the environment, the filters applied, and a signature the platform computed over the rows. The signature covers the data and excludes the block holding it.

The filters make a figure reproducible, and the signature makes the file verifiable. A spreadsheet of transactions circulating by email for three weeks, quoted in a meeting, and questioned afterwards is the ordinary case, and both halves of that block answer the question it raises. The platform keeps a record of each export, so a file can be checked against what was actually produced.

**Empty states** describe what would appear and what produces it, rather than presenting an empty frame.

---

## 4. Signing in and home

### 4.1 Signing in

An administrator signs in with their email address and password, then supplies a second factor. Both are required in every environment.

The screen offers French and English before authentication, since an administrator who has never signed in has no stored preference yet, and the choice made here is remembered on the account after the first successful sign-in.

A failed attempt reports that the address and password did not match, naming neither which of the two failed nor whether the address is known, since distinguishing them tells an attacker which addresses exist. After the configured number of failures the account locks for its period, and the screen says the account is locked and when it will open, since a person who has genuinely forgotten their password needs to know waiting will help.

Every attempt is recorded, and the record reaches the security alert category where a run of them accumulates.

**Actions:** request a password reset, which sends a link to the address on file and reveals nothing about whether that address belongs to an administrator.

### 4.2 Home

The first screen after signing in. It presents cards, each drawn from an area the administrator has permission to see, so a finance administrator and a developer arrive at different screens.

| Card | Shows | Permission |
|---|---|---|
| Awaiting your approval | Requests where this administrator can act as the second approver | The corresponding approve permission |
| Open alerts | Count by severity, with the most recent critical alerts named | Read alerts |
| Float cover | Accounts in the watch and critical bands, ordered by cover ascending | Read float |
| Coverage ratio | Total float against encumbered balances, per currency | Read float |
| Open discrepancies | Count by type, and those assigned to this administrator | Read runs and discrepancies |
| Today's activity | Transaction count and value by direction, with success rate against its baseline | Read reports |
| Earnings and cost recovery | Platform revenue for the period, and margin as a separate figure, each per currency | Read reports |
| Provider status | Each provider account as active, degraded, or suspended | Read provider accounts |

The approval card comes first. Work waiting on a named person is the one thing a console should not let them miss.

The earnings card keeps its two figures apart deliberately. **Platform revenue** is what ProxiaPay earned for the service. **Margin** is the processing fee less what providers actually charged, and it measures whether cost recovery is working. Presenting them as one number would let a provider raising its rate appear as the platform earning less, which it is not, and would hide a route running below cost behind a healthy earnings figure. Margin may be negative, and the card shows it as such rather than flattening it into a total.

This set is a starting point. Which cards people actually want is learned by watching them work, and the screen is worth revisiting once it has been used for a few weeks.

### 4.3 Approval queue

Every request awaiting a second approver, in one place: cashouts and adjustments above their thresholds, discrepancy resolutions above theirs, and changes to roles carrying treasury or administration permissions.

**Columns:** what is requested, the amount or subject, the initiating administrator, when it was raised, and how long it has waited.

Opening one presents exactly what the initiator saw, together with their name and their justification, and the two actions of section 11.2.

Requests this administrator initiated appear in the list, marked as their own and without the actions, since seeing that a request is waiting is useful even where acting on it is refused.

The queue shows age prominently. A cashout waiting three days is usually a request nobody knew was theirs to approve, and the age is what surfaces that.

---

## 5. Transactions

### 5.1 Transaction search

A filtered table across projects within the administrator's scope.

**Filters:** state, reconciliation status, direction, project, country, payment method, provider account, currency, date range, amount range, failure reason.

**Columns:** reference, project, direction, route, requested amount, state, reconciliation status, created, terminal.

**Actions:** open a transaction; export the filtered set.

### 5.2 Transaction detail

The most used screen in the console. It answers, without navigation, what happened to one payment.

**Header** — the platform's reference, the project and its own reference, direction, route, state, reconciliation status, and the amount as the payer or recipient experienced it.

**Amounts** — requested, charged, settled, processing fee, platform fee, the bearer resolved for each, expected provider fee, actual provider fee, and margin, each labelled with its currency. The bearers are what explain why the charged and settled figures differ from the requested one. Margin is the processing fee less the actual provider fee, and the platform fee sits beside it rather than within it, since one measures cost recovery and the other is earnings. Where the actual provider fee differs from the expected, the difference is marked and links to the discrepancy if one exists.

**Timeline** — every state change in order, each with its source (the provider's response, an inbound notification, a scheduled status check, reconciliation, or a named administrator) and its time. One-time code submissions appear here as attempts, without the codes themselves.

**Attempts** — one row per provider attempt, showing the provider account, its reference, the operator's own reference where the provider passed one through, the fee terms in force for that attempt, the outcome, and the duration. A transaction that fell back to a second provider shows both, and the attempt whose fees were recorded is marked.

**Configuration in force** — the route version that governed this payment, the fee bearer resolved for it, and the limits checked, each linking to the record. This is what makes a six-month-old transaction explicable.

**Payer** — the identifier masked to its final digits, with a control to reveal it. Revealing requires the corresponding permission and is recorded against the administrator.

**Provider exchanges** — the raw requests and responses, behind its own permission, retained for the period named in the functional specification.

**Ledger entries** — every entry this transaction produced, with its postings, linking to the accounts affected.

**Actions:** force a status re-check; replay the notification to the project; initiate a refund where the transaction is a completed collection.

An address issued for a browser step is absent from this screen entirely, since it authorises the payment for whoever holds it, and no permission reveals it.

### 5.3 Previews

Previews are searchable alongside transactions, including those that expired without being confirmed. The list shows the project, route, amount, payer identifier, status, and the transaction it produced where it was confirmed.

The value of this screen is the unconfirmed ones. A payer previewing the same payment repeatedly without completing is a signal about a route or about a wall they have hit, and the pattern is visible only where the record persists.

---

## 6. Projects

### 6.1 Project list

Name, status, transaction volume and value over a period, balances by currency, and the count of routes granted.

### 6.2 Project detail

**Summary** — name, status, when created, and balances available and reserved per currency.

**Credentials** — each with its key, role of primary or secondary, status, who issued it and when. The secret appears once, at issue, and never again.

Actions: issue a credential, which enters as secondary; promote a secondary to primary, which returns the former primary to secondary; delete a retired credential; revoke a credential outright.

The screen presents the rotation as a sequence with its current position marked, so the state of a rotation is read rather than deduced. Deleting a project's only credential, and deleting one currently primary, are offered as inactive with the reason stated.

Issuing, promoting, deleting, and revoking each require a one-time code.

**Declared origins** — the addresses and ranges this project calls from, with a description against each. At least one is required in production. Recent refusals on origin are listed beneath, since a refusal usually means infrastructure changed without the declaration following it.

**Entitlements** — the routes granted to this project, each with its amount limits, velocity caps, and any override on either fee's rate or bearer, and the history of each grant. An overridden value is shown beside the route's own, so it is apparent what this project is quoted and how it differs.

Actions: grant a route; amend a grant, which opens a new version in the manner of section 7.2; deactivate a grant. Amending presents the current values and a comparison before committing, and the screen names the transactions currently in flight under the grant, since those complete under the terms they began with.

Granting a processing rate below what the route's provider is expected to charge warns before committing and names the shortfall per transaction, in the same manner as the route editor. A rate set here would otherwise place a route below cost without the route's own terms changing.

**Notification endpoint** — the address the platform sends events to, whether a signing secret is set, and the recent delivery history with response codes. The secret is displayed once when generated and never again. Actions: set the address, regenerate the secret, replay a delivery.

Regenerating is a coordinated act rather than a casual one. A secret that was never recorded cannot be recovered, only replaced, and from the moment of replacement the project's signature checks fail until it deploys the new value. The screen says so before committing, and the confirmation names the project so the person regenerating knows whose deliveries they are about to interrupt.

**Activity** — recent transactions, filtered to this project.

---

## 7. Configuration

### 7.1 Countries and payment methods

A table of countries with their codes, dialling prefix, currencies, and active state, and a table of payment methods with their codes.

Actions: add a country or payment method to the catalogue; amend its display details; activate or deactivate a country. Codes are fixed once a route references the record, since a route's identity rests on them.

Deactivating a country halts new transactions across every route within it. The confirmation names how many routes and which projects are affected, and states the count of transactions currently in flight, since those continue to completion.

### 7.2 Routes

**Route list** — country, currency, payment method, direction, the processing and platform fees currently in force, the provider serving it, active state, and volume over a period. Filters on every column. Routes carrying a platform fee above zero are distinguishable at a glance, since which parts of the catalogue earn and which merely recover cost is a question asked often.

Routes whose current version carries indicative rather than contracted terms are marked, so it is apparent which parts of the catalogue still run on figures from a commercial proposal.

**Route detail** — the current version in full, with its processing and platform fee terms, the bearer of each, amount limits, payer interaction requirements, active state, and its ordered bindings.

Projects holding their own rates on this route are listed beneath, with what each is quoted, since a route's own terms describe the default rather than what every project pays.

Beneath it, the version history as a sequence: each version with its validity period, the administrator who opened it, the note they left, and a comparison against the version before it. Any version can be examined in full.

**Opening a new version** presents the current values for amendment. Before it is committed, the screen shows a comparison of what changes, and a note is required. The interface offers no path to alter an existing version, since the transactions referring to it describe terms that were true at the time.

Where a binding's expected provider fee exceeds the route's processing fee, the screen warns before committing, names the shortfall per transaction, and requires the administrator to accept it deliberately.

**Bindings** are ordered within a version, each showing its provider account, expected fee terms, indicative or contracted status, enabled state, and any narrower limits. Reordering them changes which provider is tried first, and is itself a new version.

### 7.3 Rate change sets

A commercial agreement settles terms across many routes at once. A rate change set selects the affected routes, applies the new terms, and opens every version together.

The screen shows the routes selected, the change to each, an effective date, a note, and a reference to the agreement. It commits as one action, and the resulting versions each link back to the set.

The list of past sets serves as the record of the platform's commercial history.

### 7.4 Provider accounts

**List** — provider, name, operational status, and the countries and methods within its declared scope.

**Detail** — the declared scope, the base address, the capabilities the adapter reports (whether wallet transfers are exposed, whether transactions can be listed, whether a test environment exists), and the routes currently bound to it.

Credentials are shown as present or absent and never displayed. Replacing them requires a one-time code.

Recent failures and the circuit breaker state appear here, with the count within the window and whether the account is currently skipped.

**Actions:** suspend the account, which removes it from selection across every route at once; restore it. Suspension is the response to a provider incident, and it is deliberately one action rather than an edit to each affected route.

---

## 8. Treasury

### 8.1 Balances

Project balances, available and reserved, by project and currency. Selecting one shows the ledger entries behind it, most recent first, each linking to the transaction or administrative action that produced it.

### 8.2 Float

Every float account, being one provider account, country, currency and direction, with its wallet balance, free liquidity, cover, and band. Ordered by cover ascending, so the accounts closest to empty appear first.

Selecting one shows its entries, its recent outflow rate, the target and minimum periods configured against it, and any manual override.

The coverage ratio, being total float against encumbered balances, appears per currency at the head of the screen. A ratio below one means project balances exceed what backs them, and the screen says so plainly.

**Actions:** propose a transfer from the paired collection wallet; adjust the cover periods for this account.

### 8.3 Float transfers

Moving funds between two wallets at one provider, most often from collection to disbursement.

Where the provider exposes transfers, the platform performs it. Where it does not, an administrator performs it in the provider's own console and registers it here, and it stays pending until reconciliation observes the corresponding change in both wallet balances.

The form names the source and destination, the amount, and any fee the provider charges, and shows the resulting balances on both sides before committing. It requires a one-time code.

The list shows transfers with their status, whether the platform executed or an administrator registered them, and the reconciliation run that confirmed each.

### 8.4 Cashouts

Withdrawing the business's earnings from a provider to a bank or cash destination.

The form names the float account, the destination, and the amount, and presents two figures:

- The **solvency remainder**, being float beyond the project balances it backs
- The **liquidity remainder**, being what can be withdrawn while leaving every affected wallet above its reserve, including enough in a collection wallet to restore its paired disbursement wallet

The lesser governs, and the screen marks which of the two binds. An amount exceeding it is refused with both figures shown, so the reason is apparent rather than inferred.

Supporting documentation is attached at initiation. A one-time code is required. Above the configured threshold, the request moves to a second administrator's approval queue rather than committing, and the approver sees everything the initiator saw.

The list shows cashouts through to confirmation, with both administrators named.

### 8.5 Funding and adjustments

**Funding** places business capital at a provider, or grants a project a balance. The two are separate actions, and the screen notes that granting a project a balance without the float to back it moves the coverage ratio.

**Adjustments** correct the ledger. Each requires a justification, and above the configured threshold a second approver. An adjustment arising from a discrepancy carries the link to it.

Both require a one-time code, and both write ordinary ledger entries, visible wherever entries are shown.

---

## 9. Reconciliation

### 9.1 Runs

Runs execute weekly per provider account, and on demand from this screen by an administrator holding the permission to run reconciliation. The list shows each run with its provider account, whether it compared automatically or from an uploaded statement, the period covered, the counts compared and raised, and its status.

### 9.2 Statement upload

Where a provider exposes no transaction listing, an accountant exports the transactions from the provider's own console and uploads the file here.

The screen accepts the file, names the provider account and the period it covers, and reports what it read: the row count, any rows it could not parse, and the period the rows actually span. A file already processed is recognised and refused, and a declared period disagreeing with the rows is reported before the comparison runs.

The run proceeds on confirmation, and its discrepancies appear in the queue.

### 9.3 Discrepancy queue

The accountant's workspace.

**Filters:** run, type, status, assignee, provider account, and whether a discrepancy has recurred.

**Columns:** type, subject, expected, observed, difference, status, first detected, runs seen, assignee.

Recurrence is shown prominently. A resolved discrepancy that keeps returning suggests a systematic difference rather than an isolated one, and the count is what makes that visible.

**Actions:** assign; open.

### 9.4 Discrepancy detail

What the platform holds, what the provider reported, and the difference between them, with the transaction or float account concerned linked in full.

**Comments** from anyone who examined it, in order.

**Decision** — accepting states that the provider's record is correct; rejecting states that ours is. Either requires a comment.

Accepting presents a second question: whether an adjustment follows. An accountant may accept a difference as real and leave the records untouched, as with a variance too small to correct. Where an adjustment is posted, the screen shows the entry it will write before committing, and above the configured threshold it moves to a second approver.

A decision that changes a transaction's outcome states so explicitly, names the notification the project will receive, and shows the prior and corrected outcomes side by side.

---

## 10. Oversight

### 10.1 Alerts

**List** — open and cleared, with category, severity, subject, when raised, when last seen, occurrence count, and acknowledgement.

**Detail** — the condition, its history across occurrences, the groups notified, every delivery attempted with its outcome, and the acknowledgement where one was given.

Each alert carries a link to the operation that addresses it: funding a float account, opening a discrepancy, acknowledging the alert itself.

**Policies** — one per category, naming the groups notified, the severity at which notification begins, whether acknowledgement is required, and the escalation period and group. A policy change leaving a category unrouted is refused, and the screen reports any category whose groups have become empty.

**Groups** — name, members, and one delivery address per channel.

### 10.2 Health

Each measure against its rolling baseline, with the period selectable: success rate per route, provider account and project; failure reasons by frequency; transactions entering the undetermined state; transactions reaching action-required and never completing; time to terminal state; notification deliveries failing per project; previews expiring unconfirmed per route.

A measure departing from its baseline is marked, and links to the transactions behind it, since the question that follows a rate is always which payments produced it.

### 10.3 Reporting

Volume, value, fees, margin, and success rate, across project, direction, country, payment method, provider account, currency, and period, with any dimension as rows and any as columns.

Margin reporting shows processing fees against actual provider fees, and marks routes running negative. Platform revenue is reported alongside rather than within it, since a provider's rate change moves margin and leaves earnings untouched.

Margin is reported per project as well as per route, since projects on one route may be quoted differently and a route healthy in aggregate can carry a project below cost.

Reports read the terms recorded on each transaction, so historical figures reflect the rates that applied at the time rather than the rates in force now.

Every report exports, as CSV and as a spreadsheet file, per section 3.3.

### 10.4 Export verification

A screen accepting an exported file, or its identifier alone, and reporting whether it matches what the platform produced: who requested it, when, over which filters, and whether the rows are unchanged since. Producing an export and verifying one are separate permissions, so an auditor may check a file without being able to extract one.

A signature nobody can check is decoration, so the means of checking sits in the console beside the means of producing. The history of exports is listed here too, with the administrator, the filters, and the time, since knowing which figures left the platform and when is part of knowing where a disputed number came from.

### 10.5 Administrators

**List** — name, email address, status, roles held with the scope of each, and last sign-in.

**Detail** — role assignments, each with its scope; the administrator's chosen language; active sessions with their origin and age, revocable individually; and this administrator's recent actions.

Creating and altering administrators requires a one-time code. An administrator cannot alter their own roles or scope, and the controls to do so are inactive with the reason stated.

### 10.6 Roles

**List** — name, description, permissions held, and the administrators assigned.

**Editor** — permissions grouped by domain, with a description against each.

Two behaviours matter here. A change to a role carrying treasury or administration permissions requires a second approver. And the editor names, before committing, which administrators the change affects and what it grants or removes from each, since a role edit changes several people's access at once and the consequence is otherwise invisible.

### 10.7 Audit and authentication history

**Audit** — every configuration change and treasury action, with the actor, the time, the subject, and the prior and new state. Filters on actor, subject type, and date range.

**Authentication history** — sign-ins, failures, lockouts, and the addresses they came from, including attempts against addresses matching no administrator.

Both are read-only, and both are retained for the term named in the functional specification.

---

## 11. Patterns

### 11.1 Confirming a sensitive operation

Operations that move money, alter credentials, or change permissions require a one-time code sent to the administrator at the moment of the request.

The pattern: the administrator completes the form, the screen presents what will happen, the code is requested and entered, and the operation commits. The code is bound to the values submitted, so amending the form after requesting a code invalidates it.

A code admits a limited number of attempts and expires shortly after issue. On expiry or exhaustion, the operation is abandoned and started again.

### 11.2 Second approval

Where a threshold requires a second approver, committing places the request in the approval queue of section 4.3 rather than executing it.

The approver sees what the initiator saw, together with the initiator's name and any justification. Approving executes; declining records the decision with a reason and leaves everything unchanged.

The platform refuses an approval from the administrator who initiated the request, whatever permissions they hold, and the control states this rather than failing on submission.

### 11.3 Showing what will change

Any action altering a record presents a comparison before committing: current value, new value, and what else the change touches. This applies to route versions, role edits, country deactivation, and every treasury action.

### 11.4 Masked data

Payer identifiers appear masked. Revealing requires a permission and is recorded. Raw provider exchanges sit behind a separate permission again. Addresses issued for browser steps, one-time codes, project secrets, and provider credentials are absent from the console entirely once issued.

### 11.5 Errors

An action refused states which condition refused it and what would satisfy it. A cashout exceeding the withdrawable amount names both constraints and the figure available. A credential deletion refused because it is primary says so.

---

## 12. Build order

The console is built alongside the platform rather than after it. The stages below follow section 16 of the functional specification.

| Stage | Console delivered |
|---|---|
| Foundations | Sign-in with its second factor, administrators, reference data as read-only, audit |
| Collections | Transaction search and detail, previews, projects with credentials and origins, route and binding views, project balances |
| Reconciliation | Statement upload, run history, discrepancy queue and detail |
| Disbursements | Float accounts, transfer registration, reserved and suspended balances on transactions |
| Roles and alerting | Role editor, scope assignment, alert groups and policies, health |
| Treasury operations | Cashouts with approval, float cover dashboard, funding and adjustments |
| A second provider | Provider accounts, binding order, suspension, rate change sets |
| Breadth | Reporting across every dimension, margin analysis, refunds, export verification |

Two screens are worth building earlier than their stage suggests. The **approval queue** of section 4.3 arrives with the first operation requiring a second approver, ahead of the treasury stage where most of them live. The **environment band** of section 2 arrives on the first day, since the cost of confusing the two environments is highest while both are new.
