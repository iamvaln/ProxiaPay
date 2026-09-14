# Decisions

Choices made where the specification left room, with the reasoning.

**Job queue in PostgreSQL, written in-house.** Spec 15.3 prefers a mature library. The platform's background work is domain scheduling (per-transaction status checks at decreasing intervals up to a ceiling, notification retries with per-attempt records), which maps poorly onto generic job semantics, and the pattern (a jobs table, `FOR UPDATE SKIP LOCKED`, enqueue in the caller's transaction) is small and fully tested here. Moving to graphile-worker or pg-boss changes `src/jobs/` alone.

**Opaque tokens, not JWTs.** Project tokens and console sessions are random values stored hashed. Revocation is then immediate by construction (spec 3.3 of the API reference), which a self-contained token cannot offer without a denylist.

**Rate limits and breaker state in the store.** Spec 15.6 requires counters shared across instances. Fixed one-minute windows in a table suffice at the target rate; a shared cache would replace them at volumes well beyond it.

**Blind index for payer identifiers.** Identifiers are encrypted at the column level (spec 14.4) and equality lookups (duplicate guard, global search) use an HMAC under a separate key, so search needs no plaintext.

**Provider calls between transactions.** Submission is recorded as sent, the provider is called outside any database transaction, and the outcome is recorded after. A process dying in between leaves a transaction the sweep moves to undetermined, which is the safe answer; holding a row lock through a 30-second provider call is not.

**Synchronous submission on confirm, with a safety net.** The API reference expects confirmation to return the transaction in `processing` or `action_required`, so the provider is called during the request. A job scheduled a minute out submits anything still `created` if the request was interrupted.

**Disputed transactions stay in reconciliation scope.** Spec 9.1 names open and recently terminal transactions; a transaction under an open discrepancy is kept in scope until the discrepancy is resolved, so the finding is re-verified each run and recurrence is counted.

**TOTP implemented locally.** RFC 6238 over RFC 4226 is forty lines against a stable standard, tested against the RFC vectors, and avoided a deprecated dependency.

**Statement format `ejara_csv_v1`.** The provider's console export was not available at integration; the parser matches likely header names case-insensitively and reports rows it cannot read. Adjust `src/reconciliation/statement-format.ts` once a real export is in hand.

**Catalogue seed.** The commercial annex was not supplied with the specifications. The seed carries a representative catalogue across the eleven countries and five currencies, with the four corrections of spec 12 applied and every fee marked indicative. Replace `src/seed/catalogue.ts` with the annex figures before the pilot.

**Project references are unique without a horizon.** Spec 5.5 allows reuse after thirteen months. The uniqueness constraint here is absolute; relaxing it is a retention job that clears the constraint's index rows, and was left until the retention policy is confirmed (spec 18).
