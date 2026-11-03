# Operations

## Processes

Two kinds of process run from one codebase (spec 15.1):

- `node dist/main.js` serves the project interface, the console interface and provider webhooks.
- `node dist/main.worker.js` carries background work: the status sweep (every 10 s), preview expiry, notification delivery with retries, reconciliation runs, alert evaluation and escalation, float cover, and hourly housekeeping (rate-limit windows, expired tokens and sessions, raw payload retention, ledger checkpoints).

Both are stateless; run as many of each as load requires. Every lock, counter and session lives in PostgreSQL.

## Configuration

See `.env.example`. `MASTER_KEY_BASE64` wraps the data keys under which provider credentials, signing secrets, authenticator seeds, browser-step addresses and payer identifiers are sealed. `INDEX_KEY_BASE64` keys the blind index that allows equality search over payer identifiers. Neither belongs in a file on the host: inject them from the key store at process start, and back up the key store with the database (spec 14.1). The sandbox and production both keep them in a mode-600 env file because their VPS has no key store: that deviation, why, and the go-live gate that an offline copy exists, are in `docs/production-deployment.md`.

`TRUSTED_PROXY_HOPS` names how many proxies sit in front of the API. With `0`, the socket address is the client address and forwarded headers are ignored; with `N`, the address `N` hops from the right of `X-Forwarded-For` is used. Set it to match the deployment exactly: too high and callers can name their own origin, which leaves the allowlist decorative.

The values of spec 14.7 are seeded into `platform_setting` and may be changed there.

## Database

Migrations are SQL files in `apps/api/migrations`, applied in order by `npm run migrate`, each in a transaction and recorded once. A change to the schema is a new file.

Append-only tables (ledger entries and postings, transaction events, audit records, authentication events, discrepancy comments, and others) refuse `UPDATE` and `DELETE` through triggers. In production, additionally run the application under a role without those privileges. `migrate` does this at the end of every run when `APP_DB_ROLE` and `APP_DB_PASSWORD` are set: it creates the role, grants it the run of the schema, and revokes `UPDATE` and `DELETE` on every table where a trigger executing `refuse_mutation()` fires for that event, plus all writes on `schema_migrations`. The list is derived from `pg_trigger` each time, not written down, so a later append-only table is protected without anyone listing it; the run prints what it revoked. Migrations and the one-shot CLIs run as the owner, the API and the worker as `proxiapay_app`, and in production they refuse to start as a superuser or as a role that can update `ledger_entry`. See `docs/production-deployment.md`.

Monetary columns are `BIGINT` and are parsed to JavaScript numbers with a safe-integer check; a value beyond 2^53 is refused rather than rounded.

## Backups and recovery (spec 14.1)

- Continuous archiving of the write-ahead log, plus a daily base backup, retained 35 days (production prunes at a 36-day window, so a full 35 is always restorable), held apart from the running system. Production implements this with WAL-G to Cloudflare R2, encrypted before upload; the setup, the restore procedure and the rehearsal are in `docs/production-deployment.md`.
- The key store's own backup and recovery procedure are part of the same plan: a database restored without its keys yields records that cannot be read.
- Rehearse the restore quarterly into a scratch environment, recover the key store alongside the database, and verify that `LedgerService.verifyCheckpoints` reports nothing and that balances match the figures taken before the rehearsal.
- After a real restore, run reconciliation against every provider account over the interval before the platform resumes serving. Recovery is complete when the reconciliation is.

## Retention (spec 14.3)

Raw provider exchanges are pruned after 90 days by the worker. Everything else is retained; archival beyond the backup cycle for the ten-year term is a deployment concern.

## Key rotation

Data keys are wrapped under the master key per record. To rotate the master key, decrypt each sealed column with the old key and re-seal with the new one (a maintenance script reading `provider_account.credential_ciphertext`, `project_notification_endpoint.signing_secret_ciphertext`, `administrator.totp_secret_ciphertext`, and the `msisdn_ciphertext` and `action_url_ciphertext` columns), then retire the old key. Exercise the rotation before launch.

## Security posture

- Project secrets are argon2id hashes; tokens and session identifiers are stored as SHA-256 of a 256-bit random value.
- Console sessions are HttpOnly, SameSite=Strict cookies scoped to `/console`; mutating calls also require `X-Requested-With: ProxiaPay`.
- Sensitive operations require a one-time code bound to a fingerprint of the submitted values and consumed inside the operation's transaction.
- Every response carries `X-Request-Id`; logs carry it and mask payer identifiers; secrets, codes and browser addresses are redacted.
- Dependencies should be scanned continuously (`npm audit` in CI) and an independent security assessment completed before the first live transaction.

## Email

`Mailer` sends through Resend's HTTP API when `RESEND_API_KEY` is set, and logs messages otherwise. `MAIL_FROM` names the sender and must be an address on a domain verified in Resend; the region mail is routed from (EU, `eu-west-1`, for `proxia-digital.com`) is a property of the domain in the Resend dashboard, chosen when the domain is added. Note that Resend stores account data, logs and API records in the United States whatever the sending region. A refused or unreachable send is recorded in `alert_delivery` as `failed` with the reason. Delivering codes and the sign-in second factor by different channels removes their shared dependency (spec 10.1).
