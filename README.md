# ProxiaPay

ProxiaPay is an internal payment platform that collects money from mobile money wallets and sends money to them across the countries and operators of Central and West Africa. It sits between the company's products and the external providers that move the money, holds the commercial terms, keeps a double-entry ledger of every movement, reconciles against provider records, and presents the whole picture through an administration console.

This repository implements the three specifications in `docs/spec/`: the functional specification, the API reference, and the console interface specification. The build follows section 16 of the functional specification (foundations, collections, reconciliation, disbursements, roles and alerting, treasury operations, a second provider, breadth).

## Layout

| Path | Contents |
|---|---|
| `apps/api` | The platform: project interface (`/v1`), console interface (`/console`), provider webhooks (`/providers`), and the background worker. TypeScript on NestJS over PostgreSQL. |
| `apps/console` | The administration console. React on Vite; served separately and proxied to the API. |
| `docs/` | Integration guide, going-live checklist, operations runbook, design decisions. |
| `docker-compose.yml` | A local PostgreSQL 16. |

## Running locally

Prerequisites: Node 22, PostgreSQL 16 (or Docker for the compose file).

```sh
npm install
cp .env.example apps/api/.env          # then set MASTER_KEY_BASE64 and INDEX_KEY_BASE64 (openssl rand -base64 32)
docker compose up -d postgres
npm run migrate                        # applies apps/api/migrations/*.sql
npm run seed                           # catalogue, roles, alert routing, the sandbox simulator account
npm run admin:create -w apps/api -- --name "Ada" --email ada@example.com --password 'a-long-passphrase'
npm run dev:api                        # http://localhost:3000
npm run dev:worker                     # status sweep, deliveries, reconciliation, alerts, float cover
npm run dev:console                    # http://localhost:5173, proxies /console to the API
```

Sign in to the console with the administrator created above; the first sign-in enrols an authenticator. In development, one-time codes and alerts are written to the API log rather than sent by email (set `RESEND_API_KEY` and `MAIL_FROM` to send them through Resend).

Environments are separate deployments (spec 2.3): `PROXIAPAY_ENV=sandbox` uses the simulator adapter and allows projects without declared origins; `production` requires origins and uses the Ejara adapter.

## Verifying

```sh
npm run typecheck
npm run lint        # includes the money-arithmetic rule of spec 15.7
npm test            # unit and integration tests against TEST_DATABASE_URL (default postgres://postgres@127.0.0.1:5433/proxiapay_test)
```

The integration tests exercise the ledger invariants, the collection and disbursement paths through the simulator (including fallback, undetermined outcomes, one-time codes, reservation under the float lock and concurrency), reconciliation from an uploaded statement, and corrections that notify the project.

## Generating the interface specification

```sh
npm run openapi -w apps/api -- --env sandbox --out openapi.sandbox.json
```

The document is generated from the request schemas the implementation validates with (spec 7.5).

## Where things are

- Money: `apps/api/src/money/money.ts` is the only place fee arithmetic happens. Amounts are integers in minor units; rates are integers in basis points; rounding is half-up and the remainder is recorded.
- Ledger: `apps/api/src/ledger/ledger.service.ts`; the schema enforces balanced entries and append-only tables in `apps/api/migrations/0001_foundations.sql`.
- Transaction state machine: `apps/api/src/transactions/transaction.service.ts`; submission and fallback in `apps/api/src/providers/submission.service.ts`; status acquisition in `apps/api/src/providers/status.service.ts`.
- Provider adapters: `apps/api/src/providers/adapters/` (Ejara Pay and the simulator, behind the contract in `adapter.ts`).
- Reconciliation: `apps/api/src/reconciliation/`.
- Console API: `apps/api/src/console-api/`; console UI: `apps/console/src/pages/`.
- Configured values (spec 14.7): seeded into `platform_setting` from `apps/api/src/seed/catalogue.ts`.

See `docs/decisions.md` for the choices made where the specification left room, and `docs/operations.md` for deployment, backups, key handling and the restore rehearsal.
