# ProxiaPay integration guide

This guide covers the sequence a product follows to take or send a payment. The field-level contract is the API reference (`docs/spec/api-reference.md`) and the generated OpenAPI document; this guide covers how to use it well.

## 1. Credentials and tokens

You receive a key (`pk_live_…` or `pk_test_…`) and a secret (`sk_…`). The secret is shown once, when it is issued. Exchange the pair for a token and carry the token on every other call:

```
POST /v1/auth/tokens
{ "client_key": "pk_test_…", "client_secret": "sk_test_…" }
→ { "access_token": "pt_…", "token_type": "Bearer", "expires_in": 3600 }
```

Hold the token. Exchange again when it is within a few minutes of expiry or when a call returns `TOKEN_EXPIRED`. Exchanging on every call exhausts the exchange limit (ten per minute per credential) and raises a security alert against your project. Each instance of your product holds its own token; tokens never invalidate one another.

Origin is checked before credentials. In production, calls must come from an address your project has declared; a call from elsewhere is refused with `ORIGIN_NOT_ALLOWED` before the secret is even looked at. Declare new infrastructure before it starts calling.

## 2. Read settings, do not hold configuration

```
GET /v1/settings
```

returns the countries, currencies (with their decimal exponent), payment methods, directions, fee rates and bearers, limits, velocity caps and payer action for every route your project holds. Build payment screens from this. The response carries `ETag`; send `If-None-Match` and a `304` costs nothing.

Amounts everywhere are integers in the currency's minor units. XAF, XOF and GNF have none (1000 XAF is `1000`); CDF and USD have two (10.50 USD is `1050`). A decimal is refused, not rounded.

## 3. Preview, then confirm

Every payment takes two calls.

```
POST /v1/previews
{ "direction": "collection", "amount": 1000, "currency": "XAF", "country": "CM", "payment_method": "MOMO",
  "counterparty": { "msisdn": "677123456", "name": "A. Mbarga" }, "reference": "order-4417" }
```

The response carries `charged_amount` (what the payer is debited on a collection; what your balance carries on a disbursement) and `settled_amount` (what you receive on a collection; what the recipient receives on a disbursement), the two fees with their bearers, the normalised number, `payer_action`, and `expires_at` fifteen minutes out. Show the figures; never compute a fee yourself.

```
POST /v1/collections        or        POST /v1/disbursements
{ "preview_reference": "prv_…" }
```

creates the transaction. `201` means it was created now; `200` means an earlier confirmation created it and this is the same transaction. Confirming twice is therefore safe, and is how you retry a call that timed out.

`reference` is your own, unique within your project. Repeating a preview with the same reference and the same intent returns the original preview; a different intent under a used reference returns `REFERENCE_CONFLICT`.

## 4. Payer actions

`payer_action` in the preview tells you which of three sequences applies.

- `none`: the payer approves on their handset outside the platform. The transaction returns in `processing`.
- `code`: the transaction returns in `action_required` with `action.attempts_remaining`. Collect the code the operator sent and submit it to `POST /v1/transactions/{reference}/code`. A wrong code returns `CODE_INVALID` with the attempts left; exhausting them ends the transaction.
- `browser`: the transaction returns in `action_required` with `action.url`. Send the payer there. The address authorises the payment for whoever holds it: it goes to the payer and nowhere else, and belongs in no log.

## 5. Notifications

Register an address in the console (an administrator sets it; a credential cannot). Events arrive as `POST` with a JSON body:

```
{ "id": "evt_…", "event": "transaction.succeeded", "occurred_at": "…", "data": { "transaction": { … } } }
```

Verify every one:

1. Compute HMAC-SHA256 over `"{X-ProxiaPay-Timestamp}.{raw body bytes}"` keyed on your signing secret and compare it in constant time to `X-ProxiaPay-Signature`. Use the raw bytes; re-serialising changes whitespace and key order.
2. Reject a timestamp more than five minutes from now.
3. Treat delivery as at-least-once: an `id` you have processed is acknowledged with `2xx` and ignored.

Respond `2xx` promptly. Anything else retries on a widening interval (one minute up to a day, eight attempts).

A notification says a transaction's state may have changed. Where the outcome governs something consequential, retrieve the transaction and act on what the retrieval returns.

Handle `transaction.corrected`. It means a payment previously reported one way turned out to be another, most consequentially a collection reported as failed that the customer completed. It carries `previous_state` and `previous_failure_reason` alongside the corrected transaction. A product ignoring it leaves an order unfulfilled against a customer who paid.

Node.js verification:

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

## 6. Errors: what to retry

| Situation | What to do |
|---|---|
| A preview call timed out | Repeat it with the same `reference`; you get the original or `REFERENCE_CONFLICT` |
| A confirm call timed out | Repeat it with the same preview reference; you get the transaction the first call created |
| `TOKEN_EXPIRED` | Exchange and retry |
| `RATE_LIMITED` | Wait for `Retry-After` |
| `FLOAT_INSUFFICIENT`, `NO_PROVIDER_AVAILABLE` | Retry later, unchanged; both are the platform's condition, not yours |
| `BALANCE_INSUFFICIENT` | Your balance is short by `details.shortfall`; fund it or reduce the amount |
| `VELOCITY_*_EXCEEDED` | Wait until `details.resets_at` |
| `SIMILAR_PAYMENT_PENDING` | A matching payment is open; `details.transaction` names it. Do not raise another |
| A transaction is `undetermined` | Wait. Never send it again. The money may have moved; the resolution arrives by notification |

Every error carries `retryable`, which says whether repeating the identical request could succeed later. `OUTCOME_UNDETERMINED` is the one failure reason a product must never answer by repeating the payment.

## 7. Support

When a customer contacts your support, they usually quote the reference from their operator's confirmation message. That is `operator_reference` on the transaction, and `GET /v1/transactions?operator_reference=…` finds it. Quote `X-Request-Id` from any response when raising a question with the platform team; it identifies the exact call in the platform's records.

## 8. Sandbox behaviour

In the sandbox, the simulator stands in for the provider and chooses its behaviour by the last two digits of the counterparty number:

| Digits | Behaviour |
|---|---|
| `00` | Rejected at submission (`WALLET_NOT_FOUND`) |
| `01` | Accepted, then fails (`PAYER_DECLINED`) |
| `02` | Stays processing until the sweep ceiling, then `undetermined` |
| `03` | Provider unreachable; fallback applies |
| `04` | Submission times out; `undetermined` at once |
| `05` | Accepted, then `WALLET_BALANCE_INSUFFICIENT` |
| `06` | Requires a one-time code; the code is `123456` |
| `07` | Requires a browser step; completes on its own after about twenty seconds |
| other | Succeeds after a few seconds at a 2 percent provider fee |

Use these to exercise every branch of your handling, including the correction and undetermined cases, before requesting production credentials.
