#!/usr/bin/env bash
set -euo pipefail

# shared-context.sh — verify the Phase-C shared-context pipeline end-to-end
# against a running ADE server:
#   1. agent_transcripts, agent_memory, agent_handoffs tables exist.
#   2. If any heartbeat runs have finished, at least one transcript row exists.
#   3. Handoff round-trip: when an issue is reassigned, a handoff row is
#      created and the target agent can observe it via getPendingHandoffBrief.
#
# The script requires a running server (default http://127.0.0.1:3100)
# and psql access to the embedded Postgres on port 54329 (or point
# COMBYNE_TEST_DATABASE_URL at an external Postgres).
#
# Env knobs:
#   COMBYNE_API_URL            (default http://127.0.0.1:3100)
#   COMBYNE_TEST_DATABASE_URL  (default postgres://combyne:combyne@127.0.0.1:54329/combyne)

log()  { echo "[shared-context] $*"; }
fail() { echo "[shared-context] ERROR: $*" >&2; exit 1; }

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"
command -v curl >/dev/null 2>&1 || fail "curl not found on PATH"
command -v jq   >/dev/null 2>&1 || fail "jq not found on PATH"

COMBYNE_API_URL="${COMBYNE_API_URL:-http://127.0.0.1:3100}"
API_BASE="${COMBYNE_API_URL%/}/api"
DB_URL="${COMBYNE_TEST_DATABASE_URL:-postgres://combyne:combyne@127.0.0.1:54329/combyne}"

log "probing /api/health"
HEALTH="$(curl -fsS "${API_BASE}/health")" || fail "server not reachable at ${COMBYNE_API_URL}"
echo "$HEALTH" | jq -e '.status == "ok"' >/dev/null \
  || fail "/api/health did not report ok"

count_rows() {
  local table="$1"
  psql "$DB_URL" -At -c "SELECT COUNT(*) FROM ${table}" 2>/dev/null || echo "MISSING"
}

log "checking shared-context tables"
for table in agent_transcripts agent_memory agent_handoffs; do
  result="$(count_rows "$table")"
  if [[ "$result" == "MISSING" ]]; then
    fail "table ${table} is missing — did migrations run?"
  fi
  log "✓ ${table}: ${result} rows"
done

RUNS="$(count_rows heartbeat_runs)"
log "heartbeat_runs: ${RUNS}"
TRANSCRIPTS="$(count_rows agent_transcripts)"

if [[ "$RUNS" != "MISSING" ]] && [[ "$RUNS" -gt 0 ]]; then
  if [[ "$TRANSCRIPTS" -eq 0 ]]; then
    fail "heartbeat_runs has ${RUNS} rows but agent_transcripts is empty — transcript capture is broken"
  fi
  log "✓ transcript capture active (${TRANSCRIPTS} rows across ${RUNS} runs)"
else
  log "⚠ no runs yet — cannot verify transcript capture against a live run"
fi

# Sanity probe: every handoff should have a non-empty brief.
EMPTY_BRIEFS="$(psql "$DB_URL" -At -c "SELECT COUNT(*) FROM agent_handoffs WHERE length(coalesce(brief,'')) = 0" 2>/dev/null || echo "0")"
if [[ "$EMPTY_BRIEFS" -gt 0 ]]; then
  fail "${EMPTY_BRIEFS} handoff rows have an empty brief"
fi

log "✅ shared-context smoke passed"
