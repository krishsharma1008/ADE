#!/usr/bin/env bash
set -euo pipefail

# install-fresh.sh — simulate a brand-new clone of ADE and verify that
# `git clone → pnpm install → pnpm dev` works out of the box.
#
# What it does:
#   1. Rsyncs the current repo tree (minus node_modules + .git) into /tmp.
#   2. Runs `pnpm install --frozen-lockfile`.
#   3. Runs `pnpm build` (exercises tsc across all workspaces).
#   4. Boots `pnpm dev` with an isolated COMBYNE_HOME.
#   5. Polls /api/health until the server reports ready.
#   6. Asserts /api/system/adapters (or /api/health.adapters) is non-empty.
#   7. Kills the server and tears down the temp dir.
#
# Env knobs:
#   BOOT_WAIT_SECONDS   (default 120)
#   KEEP_TMP=1          do not delete the temp dir (for debugging)

log()  { echo "[install-fresh] $*"; }
warn() { echo "[install-fresh] WARN: $*" >&2; }
fail() { echo "[install-fresh] ERROR: $*" >&2; cleanup; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d%H%M%S)-$$"
TMP_ROOT="/tmp/ade-smoke-${STAMP}"
SMOKE_HOME="${TMP_ROOT}/home"
SERVER_LOG="${TMP_ROOT}/server.log"
SERVER_PID=""
BOOT_WAIT_SECONDS="${BOOT_WAIT_SECONDS:-120}"
TEST_PORT="${TEST_PORT:-3190}"

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log "killing server pid=$SERVER_PID"
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -z "${KEEP_TMP:-}" ]]; then
    rm -rf "$TMP_ROOT" 2>/dev/null || true
  else
    log "keeping $TMP_ROOT (set KEEP_TMP to preserve)"
  fi
}
trap cleanup EXIT

command -v rsync >/dev/null 2>&1 || fail "rsync not found on PATH"
command -v pnpm  >/dev/null 2>&1 || fail "pnpm not found on PATH (install pnpm 9.x)"
command -v curl  >/dev/null 2>&1 || fail "curl not found on PATH"
command -v jq    >/dev/null 2>&1 || fail "jq not found on PATH"

log "staging repo into $TMP_ROOT"
mkdir -p "$SMOKE_HOME"
rsync -a \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude "**/dist" \
  --exclude ".turbo" \
  --exclude "**/.turbo" \
  --exclude ".next" \
  --exclude "**/.next" \
  "$REPO_ROOT/" "$TMP_ROOT/repo/"

cd "$TMP_ROOT/repo"

log "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile >"$TMP_ROOT/install.log" 2>&1 \
  || fail "pnpm install failed (see $TMP_ROOT/install.log)"

log "pnpm build"
pnpm build >"$TMP_ROOT/build.log" 2>&1 \
  || fail "pnpm build failed (see $TMP_ROOT/build.log)"

log "starting pnpm dev on port $TEST_PORT (COMBYNE_HOME=$SMOKE_HOME)"
COMBYNE_HOME="$SMOKE_HOME" PORT="$TEST_PORT" SERVE_UI=true \
  pnpm dev >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

log "waiting up to ${BOOT_WAIT_SECONDS}s for /api/health to report ready"
HEALTH_JSON=""
for i in $(seq 1 "$BOOT_WAIT_SECONDS"); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    tail -40 "$SERVER_LOG" >&2 || true
    fail "server process exited prematurely"
  fi
  HEALTH_JSON="$(curl -fsS "http://127.0.0.1:${TEST_PORT}/api/health" 2>/dev/null || true)"
  if [[ -n "$HEALTH_JSON" ]] && echo "$HEALTH_JSON" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    log "health ok after ${i}s"
    break
  fi
  sleep 1
  HEALTH_JSON=""
done

if [[ -z "$HEALTH_JSON" ]]; then
  tail -60 "$SERVER_LOG" >&2 || true
  fail "server never reported /api/health within ${BOOT_WAIT_SECONDS}s"
fi

log "checking adapter probe in /api/health"
echo "$HEALTH_JSON" | jq -e '.adapters | type == "object"' >/dev/null 2>&1 \
  || fail "/api/health did not return adapters object"

ADAPTER_COUNT="$(echo "$HEALTH_JSON" | jq '.adapters | keys | length')"
[[ "$ADAPTER_COUNT" -gt 0 ]] || fail "adapters object is empty"
log "probed $ADAPTER_COUNT adapter types"

log "hitting /api/companies to verify bootstrap"
curl -fsS "http://127.0.0.1:${TEST_PORT}/api/companies" >/dev/null \
  || fail "GET /api/companies failed"

log "✅ install-fresh smoke passed"
