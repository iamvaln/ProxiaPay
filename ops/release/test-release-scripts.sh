#!/usr/bin/env bash
# Tests for check-tag-on-main.sh and deploy.sh against a throwaway git repo and
# a fake docker/curl. Nothing here touches the network, a real Docker daemon or
# any .env file. Run: bash ops/release/test-release-scripts.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
CANARY='SECRET-CANARY-do-not-print'

ok()   { PASS=$((PASS+1)); echo "ok   - $1"; }
nok()  { FAIL=$((FAIL+1)); echo "FAIL - $1${2:+ ($2)}"; }
test_case() { CURRENT=$1; shift; "$@"; }
assert() { if eval "$1"; then ok "$CURRENT"; else nok "$CURRENT" "${2:-$1}"; fi; }

# ── fixtures ────────────────────────────────────────────────────────────────
# origin (bare) ← work clone with main, a v1.0.0 tag on main, a side branch tagged v9.9.9.
git_quiet() { git -c user.email=t@t -c user.name=t -c init.defaultBranch=main "$@" >/dev/null 2>&1; }
ORIGIN="$ROOT/origin.git"; WORK="$ROOT/work"
git_quiet init --bare "$ORIGIN"
git_quiet clone "$ORIGIN" "$WORK"
(
  cd "$WORK" || exit 1
  git_quiet checkout -b main
  echo a > f; git_quiet add f; git_quiet commit -m one
  git_quiet tag v1.0.0
  git_quiet push origin main --tags
  git_quiet checkout -b side
  echo b > g; git_quiet add g; git_quiet commit -m side
  git_quiet tag v9.9.9
  git_quiet push origin side --tags
  git_quiet checkout main
  git_quiet fetch origin
)

# ── fake binaries ───────────────────────────────────────────────────────────
BIN="$ROOT/bin"; mkdir -p "$BIN"
cat > "$BIN/docker" <<'F'
#!/usr/bin/env bash
# Records every call; behaviour is steered by FAKE_* variables.
echo "docker $*" >> "$FAKE_LOG"
case "$*" in
  *" config "*)
    # Like the real thing, the output holds secrets. The deploy must never print it.
    printf '{\n  "name": "%s",\n  "services": {"api": {"environment": {"KEY": "%s"}}}\n}\n' "${FAKE_PROJECT:-proxiapay}" "$FAKE_CANARY"
    ;;
  *" pull "*) [ "${FAKE_PULL_FAIL:-0}" = 1 ] && { echo "pull denied" >&2; exit 1; } ;;
  *" up "*)   [ "${FAKE_UP_FAIL:-0}" = 1 ] && exit 1 ;;
  "images "*) printf '%s\n' ${FAKE_TAGS:-} ;;
esac
exit 0
F
cat > "$BIN/curl" <<'F'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
printf '%s' "${FAKE_HTTP:-200}"
F
cat > "$BIN/sleep" <<'F'
#!/usr/bin/env bash
exec /bin/sleep 0.05
F
chmod +x "$BIN"/*

# ── check-tag-on-main ───────────────────────────────────────────────────────
run_check() { (cd "$WORK" && bash "$HERE/check-tag-on-main.sh" "$1" 2>&1); }

out=$(run_check v9.9.9); rc=$?
test_case "refuses a tag whose commit is not on main" assert "[ $rc -eq 1 ] && [[ \$out == *'tag v9.9.9 is not on main'* ]]" "rc=$rc out=$out"
out=$(run_check v1.0.0); rc=$?
test_case "accepts a tag on main" assert "[ $rc -eq 0 ]" "rc=$rc out=$out"
out=$(run_check v404); rc=$?
test_case "refuses a tag that does not exist" assert "[ $rc -ne 0 ]"
out=$(cd "$WORK" && bash "$HERE/check-tag-on-main.sh" 2>&1); rc=$?
test_case "refuses a missing argument" assert "[ $rc -ne 0 ]"

# ── deploy.sh ───────────────────────────────────────────────────────────────
# APP_DIR is a clone of origin, with a provider-credentials.env to exercise set-credentials.
setup_app() {
  APP="$ROOT/app-$1"; rm -rf "$APP"
  git_quiet clone "$ORIGIN" "$APP"
  : > "$APP/provider-credentials.env"
  FAKE_LOG="$ROOT/log-$1"; : > "$FAKE_LOG"
}
run_deploy() { # name, then VAR=value overrides
  local name=$1; shift
  setup_app "$name"
  OUT=$(cd "$ROOT" && env PATH="$BIN:$PATH" FAKE_LOG="$FAKE_LOG" FAKE_CANARY="$CANARY" \
    IMAGE_TAG=v1.0.0 GHCR_USER=u GHCR_TOKEN=tok APP_DIR="$APP" APP_DOMAIN=pay.example.test \
    HEALTH_TIMEOUT=2 HEALTH_INTERVAL=1 PULL_RETRY_DELAY=0 "$@" bash "$HERE/deploy.sh" 2>&1)
  RC=$?
  LOG=$(cat "$FAKE_LOG") # read by the assertions, which are eval'd
  export LOG
}

run_deploy happy
test_case "deploy succeeds when everything answers" assert "[ $RC -eq 0 ]" "rc=$RC out=${OUT: -300}"
test_case "deploy checks out the tag" assert "[ \"\$(git -C $APP describe --tags --exact-match)\" = v1.0.0 ]"
test_case "deploy passes both compose files and the env file" assert "grep -q -- '--env-file .env.production -f docker-compose.deploy.yml -f docker-compose.production.yml up' <<<\"\$LOG\""
test_case "deploy never builds: up is called with --no-build" assert "grep -E ' up .*--no-build' <<<\"\$LOG\" | grep -q 'db migrate api worker console backup'"
test_case "deploy pulls before up" assert "[ \$(grep -n ' pull ' <<<\"\$LOG\" | head -1 | cut -d: -f1) -lt \$(grep -n ' up ' <<<\"\$LOG\" | head -1 | cut -d: -f1) ]"
test_case "deploy runs set-credentials" assert "grep -q 'set-credentials.js /run/provider-credentials.env' <<<\"\$LOG\""
test_case "deploy asks healthz on the app domain" assert "grep -q 'https://pay.example.test/healthz' <<<\"\$LOG\""
test_case "deploy never prints the compose config" assert "! grep -q $CANARY <<<\"\$OUT\""
test_case "deploy confirms the project name" assert "grep -q 'Compose project confirmed: proxiapay' <<<\"\$OUT\""

run_deploy healthz FAKE_HTTP=502
test_case "deploy script exits non-zero when healthz never answers 200" assert "[ $RC -eq 1 ]" "rc=$RC"

run_deploy project FAKE_PROJECT=proxiapay-sandbox
test_case "deploy script stops when compose reports another project" assert "[ $RC -eq 1 ] && ! grep -qE ' (pull|up) ' <<<\"\$LOG\" && [[ \$OUT == *proxiapay-sandbox* ]]" "rc=$RC"
test_case "the guard prints nothing else from config" assert "! grep -q $CANARY <<<\"\$OUT\""

run_deploy pullfail FAKE_PULL_FAIL=1
test_case "deploy fails if pull fails, retrying 3 times, and never reaches up" assert "[ $RC -eq 1 ] && [ \$(grep -c ' pull ' <<<\"\$LOG\") -eq 3 ] && ! grep -q ' up ' <<<\"\$LOG\""

run_deploy missingtag IMAGE_TAG=v7.7.7
test_case "deploy fails on a tag that does not exist" assert "[ $RC -ne 0 ] && ! grep -qE ' (pull|up) ' <<<\"\$LOG\""

run_deploy prune FAKE_TAGS="v1.0.0 v1.1.0 v1.2.0 v1.3.0 v1.10.0 latest" IMAGE_TAG=v1.0.0
test_case "prune keeps the 2 newest version tags, the deployed one and latest" assert "grep -q 'rmi ghcr.io/iamvaln/proxiapay-api:v1.1.0' <<<\"\$LOG\" && grep -q 'rmi ghcr.io/iamvaln/proxiapay-db:v1.2.0' <<<\"\$LOG\" && ! grep -qE 'rmi .*:(v1.0.0|v1.3.0|v1.10.0|latest)' <<<\"\$LOG\""

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
