# Production Stack and CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the repo needs so that a `vX.Y.Z` tag on `main` deploys a production ProxiaPay to `pay.proxia-digital.com`: a gated release pipeline, a production seed, a least-privilege database role, WAL-G point-in-time backups to R2, and the runbook.

**Architecture:**
- **CI.** One reusable workflow (`verification.yml`) runs CI everywhere.
- **Release.** `release.yml` gates on the tag being on `main`, verifies, builds four images and deploys over SSH after an approval.
- **Stack.** Production reuses `docker-compose.deploy.yml` with a production-only override (`docker-compose.production.yml`) that adds WAL-G to Postgres and a `backup` service.
- **Database roles.** `migrate` creates and re-grants an app role on every run.
- **Out of this plan.** No VPS, GitHub-settings or tag action is taken here. Those are the rollout steps at the end, each asked of Valentine.

**Tech Stack:** GitHub Actions; Docker Compose; PostgreSQL 16 (`postgres:16-alpine`); WAL-G to Cloudflare R2 (S3 API); NestJS/Kysely `migrate` CLI; Vitest; `actionlint` and `shellcheck` (both installed locally).

**Spec:** `docs/superpowers/specs/2026-11-03-production-and-cicd-design.md`

## Global Constraints

**Release pipeline**
- A release is triggered by `push: tags: ['v*']` and must deploy only if the tagged commit is an ancestor of `origin/main`.
- The release path runs exactly the checks of `ci.yml`, through `verification.yml` (`on: workflow_call`).
- Images are `ghcr.io/iamvaln/proxiapay-{api,console,backup,db}`, tagged `vX.Y.Z` and `latest`.
- The deploy job uses the GitHub environment `production`; Valentine sets the required reviewer.
- The deploy refuses to run unless `docker compose config` reports project `proxiapay`, the same guard as `sandbox.yml`.
- Rollback is a `workflow_dispatch` with input `tag`. It applies the same main-ancestry check, checks that the images exist, and goes through the same environment.
- `sandbox.yml` is unchanged in behaviour: it stays ungated.

**Production stack**
- The production stack directory is `~/proxiapay`. The secrets file is `.env.production`, mode 600, never committed. The template is `deploy/production.env.example`.
- `PROXIAPAY_ENV=production` and `TRUSTED_PROXY_HOPS=1`. `SANDBOX_ANY_SECOND_FACTOR` is never set.
- Fresh `MASTER_KEY_BASE64` and `INDEX_KEY_BASE64`, never the sandbox's.
- The production Ejara base URL is `https://prodbox-valentines-payment.ejaraapis.xyz`.
- Production seed: the whole catalogue is inserted, and only country `CM` is `active`. Every other country is inactive, which the resolver refuses with `COUNTRY_DISABLED`.
- App database role `proxiapay_app`. `migrate` and the CLI jobs run as the owner. `api` and `worker` run as the app role via `APP_DATABASE_URL`. The grants are re-applied at the end of every `migrate`. `UPDATE`/`DELETE` are revoked on every table whose triggers call `refuse_mutation()` for that event.

**Backups**
- WAL-G to bucket `pay-db-backups`, encrypted with libsodium, `archive_timeout=60s`, a daily base backup and 35 days' retention. The `backup` service mounts PGDATA read-only.

**Process**
- The sandbox stack and every other stack on the VPS are never touched.
- Never read `.env*` files. Commits carry no Co-Authored-By trailer.

## Review Focus

1. **A tag pushed on a commit that is not on `main`**, such as a tag on `develop` or a feature branch. Nothing is built or deployed. Pinned in Task 4: `refuses a tag whose commit is not on main`.
2. **A migration that adds a table after the first deploy.** The app role can still read and write it on the next deploy, without anyone touching grants. Pinned in Task 2: `a table created by a later migration is granted to the app role`.
3. **The app role attempting to rewrite history.** `UPDATE`/`DELETE` on a ledger table, or on any append-only table, is refused at the privilege level, not only by the trigger. Pinned in Task 2: `the app role cannot update or delete append-only rows`.
4. **A payment on a not-yet-launched country in production** (for example BF/XOF). It is refused, while CM's four routes resolve. Pinned in Task 1: `production seed leaves only Cameroon live`.
5. **A deploy whose new version doesn't come up healthy.** The job fails visibly instead of reporting green. Pinned in Task 4: `deploy script exits non-zero when healthz never answers 200`.

---

### Task 1: Production seed: Ejara's real URL, Cameroon only

**Files:**
- Modify: `apps/api/src/seed/seed.ts` (provider block around `:70-80`; country activation)
- Test: `apps/api/src/seed/seed.production.test.ts`

**Interfaces:**
- Produces: `seedReferenceData(tx, { environment: 'production' })` writes:
  - provider account `Ejara Pay (production)` with `base_url = 'https://prodbox-valentines-payment.ejaraapis.xyz'` and `has_test_environment = false`;
  - every catalogue route and binding, as today;
  - only `country.code = 'CM'` with `active = true`; every other country `active = false`.
- The sandbox is unchanged: all countries are active.

- [ ] **Step 1: Write the failing tests.** Use the test DB via `createTestContext()`, reset first.

```ts
it('points the production Ejara account at the prodbox URL')        // base_url === 'https://prodbox-valentines-payment.ejaraapis.xyz'
it('production seed leaves only Cameroon live')                     // countries active = ['CM']; RouteResolver preview on CM/XAF/MOMO collection resolves;
                                                                    // on BF/XOF/MOMO collection → PlatformError COUNTRY_DISABLED   (Review Focus 4)
it('sandbox seed keeps every country active')                       // regression guard
it('re-running the production seed changes nothing')                // idempotent: counts and active flags identical after a second run
```

- [ ] **Step 2: Run them.** `cd apps/api && npx vitest run src/seed/seed.production.test.ts`. Expected: FAIL (the URL and active flags are wrong).
- [ ] **Step 3: Implement.**
  - Change the production base URL.
  - After countries are inserted, in production, set `active = (code = 'CM')` for every country.
  - A country already activated by an administrator in the console must stay active when the seed runs again. Only set flags on first insert, using `onConflict doNothing` for the insert and an update only where `created_at` is this transaction's. Choose the simplest idempotent way, and keep the "re-running changes nothing" test green after a manual activation.
- [ ] **Step 4: Run.** Expected: PASS. Then run the full API suite. Expected: PASS.
- [ ] **Step 5: Commit.** Message: "Seed production with Ejara's real URL and only Cameroon live".

---

### Task 2: Least-privilege app role, re-granted by every migrate

**Files:**
- Create: `apps/api/src/db/app-role.ts`
- Modify: `apps/api/src/cli/migrate.ts`
- Modify: `docker-compose.deploy.yml`: `api` and `worker` get `DATABASE_URL: ${APP_DATABASE_URL:-}` in their `environment:` only when it is set. Use Compose's `${APP_DATABASE_URL:-${DATABASE_URL}}` form so the sandbox, which has no `APP_DATABASE_URL`, keeps one URL.
- Test: `apps/api/src/db/app-role.test.ts`

**Interfaces:**
- Produces:
  - `ensureAppRole(pool: Pool, role: string, password: string): Promise<void>`. It creates the login role if missing, otherwise sets its password.
  - `grantAppRole(pool: Pool, role: string): Promise<{ revoked: string[] }>`. It grants `CONNECT`, `USAGE ON SCHEMA public`, `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES`, `USAGE, SELECT ON ALL SEQUENCES`. It then revokes `UPDATE` on every table with a trigger firing on UPDATE that executes `refuse_mutation`, and `DELETE` likewise. The list is derived from `pg_trigger` and `pg_proc`. It returns the tables revoked, as `"table:UPDATE"` / `"table:DELETE"`.
  - `migrate.ts`: after `runMigrations`, if `APP_DB_ROLE` and `APP_DB_PASSWORD` are both set, it calls `ensureAppRole` then `grantAppRole` and logs the revoked list. If only one is set, it fails with a clear error. If neither is set, the sandbox and dev behave as today.

- [ ] **Step 1: Write the failing tests.** Use the test DB. Connect as the app role with a second pool built from the role and password.

```ts
it('the app role reads and writes ordinary tables')                 // insert/update a project row as proxiapay_app
it('the app role cannot update or delete append-only rows')        // UPDATE ledger_entry / DELETE audit_record → 'permission denied' (not the trigger's message)   (Review Focus 3)
it('derives the revoke list from refuse_mutation triggers')        // includes ledger_entry:UPDATE, ledger_entry:DELETE, ledger_posting:*, ledger_checkpoint:*, transaction_event:*,
                                                                    // audit_record:*, authentication_event:*, discrepancy_comment:*, route_binding:*, ledger_account:*, route:*,
                                                                    // route_version:DELETE (not UPDATE: close-only), entitlement_version:DELETE
it('a table created by a later migration is granted to the app role') // create table after a first grant, run grantAppRole again → app role can insert   (Review Focus 2)
it('migrate refuses half an app-role configuration')                // APP_DB_ROLE without APP_DB_PASSWORD → throws
```

- [ ] **Step 2: Run them.** `cd apps/api && npx vitest run src/db/app-role.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Quote the role with `sql.id`, never interpolate it.
  - Pass the password as a parameter where Postgres allows it, otherwise as a quoted literal.
  - Derive the revoke list from `tgtype` bits: UPDATE = 16, DELETE = 8.
- [ ] **Step 4: Run.** Expected: PASS. Then run the full API suite. Expected: PASS. Then check that `docker compose -f docker-compose.deploy.yml config` with a sandbox-like env (no `APP_DATABASE_URL`) still gives api and worker the single `DATABASE_URL`.
- [ ] **Step 5: Commit.** Message: "Run the API as a least-privilege role, re-granted by every migrate".

---

### Task 3: WAL-G backups, production only

**Files:**
- Create: `ops/db/Dockerfile`. `FROM postgres:16-alpine`, plus the static `wal-g` binary (pin a release and verify its sha256), plus `ops/db/archive.sh`.
- Create: `ops/backup/Dockerfile`, `ops/backup/run.sh`. A loop: a daily `wal-g backup-push` at `BACKUP_SCHEDULE_HOUR_UTC` (default 2), then `wal-g delete retain FULL 35 --confirm`. It logs `base backup pushed` and `pruned` on success, and `BACKUP FAILED: <reason>` and a non-zero step on failure.
- Create: `docker-compose.production.yml`, the override:
  - `db` uses `ghcr.io/iamvaln/proxiapay-db:${IMAGE_TAG}` with `command: postgres -c archive_mode=on -c archive_timeout=60 -c archive_command='/usr/local/bin/archive.sh %p' -c wal_level=replica`;
  - adds service `backup` (`proxiapay-backup:${IMAGE_TAG}`), which mounts the db volume read-only and reaches `db` over the stack network for streaming base backups;
  - both read `WALG_*` and `AWS_*` from `.env.production`.
- Create: `ops/backup/rehearse.sh`. A local end-to-end rehearsal against MinIO:
  1. start db+minio;
  2. write rows;
  3. push a base backup;
  4. write more rows;
  5. note the time T and write more;
  6. restore into a scratch volume to T;
  7. check the rows up to T are present and the later ones absent.
- Test: the rehearsal script (not part of `npm test`; run by the implementer and in the runbook).

**Interfaces:**
- Produces:
  - **Environment variables:**
    - `WALG_S3_PREFIX=s3://pay-db-backups/proxiapay`
    - `AWS_ENDPOINT=https://<account>.r2.cloudflarestorage.com`, `AWS_REGION=auto`, `AWS_S3_FORCE_PATH_STYLE=true`
    - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
    - `WALG_LIBSODIUM_KEY` (32-byte base64; generated at setup)
    - `BACKUP_SCHEDULE_HOUR_UTC`
  - **Images:** `proxiapay-db` and `proxiapay-backup`, built by Task 4.

- [ ] **Step 1: Write `rehearse.sh`, and run it before the images exist.** Expected: FAIL (images missing).
- [ ] **Step 2: Build the two images, the archive script and the loop.**
- [ ] **Step 3: Run `bash ops/backup/rehearse.sh`.** Expected: `REHEARSAL OK: restored to <T>, N rows before T present, M rows after T absent`. Then `shellcheck ops/db/*.sh ops/backup/*.sh` must be clean.
- [ ] **Step 4: Check the compose files.**
  - `docker compose -f docker-compose.deploy.yml -f docker-compose.production.yml config` with a production-like env must parse.
  - `docker compose -f docker-compose.deploy.yml config` with a sandbox env must show the unchanged stock `db` and no `backup` service.
- [ ] **Step 5: Commit.** Message: "Back the production database up continuously with WAL-G".

---

### Task 4: The release pipeline

**Files:**
- Create: `.github/workflows/verification.yml`. The job from `ci.yml` moves here verbatim, under `on: workflow_call`.
- Modify: `.github/workflows/ci.yml`. It becomes `on: [push, pull_request]` → `jobs.verify: uses: ./.github/workflows/verification.yml`.
- Create: `.github/workflows/release.yml`.
- Create: `ops/release/check-tag-on-main.sh <tag>`. It exits 0 if `git merge-base --is-ancestor <tag>^{commit} origin/main`, and 1 otherwise with "tag <tag> is not on main".
- Create: `ops/release/deploy.sh`. It is the SSH script body:
  1. fetch tags with the token extraheader, as in lehno;
  2. `git checkout <tag>`;
  3. the project-name guard, expecting `proxiapay`;
  4. pull, retried 3 times;
  5. `up -d db migrate api worker console backup` with both `-f` files and `--env-file .env.production`;
  6. run `set-credentials` from `provider-credentials.env`, as `sandbox.yml` does;
  7. wait up to 120 s for `https://$APP_DOMAIN/healthz` to answer 200, and exit 1 otherwise;
  8. prune to the 2 latest version tags per image.
- Create: `ops/release/test-release-scripts.sh`. It tests both scripts against a temporary git repo and a fake `curl`/`docker`.

**Interfaces:**
- **Consumes:** Task 3's `ops/db` and `ops/backup` build contexts.
- **`release.yml` jobs:**
  - `gate`: checkout with `fetch-depth: 0`, then `check-tag-on-main.sh "$GITHUB_REF_NAME"`. For `workflow_dispatch`, it checks `inputs.tag` and that `ghcr.io/iamvaln/proxiapay-api:<tag>` exists (`docker manifest inspect`).
  - `verify`: `uses: ./.github/workflows/verification.yml`, needs gate, runs only on tag pushes.
  - `build-api`, `build-console`, `build-db`, `build-backup`: need verify, run only on tag pushes, same shape as `sandbox.yml`'s build jobs, tags `${{ github.ref_name }}` and `latest`.
  - `deploy`: needs the builds (or the gate alone on a dispatch), `environment: production`, appleboy/ssh-action running `ops/release/deploy.sh` with `IMAGE_TAG`, `GHCR_USER`, `GHCR_TOKEN` and `APP_DIR` (secret `VPS_APP_DIR`, default `$HOME/proxiapay`).
- **Secrets used:** `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PORT` (all already exist for the sandbox), plus the optional `VPS_APP_DIR`.

- [ ] **Step 1: Write the failing script tests** (`ops/release/test-release-scripts.sh`):

```bash
test "refuses a tag whose commit is not on main"            # tag on a side branch → exit 1, message names the tag   (Review Focus 1)
test "accepts a tag on main"
test "deploy script exits non-zero when healthz never answers 200"   # fake curl always 502 → exit 1 within the timeout   (Review Focus 5)
test "deploy script stops when compose reports another project"      # fake docker compose config → name: proxiapay-sandbox → exit 1 before any up
```

- [ ] **Step 2: Run them.** `bash ops/release/test-release-scripts.sh`. Expected: FAIL (scripts missing).
- [ ] **Step 3: Write the scripts and the workflows.**
- [ ] **Step 4: Verify.**
  - `bash ops/release/test-release-scripts.sh`: all pass.
  - `shellcheck ops/release/*.sh`: clean.
  - `actionlint .github/workflows/*.yml`: clean.
  - Push the branch so `ci.yml` runs through `verification.yml` (pushing a feature branch is allowed), and check it is green with the same five steps.
- [ ] **Step 5: Commit.** Message: "Release production from a v* tag on main, gated, verified and approved".

---

### Task 5: The runbook and the go-live gates

**Files:**
- Create: `deploy/production.env.example`. Every variable with a comment, in the style of `deploy/sandbox.env.example`:
  - `APP_DATABASE_URL`, `APP_DB_ROLE`, `APP_DB_PASSWORD`;
  - the `WALG_*` and `AWS_*` variables;
  - `PROXIAPAY_ENV=production`, `STACK=proxiapay`, `APP_DOMAIN=pay.proxia-digital.com`, `CERT_RESOLVER=le`;
  - `COMPOSE_FILE=docker-compose.deploy.yml:docker-compose.production.yml`, so manual commands get the override too.
- Create: `docs/production-deployment.md`, the runbook:
  - first-time setup on the VPS (clone, env file, `provider-credentials.env`);
  - key generation, and the warning that the keys must be copied offline before the first real transaction;
  - first boot, seed and `create-admin`;
  - GitHub settings Valentine changes: environment `production` with required reviewer and deployment tags `v*`;
  - cutting a release;
  - rollback, with the forward-only migration caveat;
  - backups: where, how to check them, and the restore procedure with `LedgerService.verifyCheckpoints`;
  - the `0002` index-lock note;
  - activating a new country from the console;
  - the documented deviation: keys in `.env.production` rather than a key store, and why.
- Modify: `docs/going-live-checklist.md`. Add a "Platform (before the first real transaction)" section with the spec's four gates.
- Modify: `docs/operations.md`. Point to the runbook for the deviation and the backup implementation.

- [ ] **Step 1: Write a doc check test.** It reads `deploy/production.env.example` and asserts that every variable the API config schema, the compose files and the backup scripts read is present. Place it in `apps/api/src/docs/production-env.test.ts`.

```ts
it('names every variable production needs')   // config.ts schema keys ∪ ${VARS} in both compose files ∪ WALG_/AWS_ vars in ops/ → all present in deploy/production.env.example
it('never sets the sandbox second-factor switch')
```

- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Write the files.**
- [ ] **Step 4: Run it** (PASS), then the full API suite.
- [ ] **Step 5: Commit.** Message: "Write the production runbook and the platform's go-live gates".

---

## Rollout (after the branch merges; each step asked of Valentine first, none done by an implementer)

1. **GitHub settings, by Valentine:**
   - create the environment `production` with Valentine as required reviewer;
   - allow the deployment tag `v*`.
2. **VPS:**
   - `git clone` into `~/proxiapay`;
   - fill `.env.production`, which Valentine completes with the R2 key and Resend;
   - generate the keys there;
   - fill `provider-credentials.env` with the Ejara values;
   - `chmod 600` both.
3. **First boot:**
   - `up -d db migrate`;
   - `run --rm migrate node dist/cli/seed.js`;
   - `create-admin`.
4. **Tag `v1.0.0` on `main`**, then approve the deploy in GitHub.
5. **Go-live gates:**
   - the offline key copy;
   - the restore rehearsal on production backups;
   - the Ejara balances match.
