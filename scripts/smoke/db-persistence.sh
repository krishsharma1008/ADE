#!/usr/bin/env bash
set -euo pipefail

# DB persistence smoke — verifies that data written to embedded Postgres
# survives a full server restart (i.e. the cluster is mounted on a
# persistent on-disk data dir at ~/.combyne/instances/default/db).
#
# Acceptance criteria:
#  1. Server boots, Postgres listens on the pinned port (default 54329).
#  2. `GET /api/health` reports database.mode = embedded-postgres.
#  3. `POST /api/companies` creates a company and returns 201.
#  4. Server is stopped cleanly, no data dir is wiped.
#  5. Server is restarted; the same company is still listed via
#     `GET /api/companies`.
#  6. The test-only company is cleaned up at the end.
#
# Env knobs:
#  COMBYNE_API_URL     (default http://127.0.0.1:${PORT:-3200})
#  PORT                (default 3200 — the dev server port)
#  BOOT_WAIT_SECONDS   (default 90)
#  KEEP_COMPANY=1      skip the final cleanup (useful for manual inspection)

log()  { echo "[db-persistence] $*"; }
warn() { echo "[db-persistence] WARN: $*" >&2; }
fail() { echo "[db-persistence] ERROR: $*" >&2; cleanup; exit 1; }

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command: $cmd"
}

require_cmd curl
require_cmd jq
require_cmd pnpm

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

PORT="${PORT:-3200}"
COMBYNE_API_URL="${COMBYNE_API_URL:-http://127.0.0.1:${PORT}}"
API_BASE="${COMBYNE_API_URL%/}/api"
BOOT_WAIT_SECONDS="${BOOT_WAIT_SECONDS:-90}"
PG_PORT="${COMBYNE_EMBEDDED_POSTGRES_PORT:-54329}"

STAMP="$(date +%Y%m%d%H%M%S)-$$"
TEST_COMPANY_NAME="db-persist-smoke-${STAMP}"

LOG_DIR="$(mktemp -d -t db-persistence-XXXXXX)"
BOOT1_LOG="${LOG_DIR}/boot1.log"
BOOT2_LOG="${LOG_DIR}/boot2.log"

SERVER_PID=""

wait_for_ready() {
  local deadline=$((SECONDS + BOOT_WAIT_SECONDS))
  while (( SECONDS < deadline )); do
    if curl -fsS "${API_BASE}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_server() {
  local logfile="$1"
  log "starting dev server on PORT=${PORT}, logging to ${logfile}"
  # Launch the API server in its own process group via `setsid` so we
  # can deliver SIGTERM to the whole group (pnpm → tsx → postgres
  # supervisor) on shutdown. Without this, TERM to pnpm leaves the
  # tsx/postgres children alive and the second boot races the embedded
  # postmaster.
  if command -v setsid >/dev/null 2>&1; then
    PORT="$PORT" setsid pnpm --filter @combyne/server dev >"$logfile" 2>&1 &
  else
    # macOS doesn't ship setsid by default. `set -m` + a subshell puts
    # the child in its own process group.
    ( set -m; PORT="$PORT" exec pnpm --filter @combyne/server dev >"$logfile" 2>&1 ) &
  fi
  SERVER_PID=$!
  log "server pid=${SERVER_PID}"
  if ! wait_for_ready; then
    warn "server did not become ready within ${BOOT_WAIT_SECONDS}s; dumping log tail:"
    tail -n 80 "$logfile" >&2 || true
    return 1
  fi
  return 0
}

stop_server() {
  if [[ -z "${SERVER_PID:-}" ]]; then
    return 0
  fi
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    log "stopping server pid=${SERVER_PID} (group)"
    # Negative pid sends the signal to the whole process group.
    kill -TERM "-${SERVER_PID}" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true
    local deadline=$((SECONDS + 25))
    while (( SECONDS < deadline )); do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      warn "server did not stop after TERM; sending KILL to group"
      kill -KILL "-${SERVER_PID}" 2>/dev/null || kill -KILL "$SERVER_PID" 2>/dev/null || true
    fi
  fi
  # Belt-and-braces: pnpm under `set -m` sometimes leaks a tsx
  # grandchild that outlives its parent. If anything is still bound to
  # the API port after the group kill, TERM → KILL it directly.
  local port_deadline=$((SECONDS + 15))
  while (( SECONDS < port_deadline )); do
    if ! lsof -iTCP:"${PORT}" -sTCP:LISTEN -nP >/dev/null 2>&1; then
      break
    fi
    local zombie
    zombie="$(lsof -iTCP:"${PORT}" -sTCP:LISTEN -nP -t 2>/dev/null | head -1 || true)"
    if [[ -n "${zombie:-}" ]]; then
      warn "port ${PORT} still held by pid=${zombie}; killing"
      kill -TERM "$zombie" 2>/dev/null || true
      sleep 2
      kill -KILL "$zombie" 2>/dev/null || true
    fi
    sleep 1
  done
  SERVER_PID=""
}

cleanup() {
  stop_server || true
}
trap cleanup EXIT

log "repo=${REPO_ROOT}"
log "api=${COMBYNE_API_URL}"
log "pg port=${PG_PORT}"
log "test company name=${TEST_COMPANY_NAME}"

# --- Boot 1 -----------------------------------------------------------
start_server "$BOOT1_LOG" || fail "first boot failed"

log "checking /api/health"
HEALTH_JSON="$(curl -fsS "${API_BASE}/health")"
echo "$HEALTH_JSON" | jq . >/dev/null || fail "health response not valid JSON: $HEALTH_JSON"

DB_MODE="$(echo "$HEALTH_JSON" | jq -r '.database.mode // empty')"
DB_PORT="$(echo "$HEALTH_JSON" | jq -r '.database.port // empty')"
if [[ "$DB_MODE" != "embedded-postgres" ]]; then
  fail "expected database.mode=embedded-postgres, got '${DB_MODE}'"
fi
if [[ "$DB_PORT" != "$PG_PORT" ]]; then
  fail "expected database.port=${PG_PORT}, got '${DB_PORT}'"
fi
log "health OK (mode=${DB_MODE}, port=${DB_PORT})"

log "creating company '${TEST_COMPANY_NAME}'"
CREATE_JSON="$(curl -fsS -X POST "${API_BASE}/companies" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg n "$TEST_COMPANY_NAME" '{name: $n, description: "db persistence smoke"}')")"
COMPANY_ID="$(echo "$CREATE_JSON" | jq -r '.id // empty')"
[[ -n "$COMPANY_ID" ]] || fail "create company response missing id: $CREATE_JSON"
log "created company id=${COMPANY_ID}"

stop_server

# --- Boot 2 -----------------------------------------------------------
start_server "$BOOT2_LOG" || fail "second boot failed"

log "verifying company survives restart"
LIST_JSON="$(curl -fsS "${API_BASE}/companies")"
FOUND="$(echo "$LIST_JSON" | jq -r --arg id "$COMPANY_ID" '[.[] | select(.id==$id)] | length')"
if [[ "$FOUND" != "1" ]]; then
  fail "company ${COMPANY_ID} not found after restart; list=${LIST_JSON}"
fi
log "company ${COMPANY_ID} persisted across restart ✓"

if [[ "${KEEP_COMPANY:-0}" != "1" ]]; then
  log "archiving test company (cleanup)"
  curl -fsS -X POST "${API_BASE}/companies/${COMPANY_ID}/archive" >/dev/null || warn "archive call failed (non-fatal)"
fi

stop_server
log "DONE — logs kept in ${LOG_DIR}"
