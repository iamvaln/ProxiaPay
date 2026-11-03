#!/usr/bin/env bash
# Rehearse a point-in-time restore end to end, on this machine, against MinIO:
#
#   bash ops/backup/rehearse.sh
#
# It runs the production files themselves (docker-compose.deploy.yml +
# docker-compose.production.yml, the ops/db and ops/backup images) under a
# Compose project of its own, `proxiapay-rehearsal`, with its own volumes and
# no published port, and removes all of it on exit. KEEP=1 leaves it standing.
# It reads no .env file: everything it needs is generated in a temp directory.
#
#   1. start db + MinIO;              5. note T, write more;
#   2. write rows;                    6. restore a scratch database to T;
#   3. base backup (the service),     7. every row committed before T present,
#      under a steady stream of          none after it.
#      inserts;
#   4. write more rows;
#
# Plus: the bucket never holds a row in clear, a wrong key reads nothing back,
# both scripts refuse to run without a key, an archived segment cannot be
# overwritten with other content, a slot's retry and a restart never push a
# second base backup, pruning keeps every backup of the retention window (36 days) whatever
# the count, and a base backup that cannot finish (archiving broken) times out
# with BACKUP FAILED instead of hanging.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PROJECT=proxiapay-rehearsal
WORK=$(mktemp -d)
PG_USER=proxiapay
PG_DB=proxiapay
CANARY="canary-$(openssl rand -hex 12)"

say() { printf '[rehearsal] %s\n' "$*"; }
fail() { printf '[rehearsal] REHEARSAL FAILED: %s\n' "$*" >&2; exit 1; }

dc() {
  docker compose -p "$PROJECT" --env-file "$WORK/compose.env" \
    -f "$ROOT/docker-compose.deploy.yml" \
    -f "$ROOT/docker-compose.production.yml" \
    -f "$ROOT/ops/backup/rehearsal.compose.yml" "$@"
}

cleanup() {
  if [[ ${KEEP:-} == 1 ]]; then
    say "KEEP=1: left standing; remove with: docker compose -p $PROJECT down -v (env in $WORK)"
    return
  fi
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# psql inside a service, over its local socket.
sql() { dc exec -T "$1" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -Atq -c "$2"; }

wait_until() { # seconds, description, command...
  local deadline=$((SECONDS + $1)) what=$2
  shift 2
  until "$@"; do
    ((SECONDS < deadline)) || fail "timed out waiting for $what"
    sleep 1
  done
}

# ── The environment: the shared and the owner file are one file here ─────────
minio_password=$(openssl rand -hex 16)
cat >"$WORK/owner.env" <<EOF
POSTGRES_USER=$PG_USER
POSTGRES_PASSWORD=$(openssl rand -hex 16)
POSTGRES_DB=$PG_DB
WALG_S3_PREFIX=s3://pay-db-backups/proxiapay
AWS_ENDPOINT=http://minio:9000
AWS_REGION=auto
AWS_S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=rehearsal
AWS_SECRET_ACCESS_KEY=$minio_password
WALG_LIBSODIUM_KEY=$(openssl rand -base64 32)
BACKUP_SCHEDULE_HOUR_UTC=2
BACKUP_RETAIN_FULL=1
EOF
cat >"$WORK/compose.env" <<EOF
STACK=$PROJECT
REGISTRY=$PROJECT
IMAGE_TAG=rehearsal
ENV_FILE=$WORK/owner.env
OWNER_ENV_FILE=$WORK/owner.env
APP_DOMAIN=rehearsal.invalid
DATABASE_URL=
APP_DATABASE_URL=
MINIO_ROOT_USER=rehearsal
MINIO_ROOT_PASSWORD=$minio_password
EOF
chmod 600 "$WORK/owner.env" "$WORK/compose.env"

# The same guard as the deploy: never act on a project that is not ours.
name=$(dc config --format json | sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -n1)
[[ $name == "$PROJECT" ]] || fail "compose resolves project '$name', expected $PROJECT"
dc down -v --remove-orphans >/dev/null 2>&1 || true

say "building the db and backup images"
dc build db backup

# ── 1. db + MinIO ─────────────────────────────────────────────────────────────
say "1. starting db and MinIO"
# MinIO, and its bucket, before db: the first-boot server archives as it shuts
# down, and an archive_command waiting on an absent endpoint holds that shutdown.
dc up -d --wait minio
bucket() { dc exec -T minio test -d /bitnami/minio/data/pay-db-backups; }
wait_until 60 "the bucket" bucket
dc up -d --wait db
# Healthy can mean the entrypoint's socket-only first-boot server; TCP is the real one.
db_listening() { dc exec -T db pg_isready -q -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB"; }
wait_until 60 "db to listen on the network" db_listening

# ── 2. rows before the base backup ────────────────────────────────────────────
say "2. writing rows"
# Ballast, so the base backup takes long enough to overlap the writer below.
sql db "create table ballast as select g, repeat(md5(g::text), 8) as filler from generate_series(1, 300000) g"
sql db "create table rehearsal (id serial primary key, phase text not null, note text not null,
        at timestamptz not null default clock_timestamp())"
sql db "insert into rehearsal (phase, note) select 'before-backup', '$CANARY' from generate_series(1, 100)"

# ── 3. the base backup, taken by the backup service itself ────────────────────
# On an empty bucket the service takes one at start, then waits for its hour.
# A writer committing a row every few milliseconds, from before the backup
# starts until after it is pushed: the restore must hold every one of them.
dc exec -T db sh -c 'cat >/tmp/writer.sh' <<'SH'
while [ ! -e /tmp/stop-writer ]; do
  echo "insert into rehearsal (phase, note) values ('under-load', '$CANARY');"
  sleep 0.005
done | psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
touch /tmp/writer-done
SH
dc exec -d -e CANARY="$CANARY" db sh /tmp/writer.sh
writing() { (($(sql db "select count(*) from rehearsal where phase = 'under-load'") > 0)); }
wait_until 30 "the writer to commit" writing
say "3. starting the backup service, under load"
dc up -d --no-deps backup
backup_pushed() {
  local logs
  logs=$(dc logs --no-log-prefix backup 2>&1)
  if grep -q 'BACKUP FAILED' <<<"$logs"; then printf '%s\n' "$logs" >&2; fail "the backup service failed"; fi
  grep -q 'base backup pushed' <<<"$logs"
}
wait_until 300 "the first base backup" backup_pushed
dc exec -T db touch /tmp/stop-writer
writer_done() { dc exec -T db test -e /tmp/writer-done; }
wait_until 30 "the writer to stop" writer_done
under_load=$(sql db "select count(*) from rehearsal where phase = 'under-load'")
dc logs --no-log-prefix backup | grep -E 'base backup pushed|pruned|next base backup' | sed 's/^/[backup] /'
# Not just around it: rows were committed between the backup's start and finish.
detail=$(dc exec -T backup wal-g backup-list --detail --json 2>/dev/null)
started=$(grep -o '"start_time": *"[^"]*"' <<<"$detail" | head -n1 | cut -d'"' -f4)
finished=$(grep -o '"finish_time": *"[^"]*"' <<<"$detail" | head -n1 | cut -d'"' -f4)
during=$(sql db "select count(*) from rehearsal where phase = 'under-load' and at between '$started' and '$finished'")
((during > 0)) || fail "no row was committed while the base backup ran ($started to $finished)"
say "   $under_load rows committed by the writer, $during of them while the base backup ran"
# A restart (every deploy) finds that backup and waits for the hour instead.
dc restart backup >/dev/null 2>&1
rescheduled() { (($(dc logs --no-log-prefix backup 2>&1 | grep -c 'next base backup in') >= 2)); }
wait_until 60 "the restarted backup service to reschedule" rescheduled
pushes=$(dc logs --no-log-prefix backup 2>&1 | grep -c 'base backup pushed')
[[ $pushes == 1 ]] || fail "a restart took another base backup ($pushes in all)"
say "   a restart finds it and waits for the hour"
# What the loop runs at the hour and on every retry: in the slot that already
# has its base backup (a push that succeeded, then a prune that failed), it
# only prunes.
out=$(dc exec -T backup run.sh scheduled 2>&1) || { printf '%s\n' "$out" >&2; fail "a scheduled retry failed"; }
grep -q 'pruning only' <<<"$out" || { printf '%s\n' "$out" >&2; fail "a scheduled retry did not say it prunes only"; }
! grep -q 'base backup pushed' <<<"$out" || fail "a scheduled retry pushed a second base backup in the slot"
say "   a retry in the same slot prunes only"

# ── 4. rows after the backup ──────────────────────────────────────────────────
say "4. writing more rows"
sql db "insert into rehearsal (phase, note) select 'after-backup', '$CANARY' from generate_series(1, 50)"

# ── 5. T, then rows after it ──────────────────────────────────────────────────
sleep 1
T=$(sql db "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
sleep 1
say "5. T = $T; writing rows after it"
sql db "insert into rehearsal (phase, note) select 'after-T', '$CANARY' from generate_series(1, 30)"
# Every row but the last 30 was committed before T (the writer had stopped).
fingerprint="select count(*) || ' ' || md5(coalesce(string_agg(id::text, ',' order by id), ''))
             from rehearsal where phase <> 'after-T'"
source_rows=$(sql db "$fingerprint")
before_t=${source_rows%% *}
after_t=$(sql db "select count(*) from rehearsal where phase = 'after-T'")
late=$(sql db "select count(*) from rehearsal where (phase <> 'after-T') <> (at < '$T')")
[[ $before_t == $((150 + under_load)) && $after_t == 30 && $late == 0 ]] ||
  fail "source rows: $before_t before T, $after_t after, $late on the wrong side of T"

# Close the segment instead of waiting out archive_timeout, and wait for it.
segment=$(sql db "select pg_walfile_name(pg_switch_wal())")
archived() {
  local last
  last=$(sql db "select coalesce(last_archived_wal, '') from pg_stat_archiver")
  [[ $last == "$segment" || $last > "$segment" ]]
}
wait_until 120 "segment $segment to be archived" archived
say "   segment $segment archived"

# An archived segment is never replaced by other content (a stray server, a
# restored one archiving into the live prefix); the same content is accepted.
# (Were it overwritten, the restore below would break; the run stops here first.)
if out=$(dc exec -T db sh -c "head -c 16777216 /dev/urandom >/tmp/$segment && /usr/local/bin/archive.sh /tmp/$segment" 2>&1); then
  fail "archive.sh overwrote the archived segment $segment with other content"
fi
grep -q 'contents differ' <<<"$out" || { printf '%s\n' "$out" >&2; fail "the overwrite was refused for another reason"; }
dc exec -T -w /var/lib/postgresql/data db /usr/local/bin/archive.sh "pg_wal/$segment" >/dev/null 2>&1 ||
  fail "archive.sh refused to re-archive $segment with its own content"
say "   an archived segment cannot be overwritten with other content"

# ── encryption ────────────────────────────────────────────────────────────────
# The canary is in clear in pg_wal, so the search below would find it in a bucket
# that held the same segments unencrypted.
dc exec -T db grep -rlq "$CANARY" /var/lib/postgresql/data/pg_wal || fail "the canary is not in pg_wal"
objects=$(dc exec -T minio find /bitnami/minio/data/pay-db-backups -type f | wc -l | tr -d ' ')
((objects > 0)) || fail "the bucket is empty"
if dc exec -T minio grep -rlq "$CANARY" /bitnami/minio/data/pay-db-backups; then
  fail "a row was found in clear in the bucket"
fi
say "   $objects objects in the bucket, none holding a row in clear"
fetch_segment() { dc run --rm --no-deps "$@" --entrypoint wal-g backup wal-fetch "$segment" /tmp/segment >/dev/null 2>&1; }
fetch_segment || fail "the right key could not read segment $segment back"
if fetch_segment -e WALG_LIBSODIUM_KEY="$(openssl rand -base64 32)"; then
  fail "a wrong key read segment $segment back"
fi
say "   the right key reads a segment back, a wrong one does not"
if out=$(dc run --rm --no-deps -e WALG_LIBSODIUM_KEY= backup once 2>&1); then
  fail "the backup ran without a key"
fi
grep -q 'BACKUP FAILED: ' <<<"$out" || fail "a keyless backup did not say BACKUP FAILED: $out"
if dc exec -T -e WALG_LIBSODIUM_KEY= db /usr/local/bin/archive.sh "pg_wal/$segment" >/dev/null 2>&1; then
  fail "archive.sh ran without a key"
fi
say "   without a key, both run.sh and archive.sh refuse"

# ── 6. restore a scratch database to T ────────────────────────────────────────
say "6. restoring a scratch database to T"
# The restore procedure itself: fetch the base backup, then let Postgres replay
# archived WAL up to T and promote. The heredoc runs inside the container.
dc run --rm -T --no-deps --user postgres --entrypoint sh -e TARGET="$T" restore -s <<'SH'
set -eu
wal-g backup-fetch "$PGDATA" LATEST
touch "$PGDATA/recovery.signal"
cat >>"$PGDATA/postgresql.auto.conf" <<EOF
restore_command = 'wal-g wal-fetch %f %p'
recovery_target_time = '$TARGET'
recovery_target_action = 'promote'
EOF
SH
dc up -d --no-deps --wait restore
promoted() { [[ $(sql restore "select pg_is_in_recovery()") == f ]]; }
wait_until 120 "the restored server to finish recovery" promoted
dc logs --no-log-prefix restore 2>&1 | grep -E 'recovery stopping|selected new timeline' | sed 's/^/[restore] /' || true

# ── 7. every row committed before T present, none after ───────────────────────
restored_rows=$(sql restore "$fingerprint")
absent=$(sql restore "select count(*) from rehearsal where phase = 'after-T'")
[[ $restored_rows == "$source_rows" ]] || fail "rows before T: restored $restored_rows, source $source_rows"
[[ $absent == 0 ]] || fail "$absent rows written after T came back"
ballast=$(sql restore "select count(*) from ballast")
[[ $ballast == 300000 ]] || fail "ballast: $ballast of 300000 rows"
present=${restored_rows%% *}
say "7. the restored rows before T match the source's, id for id"

# ── retention: the 36-day window whatever the count ─────────────────────────────────────
# BACKUP_RETAIN_FULL=1 here: two more manual backups, and all three survive the
# prune, being younger than the window.
for _ in 1 2; do
  out=$(dc exec -T backup run.sh once 2>&1) || { printf '%s\n' "$out" >&2; fail "a manual backup failed"; }
done
backups=$(dc exec -T backup wal-g backup-list --json 2>/dev/null | grep -o '"backup_name"' | wc -l | tr -d ' ')
[[ $backups == 3 ]] || fail "after pruning to 1 full backup, $backups of 3 backups inside the window are left"
say "   pruning to 1 full backup still keeps all $backups backups of the retention window"

# ── a base backup that cannot finish times out ────────────────────────────────
# stuck-db's archiving always fails, so pg_backup_stop() never returns;
# BACKUP_PUSH_TIMEOUT is 20 s there.
dc up -d --no-deps --wait stuck-db >/dev/null 2>&1
dc run --rm --no-deps stuck-backup once >"$WORK/stuck.log" 2>&1 &
stuck=$!
deadline=$((SECONDS + 120))
while kill -0 "$stuck" 2>/dev/null && ((SECONDS < deadline)); do sleep 1; done
if kill -0 "$stuck" 2>/dev/null; then
  kill "$stuck" 2>/dev/null || true
  docker ps -q --filter "label=com.docker.compose.project=$PROJECT" \
    --filter label=com.docker.compose.service=stuck-backup | xargs docker rm -f >/dev/null 2>&1 || true
  fail "a base backup with archiving broken was still running after 120 s, with no BACKUP FAILED"
fi
if wait "$stuck"; then fail "a base backup with archiving broken succeeded"; fi
grep -q 'BACKUP FAILED: base backup timed out' "$WORK/stuck.log" ||
  { cat "$WORK/stuck.log" >&2; fail "the stuck base backup did not say it timed out"; }
say "   with archiving broken, the base backup times out: $(grep -o 'BACKUP FAILED: .*' "$WORK/stuck.log" | head -n1)"

say "REHEARSAL OK: restored to $T, $present rows before T present ($during committed while the base backup ran), $after_t rows after T absent"
