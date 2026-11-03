# Production stack and CI/CD

Status: design, awaiting approval · 2026-11-03

## Why

ProxiaPay runs only as a sandbox (`sandbox.pay.proxia-digital.com`).
Nothing serves `pay.proxia-digital.com`. The DNS A record already points at
the VPS, but no stack answers. Projects such as MonJeton cannot get production
credentials (`pk_live_…`) until a production platform exists. The goal is a
production stack that a tag deploys the way gabee and lehno already deploy,
with a level of safety suited to real money.

## Goals

- A production stack on `pay.proxia-digital.com`, on the shared VPS, kept
  fully apart from the sandbox.
- Releases deployed by a git tag on `main`, through a pipeline that cannot
  ship what CI would reject.
- Point-in-time recovery of the production database. WAL is shipped at least
  every minute (`archive_timeout = 60s`), so a crash loses at most about a
  minute of writes.
- A first production release with Ejara bound and one administrator, ready for
  a project's onboarding.

## Non-goals

- **MonJeton's production onboarding.** Creating the project, declaring its
  origins, issuing `pk_live_…` and registering its webhook come next, as a
  short follow-up.
- **A secrets manager.** Valentine decided this, following gabee and lehno.
- **The offline copy of the encryption keys.** Postponed by Valentine, but it
  is a go-live gate. See Constraints.
- **Monitoring and alerting beyond what exists.** That means the platform's
  own alert emails and the deploy healthcheck.
- **A staging environment between sandbox and prod.** The sandbox plays that
  role.

## Anti-goals

- A tag that deploys while CI is red. lehno lived through this, from v0.1.2 to
  v0.1.4.
- A production deploy that can touch the sandbox stack, or the reverse.
- Any sandbox shortcut reaching prod:
  - simulator provider;
  - `SANDBOX_ANY_SECOND_FACTOR`;
  - keys copied from the sandbox;
  - the dev seeder.
- A database restore that cannot read its own data because the keys are gone.

## Decided by Valentine

1. **Release flow, as in gabee and lehno** (`~/dev/lehno/.github/workflows/release.yml`):
   - `develop` keeps auto-deploying the sandbox;
   - `main` runs CI only;
   - **a tag `vX.Y.Z` on `main` deploys production.**
2. **Secrets live in `.env.production` on the VPS**: not versioned, mode 600,
   no secrets manager. GitHub Actions holds only the deploy secrets:
   `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` and an optional `VPS_PORT`.
3. **Backups go to a Cloudflare R2 bucket, `pay-db-backups`**, created by
   Valentine. Its access key goes straight into `.env.production` on the VPS
   and never into chat or git.
4. **The offline backup of `MASTER_KEY_BASE64` and `INDEX_KEY_BASE64` is
   postponed** until after the production setup, then handled for every
   project at once. It must exist before the first real transaction.
5. **Progressive rollout of routes.** Ejara's integration covers every
   country in the sandbox catalogue, but only Cameroon has been proven with
   real money: XAF, MTN MoMo and Orange Money, collection and payout. Production
   therefore launches with those 4 routes live. The production seed inserts
   the full catalogue, but only Cameroon is active. Every other country is
   inactive and gets no active route binding, so nothing can route into it.
   Each later country is switched on from the console (Configuration ▸
   Countries ▸ Activer, with its impact warning) once it has been exercised in
   the sandbox. No code change and no deploy are needed. The builder adds a
   test: in production, only CM's 4 routes resolve.

## The pipeline

### `verification.yml` (new, reusable)

- Holds today's CI steps from `ci.yml`, unchanged: `npm ci`, typecheck, lint,
  test against a Postgres 16 service, the console build, and
  `npm audit --omit=dev --audit-level=high`.
- Declared `on: workflow_call`.
- `ci.yml` becomes a thin caller for pushes and PRs.
- `release.yml` calls it first, so the release path can never check less than
  the PR path (lehno's fix).

### `release.yml` (new)

- **Trigger:** `on: push: tags: ['v*']`.
- **Main-only gate.** A first job checks that the tagged commit is reachable
  from `origin/main`, and fails otherwise. A tag pushed on `develop` or on a
  feature branch must never deploy. This is my call; lehno doesn't check it.
- **Jobs:**
  1. `verify` runs `verification.yml`.
  2. `build-api`, `build-console` and `build-backup` push to GHCR as
     `proxiapay-{api,console,backup}:vX.Y.Z` and `:latest`, in the same shape
     as `sandbox.yml`'s build jobs.
  3. `deploy` connects over SSH to `~/proxiapay`. It runs under the GitHub
     **environment `production` with required reviewer = Valentine**, so each
     deploy waits for a click in GitHub. This is my call for real money; lehno
     leaves it optional.
     - `git fetch --tags` authenticated through the extraheader form lehno
       uses, because the shared VPS hits GitHub's anonymous rate limit;
     - `git checkout vX.Y.Z`;
     - the same `STACK` guard `sandbox.yml` has. Compose must report project
       `proxiapay`, or the job stops;
     - `docker compose --env-file .env.production pull`, retried 3 times;
     - `up -d db migrate api worker console backup`;
     - wait for `https://pay.proxia-digital.com/healthz` to return 200, for up
       to 2 minutes;
     - keep the 2 latest version tags per image, for rollback.
- **Rollback:** `workflow_dispatch` with an input `tag`. It runs the deploy job
  alone for an earlier, already built tag. The same main-only check applies to
  that tag, the job checks that its images exist in GHCR, and the same
  `production` approval is required. My call. Migrations are forward-only, so
  rolling back below a migration needs a hand-written fix. The runbook says
  so.

### `sandbox.yml`

No change. It stays ungated on purpose (its header says so): `develop`'s
merges have already passed CI as PRs, and the sandbox carries no real money.

## The production stack

- **Location:** directory `~/proxiapay` on the VPS, a clone of the repo, and
  user `deploy`.
- **Compose file:** the same `docker-compose.deploy.yml` the sandbox uses.
- **`.env.production`** (template committed as
  `deploy/production.env.example`, after `deploy/sandbox.env.example`):
  - `ENV_FILE=.env.production`, `STACK=proxiapay`,
    `APP_DOMAIN=pay.proxia-digital.com`, `CERT_RESOLVER=le`;
  - `IMAGE_TAG` is set by the deploy;
  - `PROXIAPAY_ENV=production`, `NODE_ENV=production`;
  - its own `POSTGRES_PASSWORD` and `DATABASE_URL`;
  - **fresh** `MASTER_KEY_BASE64` and `INDEX_KEY_BASE64`, never copied from
    the sandbox;
  - `CONSOLE_ORIGIN=https://pay.proxia-digital.com`;
  - Resend, with `MAIL_FROM` on `proxia-digital.com`;
  - alert addresses;
  - the R2 backup variables (below).

  Never `SANDBOX_ANY_SECOND_FACTOR`: the API already refuses to start with it.
- **Two database roles**, as `docs/operations.md` prescribes. My calls:
  - `migrate` and the CLI jobs (`seed`, `create-admin`, `set-credentials`)
    connect as the **owner**;
  - `api` and `worker` connect as **`proxiapay_app`**, through a second URL
    (`APP_DATABASE_URL`) that the compose file maps to their `DATABASE_URL`.
    The sandbox keeps a single URL, so the mapping falls back to
    `DATABASE_URL` when `APP_DATABASE_URL` is unset;
  - **the grants are re-applied at the end of every `migrate` run**, so a
    table added by a later migration is never missing for the app. That
    means `GRANT SELECT, INSERT, UPDATE, DELETE` on all tables, plus `USAGE`
    on sequences;
  - **the revoke list is derived, not hard-coded**: `UPDATE`/`DELETE` are
    revoked on every table that carries the append-only trigger, found by
    querying `pg_trigger`. A new append-only table is protected
    automatically;
  - a test checks that the derived list includes today's tables (the ones
    `docs/operations.md` names).
- **`TRUSTED_PROXY_HOPS=1`.** It is already set in `docker-compose.deploy.yml`.
  Production enforces declared origins, so this value is load-bearing: Traefik
  is the one hop.
- **Certificate.** `pay.proxia-digital.com` resolves directly to the VPS
  (77.237.234.91), not through Cloudflare's proxy, so `le` (TLS-ALPN) works.
  The note from the sandbox doc applies here too.
- **The production seed** runs **once, by hand**, at first setup, as the
  sandbox's does. It is idempotent if run again. It must point the Ejara
  account at the real base URL. Today `seed.ts:77` writes `https://ejara-pay.vercel.app` for
  production, which is stale. The URL proven with real money is
  `https://prodbox-valentines-payment.ejaraapis.xyz`, and the VPS IP is on
  that host's allowlist. The builder fixes the seed and adds a test.
- **Ejara credentials:**
  - they arrive through the existing `set-credentials` mechanism, from
    `~/proxiapay/provider-credentials.env` (mode 600), on every deploy;
  - that file is never passed to Compose as an env file, because the Ejara
    secret contains a `$`;
  - Valentine fills it from the values already in their local
    `.env.production`.
- **The first administrator** is created with `create-admin` and enrols a real
  TOTP at first sign-in.

## Backups (spec 14.1, `docs/operations.md`)

**What spec 14.1 asks:**
- continuous WAL archiving;
- a daily base backup;
- 35-day retention, held apart from the running system.

**How it is built:**
- **Tool: WAL-G, to R2 through its S3 API**, bucket `pay-db-backups`.
- **Production only.** A compose override file,
  `docker-compose.production.yml`, layered on `docker-compose.deploy.yml` with
  `-f`, swaps the `db` image for one that adds WAL-G (built from
  `postgres:16-alpine`), sets `archive_mode=on`, `archive_timeout=60s` and the
  `archive_command`, and adds the `backup` service. The sandbox's stack is
  untouched. My call.
- **The `backup` service** mounts the db volume **read-only**, for
  `backup-push`. Base backups run through WAL-G's streaming mode against the
  `db` service, so nothing writes into PGDATA from outside Postgres.
- **The `backup` image** (`apps/backup` or `ops/backup`, the builder's call):
  - Postgres runs with `archive_mode=on` and an `archive_command` that ships
    each WAL segment through WAL-G;
  - a small scheduler takes the daily base backup and prunes beyond 35 days;
  - the backup runs as a service of the stack.
- **Encryption:** backups are encrypted client-side before upload, with a key
  of their own (WAL-G libsodium). R2 never sees plaintext data.
- **Restore:**
  - a runbook section in a new `docs/production-deployment.md`;
  - one rehearsal before go-live, restoring into a scratch database;
  - `LedgerService.verifyCheckpoints` must report nothing after the restore,
    and balances must match.

## Go-live gates

These are added to `docs/going-live-checklist.md`, under a new "Platform"
section. They must all be true before the first real transaction:

1. **The offline copy exists** of `MASTER_KEY_BASE64`, `INDEX_KEY_BASE64` and
   the backup encryption key, kept apart from the VPS and from R2 (decision 4).
2. **A restore rehearsal passed**, as above.
3. **The `production` environment requires approval** in the GitHub settings.
4. **Ejara balances** in the console match the Ejara dashboard.

## Constraints

- The VPS is shared with other stacks: Traefik on the `web` network, and the
  project name must stay unique. Nothing in this work may restart or reconfigure
  Traefik or another stack.
- **`main` is `origin/main`.** It is 31 commits behind `develop` today.
  GitHub's default branch is still `claude/proxiapay-build-ys15gi`, so
  switching it to `main` is a GitHub setting Valentine changes. Before the
  first tag, a PR `develop` → `main` is opened, and Valentine merges it.
- **First release content:** the first tag is cut from `main` once `develop`
  is merged into it. It contains whatever `develop` holds at that moment,
  including the console tables work if PR #2 has merged by then. My call.
- **Migration `0002_list_indexes.sql`** creates its indexes with plain
  `CREATE INDEX` and locks writes while it runs. On a fresh production
  database that costs nothing, but say so in the runbook.
- **Docs and deploy files** stay in English and follow the sandbox docs' style.
  Commits carry no Claude attribution.
- **Ask before acting outside the repo:**
  - pushing tags;
  - creating the VPS directory;
  - writing `.env.production`;
  - setting GitHub secrets or environments;
  - running anything on the VPS.

## Left to the builder

- The scheduler inside the backup image (cron, supercronic or a loop).
- How the `proxiapay_app` role is created and given its password: an init
  script on first boot, or a step in `migrate`.
- The exact healthcheck loop and timeouts.
- How to test the workflows before the first real tag. For example, a
  `v0.0.0-rc.1` tag on a commit not on `main` must be refused, and the deploy
  job's script shell-checked.
