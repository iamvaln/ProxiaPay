# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# Production PostgreSQL: the stock postgres:16-alpine plus WAL-G, which
# archive.sh calls for every WAL segment (docker-compose.production.yml).
#
# ── WAL-G, built from its pinned source ─────────────────────────────────────
# Built here rather than downloaded: the release binaries are glibc builds and
# do not start on Alpine (musl). This one is static, libsodium included, so it
# runs on any base. Keep this stage identical in ops/backup/Dockerfile.
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

FROM postgres:16.15-alpine
COPY --from=walg /wal-g /usr/local/bin/wal-g
COPY archive.sh /usr/local/bin/archive.sh
# The key in WALG_LIBSODIUM_KEY is base64 (openssl rand -base64 32).
ENV WALG_LIBSODIUM_KEY_TRANSFORM=base64
RUN wal-g --version
