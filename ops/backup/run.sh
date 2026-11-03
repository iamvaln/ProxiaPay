#!/usr/bin/env bash
# The backup service. WAL is shipped by the db container itself (archive.sh,
# a segment at least every minute); this takes the daily base backup the WAL is
# replayed onto, then prunes to the last 35 full backups.
#
#   run.sh [loop]   the service: a base backup every day at BACKUP_SCHEDULE_HOUR_UTC
#   run.sh once     one base backup and prune, exiting with its status
#   run.sh CMD...   anything else, e.g. `wal-g backup-list`
#
# The base backup reads the db volume, mounted read-only at the path the server
# reports as its data_directory, between the pg_backup_start and pg_backup_stop
# WAL-G issues over the stack network. Nothing here can write into PGDATA.
set -uo pipefail

PGDATA_DIR=/var/lib/postgresql/data
RETAIN_FULL=35
RETRY_SECONDS=3600
HOUR=${BACKUP_SCHEDULE_HOUR_UTC:-2}

# The owner file names the owner the way the postgres image wants it.
export PGHOST=${PGHOST:-db} PGPORT=${PGPORT:-5432}
export PGUSER=${PGUSER:-${POSTGRES_USER:-postgres}}
export PGPASSWORD=${PGPASSWORD:-${POSTGRES_PASSWORD:-}}
export PGDATABASE=${PGDATABASE:-${POSTGRES_DB:-$PGUSER}}

REASON=
log() { printf '%s [backup] %s\n' "$(date -u +%FT%TZ)" "$*"; }
failed() { log "BACKUP FAILED: $*" >&2; return 1; }

# WAL-G with its output in the log; on failure REASON holds its last error line.
walg() {
  local out status
  out=$(mktemp)
  wal-g "$@" 2>&1 | tee "$out"
  status=${PIPESTATUS[0]}
  if ((status != 0)); then
    REASON=$(grep 'ERROR' "$out" | tail -n1)
    REASON=${REASON:-$(tail -n1 "$out")}
    REASON=${REASON:-exit $status}
  fi
  rm -f "$out"
  return "$status"
}

# Without a key WAL-G uploads in clear: refuse instead.
configured() {
  local v
  for v in WALG_S3_PREFIX WALG_LIBSODIUM_KEY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    [[ -n ${!v:-} ]] || { failed "$v is not set"; return 1; }
  done
}

# On a first boot the image's entrypoint runs a socket-only server, then restarts:
# the healthcheck can pass before db listens on the network.
wait_for_db() {
  local tries=60
  until pg_isready -q -t 2; do
    ((--tries > 0)) || return 1
    sleep 1
  done
}

backup_once() {
  configured || return 1
  wait_for_db || { failed "db at $PGHOST:$PGPORT is not accepting connections"; return 1; }
  walg backup-push "$PGDATA_DIR" || { failed "backup-push: $REASON"; return 1; }
  log "base backup pushed"
  walg delete retain FULL "$RETAIN_FULL" --confirm || { failed "prune: $REASON"; return 1; }
  log "pruned to the last $RETAIN_FULL full backups"
}

# 0 when the bucket holds a base backup, 1 when it holds none, 2 when it cannot tell.
has_backup() {
  local out
  configured || return 2
  out=$(wal-g backup-list --json 2>&1) || { REASON=$(tail -n1 <<<"$out"); return 2; }
  grep -q '"backup_name"' <<<"$out" || return 1
}

seconds_until_hour() {
  local now next
  now=$(date -u +%s)
  next=$((now - now % 86400 + 10#$HOUR * 3600))
  ((next > now)) || next=$((next + 86400))
  echo $((next - now))
}

loop() {
  [[ $HOUR =~ ^([01]?[0-9]|2[0-3])$ ]] || { failed "BACKUP_SCHEDULE_HOUR_UTC='$HOUR' is not an hour from 0 to 23"; exit 1; }
  log "daily base backup at $(printf '%02d' "$((10#$HOUR))"):00 UTC to $WALG_S3_PREFIX, keeping $RETAIN_FULL"
  # Archived WAL is useless until a base backup exists to replay it onto, and a
  # fresh database would otherwise wait for the hour without one. Only an empty
  # bucket triggers this: a backup on every restart would shorten the retention.
  local retry=0 wait
  has_backup
  case $? in
    1) log "no base backup in the bucket yet: taking one now"; backup_once || retry=1 ;;
    2) failed "cannot list the bucket: $REASON"; retry=1 ;;
  esac
  while :; do
    if ((retry)); then wait=$RETRY_SECONDS; else wait=$(seconds_until_hour); fi
    log "next base backup in ${wait}s"
    sleep "$wait"
    if backup_once; then retry=0; else retry=1; fi
  done
}

case ${1:-loop} in
  loop) loop ;;
  once) backup_once ;;
  *) exec "$@" ;;
esac
