# Going-live checklist

A project completes each item against the sandbox before its production credentials are issued (spec 7.5).

## Infrastructure

- [ ] Every address or range the product calls from is known and has been declared on the project. Production refuses calls from elsewhere before credentials are considered.
- [ ] Outbound calls to the platform use TLS 1.2 or later.
- [ ] The notification address is registered, reachable from the platform, served over HTTPS, and responds `2xx` within a few seconds.
- [ ] The signing secret is held in a secret store, not in configuration files or source.

## Behaviour verified in sandbox

- [ ] Token exchange on start-up and on `TOKEN_EXPIRED` only; no exchange per call.
- [ ] Payment screens are built from `GET /v1/settings`, including the currency exponent, both fees with their bearers, limits, and `payer_action`.
- [ ] A preview is shown before a confirmation, and the figures shown are the preview's figures.
- [ ] A confirmation that times out is retried with the same preview reference.
- [ ] At least one sandbox transaction has completed on each route the product will use in production, in each direction it will use.
- [ ] The one-time code sequence has been exercised where a route requires it (counterparty number ending `06`).
- [ ] The browser step has been exercised where a route requires it (`07`), and the address is neither logged nor shown to anyone but the payer.
- [ ] Notification signatures are verified over the raw body; a tampered body and a stale timestamp are rejected; a replayed event identifier is acknowledged and ignored.
- [ ] `transaction.corrected` is handled: a failed collection that is later corrected to succeeded results in the order being fulfilled.
- [ ] An `undetermined` outcome (`02` or `04`) leaves the payment waiting; nothing re-sends it.
- [ ] `FLOAT_INSUFFICIENT` and `NO_PROVIDER_AVAILABLE` are retried later; `BALANCE_INSUFFICIENT` is surfaced with its shortfall.
- [ ] Customer support can search by the operator's reference.

## Operational

- [ ] Logs on the product side carry `X-Request-Id` for calls to the platform.
- [ ] The product's own reference scheme is unique within the project and is what appears in its records.
- [ ] Someone on the product team receives the platform's notification-failure alerts for the project.

## Issued in writing

A project receives its credentials, its declared origins, and the routes it has been granted. Everything else comes from the settings endpoint at the moment it is needed.
