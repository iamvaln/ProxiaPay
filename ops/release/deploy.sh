#!/usr/bin/env bash
# The body of the production deploy, run on the VPS by release.yml over SSH.
#
# Inputs (environment): IMAGE_TAG (a v* tag), GHCR_USER, GHCR_TOKEN, and optionally
# APP_DIR (default $HOME/proxiapay) and APP_DOMAIN (default: read from .env.production).
# HEALTH_TIMEOUT / HEALTH_INTERVAL / PULL_RETRY_DELAY exist for the tests.
set -euo pipefail

cd "${APP_DIR:-$HOME/proxiapay}"
export IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required}"
REGISTRY=${REGISTRY:-ghcr.io/iamvaln}
export REGISTRY

dc() { docker compose --env-file .env.production -f docker-compose.deploy.yml -f docker-compose.production.yml "$@"; }

# Docker credentials in a private directory: the sandbox deploy shares this VPS user, and its
# ~/.docker/config.json must neither receive this run's token nor lose its own on logout.
DOCKER_CONFIG=$(mktemp -d)
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
# Keep the user's compose plugin visible if it lives under ~/.docker.
[ -d "$HOME/.docker/cli-plugins" ] && ln -s "$HOME/.docker/cli-plugins" "$DOCKER_CONFIG/cli-plugins"
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

# Authenticated fetch: GitHub rate-limits anonymous git by IP, and this VPS is shared with other
# projects. The header travels in git's environment, not its argv, so it is not in `ps`.
# Be clear about what remains: ssh-action prepends `export GHCR_TOKEN=...` to the remote shell's
# command line, so the token is visible to that VPS's users for the length of the run. The
# mitigation is least privilege: the deploy job's GITHUB_TOKEN is contents:read, packages:read,
# and it expires with the run.
AUTH=$(printf 'x-access-token:%s' "$GHCR_TOKEN" | base64 | tr -d '\n')
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \
  GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $AUTH" git fetch --tags origin
unset AUTH

# A hand-edited tracked file would be silently carried into the release or block the checkout
# half way. Untracked files (.env.production, provider-credentials.env) are expected.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "STOP: tracked files are modified in $PWD; refusing to deploy over local edits."
  exit 1
fi
git checkout --detach "refs/tags/$IMAGE_TAG" # compose files and scripts follow the released tag

# ── The guard ────────────────────────────────────────────────────────────────
# Ask Compose which project it believes it is BEFORE touching anything. Only the name is
# extracted: `config` expands env_file values (R2 keys, the libsodium key, DB passwords), so its
# output must never reach a log. If STACK were set wrongly, this deploy would recreate another
# stack's containers (what took lehno's production down on 14 September).
PROJECT=$(dc config --format json | sed -n 's/^  "name": *"\([^"]*\)".*/\1/p')
if [ "$PROJECT" != "proxiapay" ]; then
  echo "STOP: Compose reports the project '$PROJECT', not 'proxiapay'."
  echo "Going on would deploy onto another stack. Check STACK in .env.production."
  exit 1
fi
echo "Compose project confirmed: $PROJECT"

# Retried: containerd's overlayfs snapshotter sometimes fails a cold layer extraction.
SERVICES=(db migrate api worker console backup)
n=0
until dc pull db api worker console backup; do
  n=$((n+1))
  if [ "$n" -ge 3 ]; then echo "pull failed after $n attempts"; exit 1; fi
  echo "pull interrupted, retrying…"
  sleep "${PULL_RETRY_DELAY:-10}"
done

# --no-build: every image comes from GHCR. A missing one must fail the deploy, not compile
# WAL-G on the production VPS. migrate shares the api image, already pulled.
dc up -d --no-build "${SERVICES[@]}"

# Provider credentials from their own file, parsed by the CLI and never handed to Compose as an
# env file (which would interpolate a `$` in a secret). Only changed ones are re-sealed.
if [ -f provider-credentials.env ]; then
  dc run --rm -T -v "$PWD/provider-credentials.env:/run/provider-credentials.env:ro" \
    migrate node dist/cli/set-credentials.js /run/provider-credentials.env
fi

# ── Wait for the platform to answer ──────────────────────────────────────────
if [ -z "${APP_DOMAIN:-}" ]; then
  APP_DOMAIN=$(grep -m1 '^APP_DOMAIN=' .env.production | cut -d= -f2- | tr -d "\"'" || true)
  [ -n "$APP_DOMAIN" ] || { echo "STOP: no APP_DOMAIN in .env.production; cannot check /healthz."; exit 1; }
fi
# The body must say {"status":"ok"}: that is the api's answer. A bare 200 proves nothing, because
# the console answers every unrouted path with index.html and 200, a crash-looping api included.
timeout=${HEALTH_TIMEOUT:-120}; interval=${HEALTH_INTERVAL:-5}; waited=0
while :; do
  curl -fs --max-time 10 "https://${APP_DOMAIN}/healthz" 2>/dev/null | grep -q '"status":"ok"' && break
  if [ "$waited" -ge "$timeout" ]; then
    echo "https://${APP_DOMAIN}/healthz has not answered {\"status\":\"ok\"} after ${timeout}s"
    exit 1
  fi
  sleep "$interval"; waited=$((waited+interval))
done
echo "$IMAGE_TAG is live: https://${APP_DOMAIN}/healthz answers status ok"

# worker and backup serve nothing /healthz could see; a crash loop shows only in their state.
for svc in worker backup; do
  state=$(dc ps --format '{{.State}}' "$svc" | head -1)
  if [ "$state" != running ]; then
    echo "STOP: $svc is '${state:-absent}', not running, though the api answers."
    exit 1
  fi
done

# ── Prune ────────────────────────────────────────────────────────────────────
# `image prune` only removes dangling layers, never old tags. Keep the 2 newest version tags of
# each image (current + previous, for a rollback) and the deployed one; :latest is untouched, and
# an image in use refuses to be removed.
for image in proxiapay-api proxiapay-console proxiapay-db proxiapay-backup; do
  # `|| true`: an image with no version tag yet makes grep exit 1, which must not fail a live deploy.
  { docker images "$REGISTRY/$image" --format '{{.Tag}}' | grep -E '^v[0-9]' | sort -V \
    | awk -v keep="$IMAGE_TAG" '{ t[NR]=$0 } END { for (i=1; i<=NR-2; i++) if (t[i] != keep) print t[i] }' \
    | while read -r tag; do docker rmi "$REGISTRY/$image:$tag" 2>/dev/null || true; done; } || true
done
docker image prune -f
