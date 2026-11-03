# Deploying production

Production is `https://pay.proxia-digital.com`, the stack `proxiapay` on the same
shared VPS as the sandbox (`77.237.234.91`). It runs the real provider adapters
and holds real money. The sandbox is described in `docs/sandbox-deployment.md`;
this document says where production differs and what only production needs.

A tag deploys it. The pipeline is `.github/workflows/release.yml` and
`ops/release/deploy.sh`; the backups are `docker-compose.production.yml`,
`ops/db` and `ops/backup`.

## What runs

The sandbox's five services (`docker-compose.deploy.yml`), with these differences,
the first two from the override `docker-compose.production.yml`:

| Service | Production difference |
|---|---|
| `db` | `ops/db` image: PostgreSQL 16 plus WAL-G. Archives every WAL segment to R2, and closes one at least every 60 s (`archive_timeout=60`). |
| `backup` | New. A daily WAL-G base backup of the db volume (mounted read-only), then pruning. |
| `migrate` | Runs as the database owner. Creates the `proxiapay_app` role and re-grants it at the end of every run. |
| `api`, `worker` | Connect as `proxiapay_app` through `APP_DATABASE_URL`, never as the owner. They refuse to start otherwise (see "The database role"). |
| `console` | As the sandbox. |

Images are `ghcr.io/iamvaln/proxiapay-{api,console,db,backup}:vX.Y.Z`, built by
the release workflow. **Nothing is ever built on the VPS**: the deploy runs `up --no-build`, and a missing image fails it instead of compiling WAL-G on the production host.

## Two env files

| File on the VPS | Read by | Holds |
|---|---|---|
| `~/proxiapay/.env.production` | api, worker, migrate, and Compose's `${…}` interpolation (`--env-file`) | the platform's configuration, `MASTER_KEY_BASE64`, `INDEX_KEY_BASE64`, Resend, `APP_DATABASE_URL`, `OWNER_ENV_FILE` |
| `~/proxiapay/.env.production.owner` | db, migrate and backup only | `POSTGRES_USER/PASSWORD/DB`, the owner `DATABASE_URL`, `APP_DB_ROLE`, `APP_DB_PASSWORD`, every `WALG_*`, `AWS_*` and `BACKUP_*` variable |

The split is what makes the least-privilege role real. If the api read the owner
file, a compromise of the api would hold the database owner's password and the
key to the backups. Templates: `deploy/production.env.example` and
`deploy/production.owner.env.example`. A test
(`apps/api/src/docs/production-env.test.ts`) keeps them complete, keeps each
variable in its own file, and checks that neither sets `SANDBOX_ANY_SECOND_FACTOR`
(the api refuses to start with it in production anyway).

A third file, `provider-credentials.env`, holds the Ejara credentials. It is
**never passed to Compose** as an env file: the Ejara secret contains a `$`, which
Compose would interpolate. The deploy hands it to `set-credentials`, which parses
it literally (see `docs/sandbox-deployment.md`, "Provider credentials").

## The database role

`migrate` runs as the owner and, at the end of every run, creates or updates
`APP_DB_ROLE` (`proxiapay_app`) and re-applies its grants: the run of the schema,
minus what the append-only tables must refuse. The revoke list is **derived, not
written down**: `UPDATE` and `DELETE` are revoked on every table that carries a
trigger on that event executing `refuse_mutation()`, found in `pg_trigger`
(`apps/api/src/db/app-role.ts`), and `INSERT`, `UPDATE` and `DELETE` on
`schema_migrations`, which only the owner may rewrite. A table added by a later
migration is covered the next time `migrate` runs, with nobody having to
remember it. The run prints what it revoked (`granted … revoked …`).

When `PROXIAPAY_ENV=production`, the api and the worker check at start which role
they are connected as, and refuse to start (`refusing to start in production: …`)
if it is a superuser or can `UPDATE` any table guarded by a `refuse_mutation`
trigger, not only `ledger_entry` (`apps/api/src/db/production-guard.ts`).
A mistyped `APP_DATABASE_URL` therefore stops the stack with a message, and a
missing one leaves `DATABASE_URL` empty, which is a configuration failure: neither
runs the app as the owner. Never `export` `DATABASE_URL` or `APP_DATABASE_URL` in
the deploy user's shell: an exported variable overrides `--env-file`.

## GitHub settings

Changed by Valentine, once, before the first tag. `VPS_HOST`, `VPS_USER`,
`VPS_SSH_KEY` and (optional) `VPS_PORT` are **environment secrets**, not
repository secrets. `VPS_APP_DIR` (the checkout's directory, default `~/proxiapay`)
is optional and belongs to `production` only.

1. **Environment `production`** (Settings, Environments). Required reviewer:
   Valentine. Deployment branches and tags: **selected**, limited to `main` and
   the tag pattern `v*`. The deploy job is the only one that uses it, so a release
   waits for an approval, and a ref the environment does not accept cannot get one.
   Put `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_PORT` here as environment secrets.
   **Environment `sandbox`**: no reviewer, deployment branches limited to
   `develop`, the same four secrets (the sandbox deploy job declares
   `environment: sandbox`). Then **delete the repository-level `VPS_*` secrets**:
   while they exist, any workflow, on any branch, can read the SSH key.
   What the approval protects: an accidental or unintended deploy of production.
   What it does not protect: a compromised action (or a malicious change to a
   workflow on an accepted ref) inside a job that already holds the key. That is why
   every third-party action is pinned to a commit SHA, and bumped by hand.
2. **A tag ruleset for `v*`** (Settings, Rules): restrict who can create, update
   and delete tags matching `v*`, and block force pushes. A release tag moved
   after its approval would deploy other code than the code approved.
3. **Branch protection**: the required status check on `main` (and `develop`) is
   renamed from `test` to **`verify / test`**, because CI now runs through the
   reusable `verification.yml` and the check carries the caller's job name.
4. **The default branch** is still `claude/proxiapay-build-ys15gi`. Switch it to
   `main`: the first tag is cut from `main` once `develop` is merged into it
   (a pull request, merged by Valentine).

## VPS prerequisites

- The deploy user (`VPS_USER`) has **bash as its login shell**: `deploy.sh` is run
  through it over SSH and uses bash.
- `~/proxiapay` is a clone whose `origin` is **`https://github.com/iamvaln/ProxiaPay.git`**
  (https, not ssh): the deploy fetches tags with this run's token in an HTTP
  header, which an ssh remote would ignore.
- `.env.production`, `.env.production.owner` and `provider-credentials.env` exist,
  mode **600**, untracked. The deploy refuses to run over local edits to
  tracked files, but expects these three.
- Docker with the Compose plugin; the external network `web` and the shared
  Traefik already exist. Nothing here touches either, nor another stack.

## First-time setup

Done once, by Valentine, on the VPS.

```sh
ssh deploy@77.237.234.91
git clone https://github.com/iamvaln/ProxiaPay.git ~/proxiapay
cd ~/proxiapay && git checkout main

cp deploy/production.env.example .env.production
cp deploy/production.owner.env.example .env.production.owner
cp deploy/provider-credentials.env.example provider-credentials.env
chmod 600 .env.production .env.production.owner provider-credentials.env
```

Fill every `<…>`; the notes in the files say what each is. Generate the secrets
**on the VPS**, fresh, never copied from the sandbox or a workstation:

```sh
openssl rand -hex 24      # POSTGRES_PASSWORD (also in the owner DATABASE_URL), APP_DB_PASSWORD (also in APP_DATABASE_URL)
openssl rand -base64 32   # MASTER_KEY_BASE64
openssl rand -base64 32   # INDEX_KEY_BASE64
openssl rand -base64 32   # WALG_LIBSODIUM_KEY
```

The R2 access key (scoped to the bucket `pay-db-backups`) and the Resend key come
from their dashboards. The Ejara client key and secret go in
`provider-credentials.env`.

**Before anything else, copy `MASTER_KEY_BASE64`, `INDEX_KEY_BASE64` and
`WALG_LIBSODIUM_KEY` somewhere offline.** See "Go-live gates": nothing real may
happen until that is done.

### First boot: release first

The order matters, because the stack runs only from images the release workflow
built and pushed. **Never run `dc` (below) before the first release has pushed
the images**: Compose has `build:` stanzas, and with no local image it would
compile WAL-G and the api on the VPS. Any hand-run `dc up` is preceded by
`dc pull` and uses `--no-build` (the deploy does the same).

1. Merge `develop` into `main`, apply the GitHub settings above, and fill the
   three files on the VPS (the previous section).
2. Push `v1.0.0` on `main` (see "Cutting a release") and approve the deployment.
   `release.yml` builds the four images, then `deploy.sh` brings up `db`,
   `migrate` (as the owner: runs the migrations and creates `proxiapay_app`),
   `api`, `worker`, `console` and `backup` with `--no-build`, and runs
   `set-credentials` on `provider-credentials.env` (a no-op until the seed). The `backup` service takes the
   first base backup the moment it starts (archived WAL is useless without one),
   then one a day at `BACKUP_SCHEDULE_HOUR_UTC`.
3. Seed and create the administrator from the pulled images. A short alias for
   these commands, which names both Compose files:

   ```sh
   cd ~/proxiapay
   # IMAGE_TAG is never stored: deploy.sh leaves HEAD detached on the deployed tag,
   # and the alias reads it from there, so it can not go stale after a release.
   dc() {
     local tag; tag=$(git describe --tags --exact-match HEAD 2>/dev/null) \
       || { echo "HEAD is not on a release tag; run the deploy first (or git checkout --detach vX.Y.Z)"; return 1; }
     IMAGE_TAG=$tag docker compose --env-file .env.production -f docker-compose.deploy.yml -f docker-compose.production.yml "$@"
   }

   # Reference data: the whole catalogue, roles, alert routing, and the Ejara
   # account on https://prodbox-valentines-payment.ejaraapis.xyz. Only Cameroon
   # (CM) is active; every other country is inactive until activated from the
   # console. Idempotent, and a country an administrator activated stays active.
   dc run --rm migrate node dist/cli/seed.js

   # The first deploy ran before the seed, so there was no provider account to
   # seal the Ejara credentials into (it did nothing, without failing). Seal
   # them now; every later deploy does it by itself.
   dc run --rm -T -v "$PWD/provider-credentials.env:/run/provider-credentials.env:ro" \
     migrate node dist/cli/set-credentials.js /run/provider-credentials.env

   # Your administrator. The first sign-in enrols a real authenticator.
   # The password goes through the environment, not the command line, so it is
   # neither in `ps` nor in the shell history (-e ADMIN_PASSWORD copies the
   # variable from this shell, and `read -rs` keeps it off the screen and out
   # of the history).
   read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD
   dc run --rm -e ADMIN_PASSWORD migrate node dist/cli/create-admin.js --name "Your Name" --email you@example.com
   unset ADMIN_PASSWORD
   ```

**If R2 is unreachable on the first boot** (wrong key, no route), `db` can end
up `unhealthy`: the first-boot init server archives on shutdown and fails, and the
deploy fails on it. Fix the cause and re-run the deploy job in GitHub (or, by
hand, `dc pull db && dc up -d --no-build db`). It is not data loss.

## Cutting a release

1. Merge into `main` through a reviewed pull request. CI (`verify / test`) must be
   green.
2. Tag the merge commit and push the tag:

   ```sh
   git checkout main && git pull
   git tag v1.0.0
   git push origin v1.0.0
   ```

3. `release.yml` runs, in order:
   - **gate**: the tag is `v<number>…` and its commit is an ancestor of
     `origin/main`. A tag cut from any other branch stops here;
   - **verify**: the same checks as every pull request (`verification.yml`:
     typecheck, lint, tests, console build, `npm audit`);
   - **build**: the four images, tagged `vX.Y.Z` and `latest`;
   - **deploy**: waits in GitHub for Valentine's approval of the `production`
     environment, then runs `ops/release/deploy.sh` on the VPS.
4. Approve the deployment in GitHub when you mean it to ship.

`deploy.sh` checks that Compose reports the project `proxiapay` before touching
anything (it stops otherwise: a wrong `STACK` would recreate another stack's
containers), pulls the images, brings up `db migrate api worker console backup`,
seals the credentials of `provider-credentials.env`, and waits for
`https://pay.proxia-digital.com/healthz` to answer 200. It keeps the two newest
version tags of each image on the VPS, for a rollback.

If a deploy fails after the images were built, fix the cause and re-run the
failed deploy job (the images are already there), or roll back as below.

## Rolling back

Actions, `release`, **Run workflow**, with the input `tag` set to the version to
return to (e.g. `v1.0.0`). The same gate applies (the tag must be on `main`), the
four images for that tag must exist in GHCR, and the deploy needs the same
approval. Nothing is verified or built again.

**Migrations are forward-only.** A rollback puts the old images back; it does not
undo the schema changes the newer release applied, and the old code then runs
against the newer schema. That is safe only when the newer migrations were
additive (a new table, a new column the old code ignores). Before rolling back
across a migration, read it. If the old code cannot work with the new schema, the
way back is a restore (below), not a rollback.

## Backups and restore

### What is kept

- **Where**: Cloudflare R2, bucket `pay-db-backups`, prefix `proxiapay`
  (`WALG_S3_PREFIX`), through WAL-G's S3 client.
- **How**: `db` archives every WAL segment (`ops/db/archive.sh`) and closes one at
  least every 60 s, so a restore reaches to within about a minute of any moment.
  `backup` takes a base backup daily and prunes (`ops/backup/run.sh`). Everything
  is **encrypted client-side with libsodium** (`WALG_LIBSODIUM_KEY`) before
  upload: R2 never holds the ledger in clear, and both scripts refuse to run
  without the key.
- **How long**: the prune keeps every backup of the last **36 days**
  (`BACKUP_RETAIN_DAYS`, default 36) and at least the last 35 full backups
  (`BACKUP_RETAIN_FULL`), whichever keeps more. It is 36, not 35, because the
  cutoff keeps backups finished after now minus N days, so the oldest restorable
  point lies between N-1 and N days back: 36 guarantees a full 35.

### Checking them

```sh
dc logs --since 24h backup | grep -E 'BACKUP FAILED|base backup pushed|pruned'
dc exec backup run.sh wal-g backup-list   # base backups, newest last
dc exec backup run.sh wal-g wal-verify integrity timeline
```

`run.sh` runs the rest of its command line, after exporting the `PG*` variables WAL-G needs to reach `db` (a bare `wal-g wal-verify` would lack them).

A failed backup is reported as `BACKUP FAILED: …` in the log and retried hourly.
A base backup that cannot finish (archiving broken) times out after
`BACKUP_PUSH_TIMEOUT` instead of hanging. Look in `dc logs db` for a failing
`archive command`: Postgres keeps a segment it cannot ship and retries it, so a
broken archive fills the disk before it loses data.

### Rehearsing the restore

`ops/backup/rehearse.sh` rehearses a point-in-time restore end to end on a
workstation with Docker, against MinIO standing in for R2: it writes rows under
load, takes a base backup, restores a scratch database to a chosen instant, and
checks that every row committed before it is present and none after. It also
checks that the bucket never holds a row in clear, that a wrong key reads nothing,
and the retention and timeout behaviour.

```sh
bash ops/backup/rehearse.sh
```

**It is the pre-go-live restore rehearsal**: run it on the release candidate
before the first real transaction. It reads no `.env` file and removes everything
it created. It proves the mechanism; the go-live gate asks for the same
procedure on production's own backups.

### Restoring

Two rules. **Never start a restored server with archiving on against the live
prefix**: it would write its own history into the bucket the live one is using.
Start it with archiving **off** (the stock `postgres` command, as below, has none)
or give it a different `WALG_S3_PREFIX`. And **recover the keys with the
database**: a database restored without `MASTER_KEY_BASE64` and `INDEX_KEY_BASE64`
holds records nobody can read.

For a rehearsal on production's backups, or the first step of a real recovery,
restore into a scratch volume, on the VPS or any machine holding the owner file
and the db image. Set `TARGET` (UTC, within the retention window), or drop the
two `recovery_target` lines to replay everything archived.

```sh
cd ~/proxiapay
IMAGE=ghcr.io/iamvaln/proxiapay-db:v1.0.0        # the deployed tag
docker volume create restore-scratch
docker run --rm -i --user postgres --env-file .env.production.owner \
  -e TARGET='2026-11-20 14:30:00+00' -v restore-scratch:/var/lib/postgresql/data \
  --entrypoint sh "$IMAGE" -s <<'SH'
set -eu
wal-g backup-fetch "$PGDATA" LATEST      # or a name from `wal-g backup-list`
touch "$PGDATA/recovery.signal"
cat >>"$PGDATA/postgresql.auto.conf" <<CONF
restore_command = 'wal-g wal-fetch %f %p'
recovery_target_time = '$TARGET'
recovery_target_action = 'promote'
CONF
SH

# Archiving OFF: no archive_mode, no archive_command. No published port.
docker run -d --name restore-pg --env-file .env.production.owner \
  -v restore-scratch:/var/lib/postgresql/data "$IMAGE" postgres
docker exec restore-pg psql -U proxiapay -d proxiapay -Atc 'select pg_is_in_recovery()'   # f once promoted
```

Then verify, before anything serves from it:

- the row counts and the latest `ledger_entry` are what you expect for `TARGET`;
- **`LedgerService.verifyCheckpoints` reports nothing.** It recomputes every
  account's balance from its postings and compares it with the stored checkpoint.
  Every reconciliation run performs it and raises a `checkpoint_mismatch`
  discrepancy for any difference, so run a reconciliation (console,
  Reconciliation) on a stack started against the restored database, and read the
  run's result;
- balances match the figures taken before (or the provider dashboards).

Throw a rehearsal away with `docker rm -f restore-pg && docker volume rm restore-scratch`.

**A real recovery** continues from there: stop `api`, `worker` and `backup`; keep
the damaged volume aside (do not delete it); restore into the stack's volume the
same way; start `db` with archiving off; verify as above; then give the new
history a **new `WALG_S3_PREFIX`** (e.g. `s3://pay-db-backups/proxiapay-2`) in the
owner file, recreate `db` with the production override, and let `backup` take its
base backup before serving. The old prefix stays untouched as history. Before the
platform resumes serving, run reconciliation against every provider account over
the interval lost (`docs/operations.md`).

## Migration 0002 and the index lock

`0002_list_indexes.sql`, which arrives with `develop`, creates its indexes with
plain `CREATE INDEX`, which blocks writes to the table while each is built. On a
fresh production database that costs nothing. Remember it for the day a similar
migration meets a live ledger: such indexes should be built `CONCURRENTLY`
(outside the migration's transaction) instead.

## Activating a new country

Production opens with Cameroon only. The seed inserts the whole catalogue and
leaves every other country inactive: the resolver refuses a route there with
`COUNTRY_DISABLED`.

In the console, **Configuration, Countries**: **Activate…** on the country. The
dialog says how many routes and projects it affects and how many transactions are
in flight; **Confirm** applies it. It needs the `reference.manage` permission. A
country is useful only once a provider account is bound for it and its routes are
active, which Configuration, Routes shows (a "country off" tag marks routes the
country still holds back). Re-running the seed never switches it off again.

## The documented deviation: keys in env files

`docs/operations.md` says `MASTER_KEY_BASE64` and `INDEX_KEY_BASE64` belong in a
key store, injected at process start, and backed up with the database. This VPS
has no key store, and Valentine decided against a secrets manager, following the
other stacks on it. So in production the keys live in `.env.production` (and the
backup key in `.env.production.owner`), mode 600, owned by the deploy user. The
sandbox makes the same choice for simulator data; production does it for real
data, which is why it is written down and gated:

- the files are on the VPS only, never committed, never printed (the deploy
  prints Compose's project name only, never `config`);
- the api and worker see the platform keys but not the owner file; only `db`,
  `migrate` and `backup` see the backup key and R2's;
- **the keys are not recoverable from anywhere else.** A VPS lost with its disk
  takes the files with it, and a restored database is unreadable without them.
  Hence the first go-live gate.

## Go-live gates

All four are in `docs/going-live-checklist.md`, "Platform", and all must be true
before the first real transaction.

1. **An offline copy of `MASTER_KEY_BASE64`, `INDEX_KEY_BASE64` and
   `WALG_LIBSODIUM_KEY` exists**, apart from the VPS and from R2.
2. **A restore rehearsal passed** on production's own backups, with
   `verifyCheckpoints` clean and balances matching.
3. **The `production` environment requires approval** in the GitHub settings,
   limited to `main` and `v*`.
4. **Ejara's balances in the console match the Ejara dashboard.**

## Checking it

```sh
curl -fsS https://pay.proxia-digital.com/healthz
dc ps                                   # db healthy; migrate exited (0); api, worker, backup up
dc logs --tail 20 api                   # "api listening", environment production
dc logs migrate | tail -3               # "granted proxiapay_app; revoked …"
```
