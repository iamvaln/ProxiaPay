# ProxiaPay — API Reference

**Version:** 1.0
**Date:** September 2026
**Status:** Reviewed and complete, with the sandbox address in section 8 outstanding.
**Companion to:** ProxiaPay Functional Specification, ProxiaPay Console — Interface Specification

---

## 1. Introduction

### 1.1 Purpose

ProxiaPay is an internal payment platform that collects money from mobile money wallets and sends money to them, across the countries and operators of Central and West Africa. The company's software products use it through the interface described here.

This document is the contract between the platform and the products consuming it. It gives every operation, the fields it accepts, the fields it returns, the errors it raises, and the sequences a product follows to take or send a payment.

The behaviour behind the interface is defined in the functional specification, which this document refers to by section rather than restating.

### 1.2 Audience

Two readers. A developer integrating a product, who needs the field names and the sequences. And whoever implements the platform, for whom this is the contract to satisfy.

### 1.3 How a payment works

Every payment takes two calls.

The product first requests a **preview**, describing what it intends to do: an amount, a route, and who the money comes from or goes to. The platform resolves what that will cost, returns the figures against a reference, and holds them for fifteen minutes.

The product then **confirms** that reference, and the platform creates the transaction and sends it to a provider.

Splitting the two means the amount a customer is shown is the amount they are charged, and it means a product never has to compute a fee itself. Two fees apply to every payment, a processing fee covering the cost of moving the money and a platform fee for the service, and the preview returns both already resolved.

What happens next depends on the route. On most, the customer completes the payment on their handset through their operator's own menu, and the platform reports the outcome by notification. On some, the customer supplies a one-time code, or opens a page in a browser. The preview says which applies before the product commits to anything.

### 1.4 Glossary

| Term | Meaning |
|---|---|
| **Collection** | Taking money from a customer's wallet. Also called a payin. |
| **Counterparty** | The person on the other side of a payment: the payer on a collection, the recipient on a disbursement. |
| **Direction** | Whether a payment collects or disburses. |
| **Disbursement** | Sending money to a recipient's wallet. Also called a payout. |
| **MSISDN** | A telephone number in full international form, identifying a mobile money wallet. |
| **Platform fee** | What ProxiaPay charges a project for the service itself. |
| **Processing fee** | What ProxiaPay quotes a project to cover a provider's cost. |
| **Minor units** | The smallest indivisible amount of a currency. Every amount in this interface is a whole number of them. |
| **Payment method** | A mobile money service, such as MTN Mobile Money or Orange Money. |
| **Preview** | A quotation, valid fifteen minutes, confirmed once to create a transaction. |
| **Project** | One product consuming the platform. |
| **Route** | One country, currency, payment method and direction together. |
| **Terminal state** | A state a transaction reaches when it is finished: succeeded, failed, or expired. |
| **Transaction** | One payment. |

---

## 2. Conventions

### 2.1 Addresses and versioning

| Environment | Address |
|---|---|
| Production | `https://pay.proxia-digital.com/v1` |
| Sandbox | `https://sandbox.pay.proxia-digital.com/v1` |

The two are separate deployments holding separate data, separate credentials, and separate balances. A sandbox credential reaches nothing in production.

The version sits in the path. Fields may be added to a response and optional fields to a request within a version, so a client tolerates fields it does not recognise. Removing a field, renaming one, changing a type, or adding a required field opens a new version, and the version it replaces stays available for a stated period.

### 2.2 Requests and responses

Requests and responses carry JSON, with `Content-Type: application/json`.

Field names are lowercase with underscores. Enumerated values are lowercase strings.

Every response carries `X-Request-Id`. Quoting it identifies the exact call in the platform's records, which is the fastest route through any support conversation.

### 2.3 Amounts

Every amount is an integer in the currency's minor units, and every object carrying amounts carries the `currency` they are denominated in.

XAF, XOF and GNF have no minor unit, so 1000 XAF is `1000`. CDF and USD have two, so 10.50 USD is `1050`. The settings endpoint gives the exponent for each currency a project can use.

Sending a decimal is refused rather than rounded.

### 2.4 Timestamps

Timestamps are strings in RFC 3339 form, in Coordinated Universal Time: `2026-09-14T10:15:30Z`.

### 2.5 References

Three kinds of reference appear.

| Reference | Form | Set by |
|---|---|---|
| Preview | `prv_` and an opaque string | The platform |
| Transaction | `txn_` and an opaque string | The platform |
| Project reference | Any string up to 128 characters | The project |

A project's own reference is unique within that project, and identifies the payment in the project's own records. It is supplied at preview and travels with the transaction thereafter.

### 2.6 Pagination

Listing endpoints return a page and a cursor:

```json
{
  "data": [ ... ],
  "next_cursor": "eyJ2IjoxfQ",
  "has_more": true
}
```

A request passes `cursor` to continue and `limit` to size the page, between 1 and 100, defaulting to 25. A response with `has_more` false ends the sequence.

### 2.7 Rate limits

Limits apply per credential. Every response carries the state of the limit:

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit` | Requests permitted in the window |
| `X-RateLimit-Remaining` | Requests left |
| `X-RateLimit-Reset` | When the window resets |

Exceeding a limit returns `429` with the code `RATE_LIMITED` and a `Retry-After` header.

---

## 3. Authentication

### 3.1 Obtaining a token

A project exchanges its key and secret for a token, and carries the token on every other call.

```
POST /v1/auth/tokens
```

```json
{
  "client_key": "pk_live_8f2a...",
  "client_secret": "sk_live_9c4e..."
}
```

**Response** `200`

```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

The secret leaves the project once an hour in place of on every call, which limits what a mishandled log or intermediary can capture.

### 3.2 Using a token

```
Authorization: Bearer eyJhbGciOi...
```

A token that has expired returns `401` with `TOKEN_EXPIRED`. The client exchanges again and retries.

### 3.3 Behaviour worth knowing

**Hold the token.** Exchanging on every call exhausts the exchange limit and raises a security alert against the project. Exchange when the current token is within a few minutes of expiry, or when a call returns `TOKEN_EXPIRED`.

**Tokens are concurrent.** Several instances of a project each hold their own token, all valid, and one issuing never invalidates another. Instances have no reason to coordinate.

**Revocation is immediate.** A credential revoked in the console invalidates every token issued under it at once.

**Origin is checked first.** A call from an address the project has not declared is refused with `ORIGIN_NOT_ALLOWED` before its credentials are considered.

---

## 4. Errors

### 4.1 Shape

```json
{
  "error": {
    "code": "AMOUNT_BELOW_MINIMUM",
    "message": "Amount is below the minimum for this route.",
    "field": "amount",
    "retryable": false,
    "details": { "minimum": 500, "currency": "XAF" }
  }
}
```

`code` is stable and is what a client branches on. `message` is English and intended for a log rather than for a customer. `field` names the offending input where one applies. `retryable` states whether repeating the identical request could succeed later. `details` carries whatever the code makes useful.

### 4.2 Status codes

| Status | Meaning |
|---|---|
| `200` | The request succeeded |
| `201` | A preview or transaction was created |
| `400` | The request was malformed or failed validation |
| `401` | Credentials or token rejected |
| `403` | Authenticated, and refused by permission, entitlement, or origin |
| `404` | The reference does not exist |
| `409` | A conflict with existing state |
| `422` | Well formed, and refused by a rule: limits, balance, liquidity |
| `429` | Rate limited |
| `500` | A fault in the platform |
| `503` | No provider available |

### 4.3 Request errors

Returned in response to a call. No transaction exists, or the existing one is untouched.

| Code | Status | Notes |
|---|---|---|
| `CREDENTIALS_INVALID` | 401 | |
| `CREDENTIALS_REVOKED` | 401 | |
| `TOKEN_INVALID` | 401 | |
| `TOKEN_EXPIRED` | 401 | Exchange again and retry |
| `SCOPE_INSUFFICIENT` | 403 | The credential lacks this direction |
| `ORIGIN_NOT_ALLOWED` | 403 | |
| `RATE_LIMITED` | 429 | Retryable |
| `FIELD_INVALID` | 400 | Names the field |
| `AMOUNT_INVALID` | 400 | Absent, negative, zero, or carrying decimals |
| `CURRENCY_UNKNOWN` | 400 | |
| `COUNTRY_UNKNOWN` | 400 | |
| `PAYMENT_METHOD_UNKNOWN` | 400 | |
| `PAYER_IDENTIFIER_INVALID` | 400 | Malformed, or carrying another country's prefix |
| `PAYER_IDENTIFIER_MISMATCH` | 400 | The number belongs to another operator |
| `COUNTRY_DISABLED` | 403 | |
| `ROUTE_UNAVAILABLE` | 404 | No route for that combination |
| `ROUTE_DISABLED` | 403 | |
| `ENTITLEMENT_MISSING` | 403 | |
| `ENTITLEMENT_DISABLED` | 403 | |
| `AMOUNT_BELOW_MINIMUM` | 422 | `details.minimum` |
| `AMOUNT_ABOVE_MAXIMUM` | 422 | `details.maximum` |
| `VELOCITY_COUNT_EXCEEDED` | 422 | `details.resets_at` |
| `VELOCITY_VALUE_EXCEEDED` | 422 | `details.resets_at` |
| `PREVIEW_NOT_FOUND` | 404 | |
| `PREVIEW_EXPIRED` | 409 | Raise a new preview |
| `PREVIEW_ALREADY_CONFIRMED` | 409 | `details.transaction` carries the original |
| `PREVIEW_DIRECTION_MISMATCH` | 409 | Confirmed on the wrong endpoint |
| `REFERENCE_CONFLICT` | 409 | The project reference is in use for another payment |
| `SIMILAR_PAYMENT_PENDING` | 409 | `details.transaction` carries the open one |
| `BALANCE_INSUFFICIENT` | 422 | `details.shortfall` |
| `FLOAT_INSUFFICIENT` | 503 | Retryable, carries no amounts |
| `CODE_INVALID` | 422 | `details.attempts_remaining` |
| `CODE_ATTEMPTS_EXHAUSTED` | 409 | |
| `NO_PROVIDER_AVAILABLE` | 503 | Retryable |
| `INTERNAL_ERROR` | 500 | Retryable |

### 4.4 Failure reasons

These describe a transaction that was created and ended. They arrive in the `failure_reason` field of a transaction, and in notifications. They are never the body of an error response.

| Code | Meaning |
|---|---|
| `PAYER_DECLINED` | The payer refused on their handset |
| `PAYER_UNRESPONSIVE` | The payer did not act before the operator's timeout |
| `WALLET_NOT_FOUND` | No wallet for that number on that operator |
| `WALLET_INACTIVE` | The wallet cannot transact |
| `WALLET_LIMIT_EXCEEDED` | The operator's own ceiling was reached |
| `WALLET_BALANCE_INSUFFICIENT` | The payer's wallet lacked the funds |
| `CODE_ATTEMPTS_EXHAUSTED` | The attempt limit was reached |
| `ACTION_WINDOW_EXPIRED` | The payer action window closed |
| `PROVIDER_REJECTED` | The provider refused the payment |
| `OUTCOME_UNDETERMINED` | No conclusive answer; held for reconciliation |

`OUTCOME_UNDETERMINED` is the one a project must never answer by sending the payment again. The money may have moved. The transaction stays open and its resolution arrives later, by notification.

---

## 5. Operations

### 5.1 Create a preview

```
POST /v1/previews
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `direction` | string | yes | `collection` or `disbursement` |
| `amount` | integer | yes | Minor units |
| `currency` | string | yes | ISO code |
| `country` | string | yes | Two-letter code |
| `payment_method` | string | yes | From settings |
| `counterparty.msisdn` | string | yes | With or without the country's prefix |
| `counterparty.name` | string | no | |
| `counterparty.email` | string | no | |
| `reference` | string | yes | The project's own, unique within the project |
| `metadata` | object | no | Returned unchanged; up to 20 keys |

```json
{
  "direction": "collection",
  "amount": 1000,
  "currency": "XAF",
  "country": "CM",
  "payment_method": "MOMO",
  "counterparty": { "msisdn": "677123456", "name": "A. Mbarga" },
  "reference": "order-4417"
}
```

**Response** `201`

```json
{
  "reference": "prv_01J8XQ2M4K",
  "direction": "collection",
  "currency": "XAF",
  "requested_amount": 1000,
  "charged_amount": 1030,
  "settled_amount": 1000,
  "fees": {
    "processing": { "amount": 25, "bearer": "counterparty" },
    "platform": { "amount": 5, "bearer": "counterparty" },
    "total": 30
  },
  "route": { "country": "CM", "payment_method": "MOMO", "direction": "collection" },
  "counterparty": { "msisdn": "+237677123456" },
  "payer_action": "none",
  "project_reference": "order-4417",
  "expires_at": "2026-09-14T10:30:30Z"
}
```

Two fees apply. The **processing fee** covers the cost of moving the money, and the **platform fee** is what ProxiaPay charges for the service. Each carries its own bearer, being `counterparty` or `project`, so a project may have the counterparty bear both, absorb both, or absorb one and pass on the other. The bearers come from configuration rather than from the request.

The platform fee is zero on a route until it is configured otherwise, and a zero fee is returned as `0` in place of being omitted, so a client reads the same shape whatever a route charges.

Each fee is borne either by the counterparty or by the project, and the effect differs by direction.

On a **collection**, a fee the payer bears is added to what they are charged, and a fee the project bears is taken from what the project is credited. `charged_amount` is what the payer is debited; `settled_amount` is what the project receives.

On a **disbursement**, a fee the recipient bears is taken from what they receive, and a fee the project bears is added to what the project is debited. `settled_amount` is what the recipient receives; `charged_amount` is what the project's balance carries.

A withdrawal where the customer pays the fee is the second of these: a disbursement of 1000 with both fees on the recipient debits the project 1000 and delivers 970, so a product presenting a withdrawal screen shows the customer both figures.

`counterparty.msisdn` comes back normalised to international form. A number supplied without its country's prefix is prefixed; one carrying another country's prefix is refused.

`payer_action` is `none`, `code`, or `browser`, and tells the product which sequence of section 6 to follow before it commits to anything.

The fees shown are what ProxiaPay charges. What a provider charges the platform is a commercial matter between the platform and that provider, and is absent from this interface.

A preview holds no funds and reserves no balance. A disbursement preview returns its figures even where the project's balance falls short, so a product can present a cost before it presents a problem.

### 5.2 Confirm a collection

```
POST /v1/collections
```

```json
{ "preview_reference": "prv_01J8XQ2M4K" }
```

**Response** `201` — a transaction object, section 5.7.

Repeating a confirmation returns the transaction the first one created, with status `200`.

### 5.3 Confirm a disbursement

```
POST /v1/disbursements
```

```json
{ "preview_reference": "prv_01J8XQ7P9C" }
```

**Response** `201` — a transaction object.

Confirming reserves the amount and its fee against the project's balance before any provider is contacted. `BALANCE_INSUFFICIENT` means the project lacks the funds and carries the shortfall. `FLOAT_INSUFFICIENT` means the platform's own liquidity on that route is short, is nothing the project can act on, and is worth retrying later.

### 5.4 Submit a one-time code

```
POST /v1/transactions/{reference}/code
```

```json
{ "code": "482913" }
```

**Response** `200` — a transaction object.

Available where `payer_action` was `code`. A wrong code returns `CODE_INVALID` with the attempts remaining. Exhausting them ends the transaction.

### 5.5 Retrieve a transaction

```
GET /v1/transactions/{reference}
```

**Response** `200` — a transaction object.

The reference is the platform's. To find a transaction by the project's own reference, list with `project_reference`.

### 5.6 List transactions

```
GET /v1/transactions
```

| Parameter | Notes |
|---|---|
| `project_reference` | Exact match |
| `provider_reference` | Exact match |
| `operator_reference` | Exact match |
| `state` | Repeatable |
| `direction` | |
| `country`, `payment_method`, `currency` | |
| `created_after`, `created_before` | Timestamps |
| `cursor`, `limit` | Section 2.6 |

**Response** `200` — a page of transaction objects.

### 5.7 The transaction object

```json
{
  "reference": "txn_01J8XQ3R7T",
  "project_reference": "order-4417",
  "provider_reference": "EJP-77301942",
  "operator_reference": "MP260914.1018.A41927",
  "direction": "collection",
  "state": "action_required",
  "reconciliation_status": "unreviewed",
  "currency": "XAF",
  "requested_amount": 1000,
  "charged_amount": 1030,
  "settled_amount": null,
  "fees": {
    "processing": { "amount": 25, "bearer": "counterparty" },
    "platform": { "amount": 5, "bearer": "counterparty" },
    "total": 30
  },
  "route": { "country": "CM", "payment_method": "MOMO", "direction": "collection" },
  "counterparty": { "msisdn": "+237677123456", "name": "A. Mbarga" },
  "action": {
    "type": "browser",
    "url": "https://…",
    "expires_at": "2026-09-14T10:25:30Z"
  },
  "failure_reason": null,
  "metadata": {},
  "created_at": "2026-09-14T10:15:30Z",
  "terminal_at": null
}
```

**`state`**

| Value | Meaning |
|---|---|
| `created` | Accepted, not yet with a provider |
| `action_required` | Awaiting the counterparty |
| `submitted` | Sent to a provider |
| `processing` | Acknowledged, outcome pending |
| `succeeded` | Complete, money moved |
| `failed` | Complete, money did not move |
| `expired` | The counterparty did not act in time |
| `undetermined` | No conclusive outcome; held for reconciliation |

**`reconciliation_status`** is `unreviewed`, `matched`, `disputed`, `examined`, or `corrected`. It describes what comparison against the provider's own records has established, and it changes after a transaction is otherwise finished.

**`action`** is present while `state` is `action_required`. For `type` `code` it carries `attempts_remaining` and `expires_at`; for `browser` it carries `url` and `expires_at`.

The `url` authorises the payment for whoever holds it. It goes to the customer and nowhere else, and belongs in no log.

**`provider_reference`** is what the provider calls this payment, and is null until the payment reaches one. Where a transaction fell back to a second provider, this is the reference from the attempt that is current. Quote it when raising a payment with a provider's own support.

**`operator_reference`** is what the mobile network operator calls it, and is the identifier a customer sees in their confirmation message. It is the reference a customer quotes when they contact a product's own support, and searching on it is the fastest way to find their payment. It is null until the payment succeeds, and stays null where a provider does not carry it.

**`settled_amount`** is null until the transaction succeeds.

### 5.8 Retrieve settings

```
GET /v1/settings
```

**Response** `200`

```json
{
  "fingerprint": "cfg_7d41e9",
  "currencies": [ { "code": "XAF", "exponent": 0 } ],
  "routes": [
    {
      "country": "CM",
      "country_name": "Cameroon",
      "dialling_prefix": "+237",
      "currency": "XAF",
      "payment_method": "MOMO",
      "payment_method_name": "MTN Mobile Money",
      "direction": "collection",
      "fees": {
        "processing": { "percentage": "2.5", "fixed": 0, "bearer": "counterparty" },
        "platform": { "percentage": "0.5", "fixed": 0, "bearer": "counterparty" }
      },
      "minimum_amount": 100,
      "maximum_amount": 1000000,
      "payer_action": "none",
      "velocity": {
        "count_24h": 5000, "value_24h": 20000000,
        "count_30d": 100000, "value_30d": 400000000
      }
    }
  ]
}
```

This is what the project may currently do, and it is the source a product builds its payment screens from. Holding the same values in a product's own configuration means they are wrong the first time a route changes.

The rates returned are this project's. A route's terms are its default, and a project may be quoted its own rate on either fee, so two products reading this endpoint for the same route can legitimately receive different figures.

The response carries `ETag`. A request with `If-None-Match` returns `304` where nothing has changed, so polling is inexpensive. The `fingerprint` is the same value in the body, for clients that would rather compare it themselves.

### 5.9 Retrieve balances

```
GET /v1/balances
```

**Response** `200`

```json
{
  "balances": [
    { "currency": "XAF", "available": 4520000, "reserved": 125000 }
  ]
}
```

`available` is what the project can spend. `reserved` is held against disbursements in flight.

A balance read is advisory. Reading it and then confirming a disbursement races the project's own other transactions, and the authoritative check is the reservation taken at confirmation. Gating logic built on this figure acts on something that may already be stale.

---

## 6. Notifications

### 6.1 Delivery

The platform sends an HTTP `POST` to the address registered for the project, carrying JSON.

```json
{
  "id": "evt_01J8XQ9F2D",
  "event": "transaction.succeeded",
  "occurred_at": "2026-09-14T10:18:02Z",
  "data": { "transaction": { } }
}
```

`data.transaction` is the transaction object of section 5.7 as it stands at that moment.

A response of `2xx` is taken as received. Anything else, or no response, retries on a widening interval up to a ceiling. Every attempt is recorded, and an administrator can replay one.

### 6.2 Events

| Event | Raised when |
|---|---|
| `transaction.action_required` | The counterparty must act |
| `transaction.succeeded` | The payment completed |
| `transaction.failed` | The payment ended without moving money |
| `transaction.expired` | The action window closed |
| `transaction.undetermined` | No conclusive outcome; held for reconciliation |
| `transaction.corrected` | Reconciliation changed a finished transaction's outcome |

`transaction.corrected` deserves particular attention. It means a payment previously reported one way turned out to be another, most consequentially a collection reported as failed that the customer in fact completed. It carries the prior outcome alongside the corrected one:

```json
{
  "event": "transaction.corrected",
  "data": {
    "transaction": { },
    "previous_state": "failed",
    "previous_failure_reason": "PAYER_UNRESPONSIVE"
  }
}
```

A product that ignores this event leaves an order unfulfilled against a customer who paid.

### 6.3 Verifying a notification

Each request carries three headers:

| Header | Contents |
|---|---|
| `X-ProxiaPay-Event-Id` | The event identifier, also in the body |
| `X-ProxiaPay-Timestamp` | Seconds since the epoch, when the platform signed it |
| `X-ProxiaPay-Signature` | Hexadecimal HMAC-SHA256 |

The signature is computed over the timestamp, a full stop, and the exact raw body, keyed on the project's signing secret. Verification takes the raw bytes of the body rather than a re-serialised copy, since re-serialising changes whitespace and key order and the signature will not match.

Two further checks. Reject a timestamp more than five minutes from the present, which bounds replay. And treat delivery as at-least-once: an event identifier already processed is acknowledged and ignored, since a retry after a slow response delivers the same event twice.

### 6.4 What a notification is for

A notification says a transaction's state may have changed. A product that treats it as the state itself trusts an unverified assertion about money.

Where the outcome governs something consequential, retrieve the transaction and act on what the retrieval returns. The platform does the same thing with its own providers, for the same reason.

---

## 7. Sequences

### 7.1 A standard collection

1. `POST /v1/previews` with the amount, route, and payer. The response gives the figures and `payer_action: "none"`.
2. Present the charged amount to the customer.
3. `POST /v1/collections` with the preview reference. The transaction returns in `processing`.
4. The customer approves on their handset, outside the platform.
5. A `transaction.succeeded` or `transaction.failed` notification arrives.
6. Retrieve the transaction and fulfil.

### 7.2 A collection needing a one-time code

Steps 1 to 3 as above, and the preview returns `payer_action: "code"`. The transaction returns in `action_required`.

4. The operator sends the customer a code. Collect it.
5. `POST /v1/transactions/{reference}/code`. A valid code moves the transaction on; a wrong one returns `CODE_INVALID` with the attempts left.
6. The outcome arrives by notification as above.

### 7.3 A collection needing a browser step

Steps 1 to 3 as above, and the preview returns `payer_action: "browser"`. The transaction returns in `action_required` carrying `action.url`.

4. Send the customer to that address. Returning them to the product afterwards is the product's own business.
5. The outcome arrives by notification.

### 7.4 A disbursement

1. `POST /v1/previews` with `direction: "disbursement"`. The response gives what the recipient will receive and what the project's balance will carry, which differ where the recipient bears a fee.
2. `POST /v1/disbursements` with the preview reference. The amount and whichever fees the project bears are reserved against the balance.
3. A notification reports the outcome.

Where the recipient bears the fees, which is the usual arrangement for a customer withdrawal, present both figures before confirming: the amount leaving their account and the amount arriving in their wallet. The preview carries both, so the product computes neither.

`undetermined` is the case to handle deliberately. The payment may or may not have reached the recipient, the funds stay reserved, and reconciliation settles it within days. Sending it again would risk paying twice.

### 7.5 Retrying safely

| Situation | What to do |
|---|---|
| A preview call timed out | Repeat it with the same `reference`; a duplicate returns `REFERENCE_CONFLICT` or the original |
| A confirm call timed out | Repeat it with the same preview reference; it returns the transaction the first call created |
| `FLOAT_INSUFFICIENT` or `NO_PROVIDER_AVAILABLE` | Retry later, unchanged |
| `TOKEN_EXPIRED` | Exchange and retry |
| `RATE_LIMITED` | Wait for `Retry-After` |
| A transaction is `undetermined` | Wait. Never send it again |

---

## 8. Items to confirm

**Sandbox address.** Production is `pay.proxia-digital.com`. The sandbox host in section 2.1 follows from it by convention and wants confirming against however the environment is actually provisioned.

**Percentage representation.** The settings endpoint returns each fee percentage as a decimal string, `"2.5"`, avoiding the rounding a floating point number would introduce. Confirm this suits the clients that will read it.

**Notification address verification.** A registered address is confirmed before events are sent to it, and how that confirmation happens is undecided.
