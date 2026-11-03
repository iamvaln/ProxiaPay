# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# The production backup service (ops/backup/run.sh): a daily WAL-G base backup
# of the db volume, mounted read-only, then pruning to the last 36 days (so 35 are always restorable).
#
# ── WAL-G, built from its pinned source ─────────────────────────────────────
# Built here rather than downloaded: the release binaries are glibc builds and
# do not start on Alpine (musl). This one is static, libsodium included, so it
# runs on any base. Keep this stage identical in ops/db/Dockerfile.
FROM golang:1.26.10-alpine3.23 AS walg
ARG WALG_VERSION=3.0.9
ARG WALG_SHA256=b06bc26c4865c07d0c269101910f63c7eedd03790b7c054a7da0980a7a9cc31d
RUN apk add --no-cache build-base libsodium-dev libsodium-static
WORKDIR /src
RUN wget -qO /tmp/wal-g.tar.gz "https://github.com/wal-g/wal-g/archive/refs/tags/v${WALG_VERSION}.tar.gz" \
 && echo "${WALG_SHA256}  /tmp/wal-g.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/wal-g.tar.gz --strip-components=1
# WAL-G's cgo flags look for libsodium under tmp/libsodium, where its own build
# script compiles one; Alpine's static library stands in for it.
RUN mkdir -p tmp/libsodium && ln -s /usr/include tmp/libsodium/include && ln -s /usr/lib tmp/libsodium/lib
# GOEXPERIMENT as WAL-G's own Makefile sets it: the code needs encoding/json/v2.
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    cd main/pg && GOEXPERIMENT=jsonv2 CGO_ENABLED=1 go build -trimpath -tags libsodium -o /wal-g \
      -ldflags "-s -w -linkmode external -extldflags -static -X github.com/wal-g/wal-g/cmd/pg.walgVersion=v${WALG_VERSION}" .
RUN /wal-g --version

# postgres:16-alpine for its `postgres` user, uid 70, the owner of the db's
# PGDATA (mode 0700), and for pg_isready. Its server is never started here.
FROM postgres:16-alpine
COPY --from=walg /wal-g /usr/local/bin/wal-g
COPY run.sh /usr/local/bin/run.sh
ENV WALG_LIBSODIUM_KEY_TRANSFORM=base64
RUN wal-g --version
USER postgres
ENTRYPOINT ["/usr/local/bin/run.sh"]
CMD ["loop"]
