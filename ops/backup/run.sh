#!/usr/bin/env bash
# The backup service. WAL is shipped by the db container itself (archive.sh,
# a segment at least every minute); this takes the daily base backup the WAL is
# replayed onto, then prunes.
#
#   run.sh [loop]     the service: one base backup per day, at BACKUP_SCHEDULE_HOUR_UTC
#   run.sh scheduled  what the loop runs at the hour and on each retry: a base
#                     backup unless this day's slot already has one, then the prune
#   run.sh once       a base backup and the prune, unconditionally (by hand)
#   run.sh CMD...     anything else, e.g. `wal-g backup-list`
#
# BACKUP_PUSH_TIMEOUT (seconds, default 6 h) bounds a base backup;
# BACKUP_RETAIN_FULL (default 35) is the count kept on top of the last 35 days.
#
# The base backup reads the db volume, mounted read-only at the path the server
# reports as its data_directory, between the pg_backup_start and pg_backup_stop
# WAL-G issues over the stack network. Nothing here can write into PGDATA.
set -uo pipefail

PGDATA_DIR=/var/lib/postgresql/data
HOUR=${BACKUP_SCHEDULE_HOUR_UTC:-2}
RETAIN_FULL=${BACKUP_RETAIN_FULL:-35}
RETAIN_DAYS=35
RETRY_SECONDS=3600
PUSH_TIMEOUT=${BACKUP_PUSH_TIMEOUT:-21600}

# The owner file names the owner the way the postgres image wants it.
export PGHOST=${PGHOST:-db} PGPORT=${PGPORT:-5432}
export PGUSER=${PGUSER:-${POSTGRES_USER:-postgres}}
export PGPASSWORD=${PGPASSWORD:-${POSTGRES_PASSWORD:-}}
export PGDATABASE=${PGDATABASE:-${POSTGRES_DB:-$PGUSER}}

REASON=
log() { printf '%s [backup] %s\n' "$(date -u +%FT%TZ)" "$*"; }
failed() { log "BACKUP FAILED: $*" >&2; return 1; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# A command with its output in the log; on failure REASON holds its last error line.
logged() {
  local out status
  out=$(mktemp)
  "$@" 2>&1 | tee "$out"
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

# pg_backup_stop() waits until the backup's last WAL segment is archived, for
# ever if archiving is broken; the timeout turns that into a BACKUP FAILED and a
# retry. Its connection closing aborts the backup on the server.
push() {
  local start=$SECONDS
  wait_for_db || { failed "db at $PGHOST:$PGPORT is not accepting connections"; return 1; }
  if ! logged timeout -k 60 "$PUSH_TIMEOUT" wal-g backup-push "$PGDATA_DIR"; then
    if ((SECONDS - start >= PUSH_TIMEOUT)); then
      failed "base backup timed out after ${PUSH_TIMEOUT}s (is WAL archiving failing? see db's log)"
    else
      failed "backup-push: $REASON"
    fi
    return 1
  fi
  log "base backup pushed"
}

# Keeps the last RETAIN_FULL full backups AND every backup of the last 35 days
# (WAL-G keeps the union), so neither extra backups (a manual `once`, retries)
# nor a lowered count can shorten the 35-day window.
prune() {
  local after
  after=$(iso $(($(date -u +%s) - RETAIN_DAYS * 86400)))
  logged wal-g delete retain FULL "$RETAIN_FULL" --after "$after" --confirm || { failed "prune: $REASON"; return 1; }
  log "pruned: kept the last $RETAIN_FULL full backups and every backup since $after"
}

# The start of this day's slot: the latest BACKUP_SCHEDULE_HOUR_UTC:00 not after now.
slot_start() {
  local now
  now=$(date -u +%s)
  echo $((now - (now - 10#$HOUR * 3600) % 86400))
}

# 0 when a base backup finished since the slot began, 1 when none did, 2 when it cannot tell.
pushed_this_slot() {
  local out last
  out=$(wal-g backup-list --json 2>&1) || { REASON=$(tail -n1 <<<"$out"); return 2; }
  last=$(grep -o '"time": *"[0-9T:-]*' <<<"$out" | grep -o '[0-9]\{4\}-[0-9T:-]*' | cut -c1-19 | sort | tail -n1)
  [[ -n $last && ! $last < $(iso "$(slot_start)" | cut -c1-19) ]]
}

scheduled() {
  configured || return 1
  pushed_this_slot
  case $? in
    0) log "this slot's base backup is already pushed: pruning only" ;;
    1) push || return 1 ;;
    *) failed "cannot list the bucket: $REASON"; return 1 ;;
  esac
  prune
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
  [[ $PUSH_TIMEOUT =~ ^[1-9][0-9]*$ ]] || { failed "BACKUP_PUSH_TIMEOUT='$PUSH_TIMEOUT' is not a number of seconds"; exit 1; }
  log "daily base backup at $(printf '%02d' "$((10#$HOUR))"):00 UTC to ${WALG_S3_PREFIX:-?}"
  # At start, the current slot is caught up: a fresh database gets its first
  # base backup at once (archived WAL is useless without one), and a restart
  # after this day's backup only prunes, so deploys never add backups.
  local retry=0 wait
  scheduled || retry=1
  while :; do
    if ((retry)); then wait=$RETRY_SECONDS; else wait=$(seconds_until_hour); fi
    log "next base backup in ${wait}s"
    sleep "$wait"
    if scheduled; then retry=0; else retry=1; fi
  done
}

case ${1:-loop} in
  loop) loop ;;
  scheduled) scheduled ;;
  once) configured && push && prune ;;
  *) exec "$@" ;;
esac
