#!/bin/sh
# Postgres's archive_command: ship one WAL segment to the bucket through WAL-G,
# encrypted before it leaves the container.
#
# Postgres keeps a segment in pg_wal and retries it until this exits 0, so a
# refusal costs disk and a loud log line, never data. Uploading in clear, which
# WAL-G does without a key, is the one outcome refused outright.
set -eu
: "${WALG_LIBSODIUM_KEY:?archive refused: WALG_LIBSODIUM_KEY is not set, the segment would leave unencrypted}"
: "${WALG_S3_PREFIX:?archive refused: WALG_S3_PREFIX is not set}"
exec wal-g wal-push "$1"
