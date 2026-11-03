# Integrating ProxiaPay into your shop — step by step

For developers adding mobile money payments to a shop or product. Follow the steps
in order; each ends with something you can check. The full field-level contract —
the integration guide and the API reference, generated from what the platform
actually validates — is online at **https://sandbox.pay.proxia-digital.com/v1/docs**
(the OpenAPI document is at `/v1/docs/openapi.json`).

| Environment | Base URL |
|---|---|
| Sandbox | `https://sandbox.pay.proxia-digital.com/v1` |
| Production | `https://pay.proxia-digital.com/v1` — credentials issued after go-live |

The sandbox moves no real money: a simulator stands in for every mobile money
provider, and the number you pay chooses what happens (step 11).

---

## Step 1 — Get onboarded

ProxiaPay's team creates your project and gives you, in writing:

- a **client key** (`pk_test_…`) and **client secret** (`sk_test_…`) — the secret is
  shown once;
- the **routes** you may use (country × payment method × collection/payout);
- the **notification signing secret** (`whsec_…`) for the webhook address you give them.

You give them:

- the **HTTPS address** that will receive payment notifications;
- for production, every **IP address or range** your servers call from.

✅ *Check:* you hold a key, a secret and a signing secret, all stored in a secret
manager — never in source or a config file.

## Step 2 — Get a token

```http
POST /v1/auth/tokens
{ "client_key": "pk_test_…", "client_secret": "sk_test_…" }
```
```json
{ "access_token": "pt_…", "token_type": "Bearer", "expires_in": 3600 }
```

Send `Authorization: Bearer pt_…` on every other call. **Keep the token** and
exchange again only when it is a few minutes from expiry or a call returns
`TOKEN_EXPIRED`. Exchanging on every call hits the limit (10 per minute) and raises
a security alert on your project.

✅ *Check:* your service exchanges once at start-up and then about once an hour.

## Step 3 — Read your settings; don't hard-code anything

```http
GET /v1/settings
```

It lists every route you hold with its currency (and decimal exponent), fees and
who bears them, minimum and maximum, velocity caps, and `payer_action`. Build your
payment screens from it. Send `If-None-Match` with the last `ETag`: a `304` is free.

**Amounts are integers in minor units.** XAF has none: 1000 XAF is `1000`. USD has
two: 10.50 USD is `1050`. A decimal is refused, not rounded.

✅ *Check:* changing a fee in ProxiaPay changes what your screen shows, with no deploy.

## Step 4 — Show a preview before every payment

```http
POST /v1/previews
{
  "direction": "collection",
  "amount": 1000,
  "currency": "XAF", "country": "CM", "payment_method": "MOMO",
  "counterparty": { "msisdn": "677123456", "name": "A. Mbarga" },
  "reference": "order-4417"
}
```

`direction` is `collection` (customer pays you) or `disbursement` (you pay
someone). The response is the quote:

| Field | Collection | Payout |
|---|---|---|
| `charged_amount` | what the customer is debited | what your balance is debited |
| `settled_amount` | what you receive | what the recipient receives |
| `fees` | each fee with who bears it | same |
| `payer_action` | `none`, `code` or `browser` | |
| `expires_at` | 15 minutes from now | |

**Show the preview's figures; never compute a fee yourself.** `reference` is
your own identifier, unique in your project — use your order or payout ID.

If the amount is outside what the route or the provider accepts, the preview is
refused with `AMOUNT_BELOW_MINIMUM` / `AMOUNT_ABOVE_MAXIMUM` and
`details.minimum` / `details.maximum` **in your terms** — for example, a Cameroon
payout must deliver at least 500, so a request below 513 returns
`{ "minimum": 513 }`. Show that to the user.

✅ *Check:* the amount on your confirmation screen is exactly `charged_amount`.

## Step 5 — Confirm

```http
POST /v1/collections        (or)        POST /v1/disbursements
{ "preview_reference": "prv_…" }
```

`201` — the transaction was created now. `200` — an earlier confirmation already
created it; this is the same transaction. **So if a confirmation times out, send
exactly the same call again**: you will never create a second payment.

The transaction comes back `processing` (or `action_required`, step 6). Save its
`reference` (`txn_…`) next to your order.

✅ *Check:* a confirmation retried after a timeout returns `200` and the same `txn_…`.

## Step 6 — Handle the customer's action

`payer_action` from the preview tells you what happens next:

- **`none`** — the customer approves on their phone (a USSD prompt). Show
  "Approve the payment on your phone" and wait for the outcome (step 7).
- **`code`** — the transaction is `action_required`. Ask the customer for the code
  the operator sent and submit it:
  ```http
  POST /v1/transactions/txn_…/code
  { "code": "123456" }
  ```
  A wrong code returns `CODE_INVALID` with the attempts left.
- **`browser`** — redirect the customer to `action.url`. That address authorises
  the payment for whoever holds it: send it to the customer only, never log it.

## Step 7 — Receive the outcome by webhook

Events arrive as `POST` to your address:

```json
{ "id": "evt_…", "event": "transaction.succeeded", "occurred_at": "…",
  "data": { "transaction": { "reference": "txn_…", "state": "succeeded", … } } }
```

Events: `transaction.succeeded`, `transaction.failed`, `transaction.expired`,
`transaction.action_required`, `transaction.undetermined`, `transaction.corrected`.

**Verify every one before trusting it:**

```js
const crypto = require('node:crypto');
function verify(secret, headers, rawBody) {
  const ts = Number(headers['x-proxiapay-timestamp']);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex');
  const given = String(headers['x-proxiapay-signature'] ?? '');
  return expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}
```

1. Compute the signature over the **raw body bytes** — re-serialised JSON won't match.
2. Reject a timestamp more than 5 minutes off.
3. Delivery is **at least once**: an event `id` you have already processed gets a
   `2xx` and is ignored.
4. Answer `2xx` within a few seconds; otherwise it is retried (1 minute up to a
   day, 8 attempts).

Before you fulfil an order or release goods, **fetch the transaction** and act on
what that returns:

```http
GET /v1/transactions/txn_…
```

✅ *Check:* a tampered body, a stale timestamp and a replayed `id` are all rejected
or ignored.

## Step 8 — Treat every final state correctly

| State | Meaning | What you do |
|---|---|---|
| `succeeded` | Money moved | Fulfil / mark paid. Use the transaction's figures: on a collection, `charged_amount` is what the customer was actually debited |
| `failed` | Nothing moved | Show `failure_reason`; the customer may start a new payment |
| `expired` | The customer never acted | Same as failed |
| `undetermined` | The provider has not answered conclusively | **Wait. Never send it again** — the money may have moved. The outcome arrives by webhook |
| `corrected` event | An earlier outcome changed (e.g. a "failed" collection the customer actually paid) | Act on `data.transaction` and `previous_state` — usually fulfil the order |

A collection can take from seconds to several minutes; a declined one can take
several minutes to be reported. Don't time out a customer's order on your side
after one minute.

## Step 9 — Handle errors by what they mean

| You get | Do this |
|---|---|
| A timeout on preview | Repeat with the same `reference` |
| A timeout on confirm | Repeat with the same `preview_reference` |
| `TOKEN_EXPIRED` | Exchange a new token, retry |
| `RATE_LIMITED` | Wait for `Retry-After` |
| `AMOUNT_BELOW_MINIMUM` / `ABOVE_MAXIMUM` | Show `details.minimum` / `maximum` |
| `BALANCE_INSUFFICIENT` (payouts) | Your balance is short by `details.shortfall`: fund it |
| `FLOAT_INSUFFICIENT`, `NO_PROVIDER_AVAILABLE` | ProxiaPay's side — retry later, unchanged |
| `SIMILAR_PAYMENT_PENDING` | A matching payment is open (`details.transaction`) — don't start another |
| `VELOCITY_*_EXCEEDED` | Wait until `details.resets_at` |
| `REFERENCE_CONFLICT` | Your `reference` was used for a different payment — use a new one |

Every error carries `retryable`. Log `X-Request-Id` from every response: it
identifies the exact call when you contact ProxiaPay.

## Step 10 — Support and reconciliation

- A customer quotes the reference from their operator's SMS: find it with
  `GET /v1/transactions?operator_reference=…`.
- Find by your own reference: `GET /v1/transactions?project_reference=order-4417`.
- Check your balance (what payouts draw on): `GET /v1/balances`.

## Step 11 — Test on the sandbox

Run every case you will meet in production. No real money moves and no real phone
is contacted: the **last two digits** of the counterparty number choose what happens.

| Ends in | Outcome |
|---|---|
| `00` | Rejected at submission |
| `01` | Accepted, then declined by the payer |
| `02` | Stays processing, then `undetermined` |
| `03` | Provider unreachable |
| `04` | Times out — `undetermined` at once |
| `05` | Accepted, then insufficient wallet balance |
| `06` | Needs a one-time code: `123456` |
| `07` | Needs a browser step; completes after ~20 s |
| anything else | Succeeds after a few seconds |

A Postman collection with every call, chained so references carry over, is
available from the ProxiaPay team.

## Step 12 — Go live

Complete ProxiaPay's going-live checklist, then request production credentials.
It asks you to confirm, among others:

- [ ] Token exchanged at start-up and on `TOKEN_EXPIRED` only
- [ ] Screens built from `/v1/settings`; preview figures shown before confirming
- [ ] Confirmation retried with the same preview reference after a timeout
- [ ] At least one sandbox payment completed on each route and direction you'll use
- [ ] Webhook signatures verified; stale and replayed events rejected
- [ ] `transaction.corrected` handled; `undetermined` never re-sent
- [ ] Support can search by the operator's reference
- [ ] Every IP address you call from declared — production refuses others with `ORIGIN_NOT_ALLOWED`
- [ ] Signing secret held in a secret store; `X-Request-Id` in your logs

In production you receive `pk_live_…` / `sk_live_…`, a production signing secret,
and the routes granted to you. Everything else comes from `/v1/settings`.
