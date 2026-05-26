#!/usr/bin/env bash
# Incident bundle script per ADR-021@0.1.0 §diag-bundle.sh contract.
#
# Usage:
#   scripts/diag-bundle.sh [<telegram_user_id>]
#
# With no argument:  collects the global slice (recent logs, healthchecks,
#                     getWebhookInfo, no per-user data).
# With a telegram_user_id: also includes the last N=200 redacted
#                     metric_events, cost_events, audit_events rows.
#
# Output: incidents/INC-<UTC-timestamp>.tgz
#
# Required env vars (loaded from .env or shell):
#   POSTGRES_USER, POSTGRES_DB, TELEGRAM_BOT_TOKEN
#   KBJU_PUBLIC_DOMAIN (for the external health check)
#   BUILD_SHA (baked at Dockerfile build time)

set -euo pipefail

# ── Env validation ────────────────────────────────────────────────────────

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
: "${KBJU_PUBLIC_DOMAIN:?KBJU_PUBLIC_DOMAIN is required}"
: "${BUILD_SHA:?BUILD_SHA is required}"

# ── Arguments ─────────────────────────────────────────────────────────────

TELEGRAM_USER_ID="${1:-}"

# ── Timestamp & paths ─────────────────────────────────────────────────────

TIMESTAMP="$(date -u +%Y-%m-%dT%H-%MZ)"
INC_DIR="INC-${TIMESTAMP}"
WORK_DIR="incidents"
mkdir -p "${WORK_DIR}"
chmod 0700 "${WORK_DIR}"

STAGING="${WORK_DIR}/${INC_DIR}"
mkdir -p "${STAGING}"

# ── Node redactStream helper path ─────────────────────────────────────────
# The compiled JS lives inside the Docker container at /app/dist/...
# We invoke it via `docker compose exec -T kbju-sidecar node <path>`.

REDACT_CMD="docker compose exec -T kbju-sidecar node /app/dist/src/incident/redactStream.js"

# ── manifest.json ──────────────────────────────────────────────────────────

APP_VERSION="$(docker compose exec -T kbju-sidecar node -e 'process.stdout.write(require(\"/app/package.json\").version)' 2>/dev/null || echo "unknown")"
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# redaction_schema_version matches LOG_SCHEMA_VERSION from kpiEvents.ts
REDACTION_SCHEMA_VERSION="1"

# Build args array for manifest
if [[ -n "${TELEGRAM_USER_ID}" ]]; then
  ARGS_JSON="[\"${TELEGRAM_USER_ID}\"]"
else
  ARGS_JSON="[]"
fi

cat > "${STAGING}/manifest.json" <<EOF
{
  "version": "${APP_VERSION}",
  "build_sha": "${BUILD_SHA}",
  "generated_at_utc": "${GENERATED_AT}",
  "args": ${ARGS_JSON},
  "redaction_schema_version": "${REDACTION_SCHEMA_VERSION}"
}
EOF

# ── docker-compose-ps.txt ─────────────────────────────────────────────────

docker compose ps > "${STAGING}/docker-compose-ps.txt" 2>&1 || true

# ── healthchecks.txt ──────────────────────────────────────────────────────

{
  echo "=== curl -fsS http://localhost:3000/kbju/health ==="
  curl -fsS http://localhost:3000/kbju/health 2>&1 || echo "FAILED"
  echo ""
  echo "=== curl -fsS https://${KBJU_PUBLIC_DOMAIN}/health ==="
  curl -fsS "https://${KBJU_PUBLIC_DOMAIN}/health" 2>&1 || echo "FAILED"
  echo ""
  echo "=== docker compose exec -T postgres pg_isready -U ${POSTGRES_USER} ==="
  docker compose exec -T postgres pg_isready -U "${POSTGRES_USER}" 2>&1 || echo "FAILED"
} > "${STAGING}/healthchecks.txt"

# ── docker-logs/ ──────────────────────────────────────────────────────────

mkdir -p "${STAGING}/docker-logs"

for SVC in kbju-sidecar openclaw-gateway caddy postgres; do
  docker compose logs --since=30m "${SVC}" 2>&1 \
    | ${REDACT_CMD} \
    > "${STAGING}/docker-logs/${SVC}.log" || true
done

# ── telegram/getWebhookInfo.json ───────────────────────────────────────────

mkdir -p "${STAGING}/telegram"
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" \
  > "${STAGING}/telegram/getWebhookInfo.json" 2>&1 || echo "{}" > "${STAGING}/telegram/getWebhookInfo.json"

# ── db/ (only when telegram_user_id provided) ─────────────────────────────
#
# Forbidden columns (per ADR-021@0.1.0 §diag-bundle.sh contract and
# ARCH-001@0.7.2 §9.5):
#   meal_text, comment_text, raw_text, raw_description, transcript_text
#
# SELECT lists are explicit so reviewers can audit.

if [[ -n "${TELEGRAM_USER_ID}" ]]; then
  mkdir -p "${STAGING}/db"

  # metric_events: safe columns only (id, user_id, request_id, event_name,
  #   component, latency_ms, outcome, created_at)
  #   EXCLUDE: metadata (may contain user-originated free-text fields)
  docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -c "\COPY (SELECT id, user_id, request_id, event_name, component, latency_ms, outcome, created_at FROM metric_events WHERE user_id = '${TELEGRAM_USER_ID}' ORDER BY created_at DESC LIMIT 200) TO STDOUT WITH CSV HEADER" \
    > "${STAGING}/db/metric_events.csv" 2>/dev/null || echo "" > "${STAGING}/db/metric_events.csv"

  # cost_events: safe columns only (id, user_id, request_id, provider_alias,
  #   model_alias, call_type, estimated_cost_usd, actual_cost_usd,
  #   input_units, output_units, billing_unit, created_at)
  #   No forbidden columns in cost_events schema.
  docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -c "\COPY (SELECT id, user_id, request_id, provider_alias, model_alias, call_type, estimated_cost_usd, actual_cost_usd, input_units, output_units, billing_unit, created_at FROM cost_events WHERE user_id = '${TELEGRAM_USER_ID}' ORDER BY created_at DESC LIMIT 200) TO STDOUT WITH CSV HEADER" \
    > "${STAGING}/db/cost_events.csv" 2>/dev/null || echo "" > "${STAGING}/db/cost_events.csv"

  # audit_events: safe columns only (id, user_id, event_type, entity_type,
  #   entity_id, reason, created_at)
  #   EXCLUDE: before_snapshot, after_snapshot (may contain meal_text,
  #   comment_text, raw_text, raw_description, transcript_text)
  docker compose exec -T postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -c "\COPY (SELECT id, user_id, event_type, entity_type, entity_id, reason, created_at FROM audit_events WHERE user_id = '${TELEGRAM_USER_ID}' ORDER BY created_at DESC LIMIT 200) TO STDOUT WITH CSV HEADER" \
    > "${STAGING}/db/audit_events.csv" 2>/dev/null || echo "" > "${STAGING}/db/audit_events.csv"
fi

# ── Tarball ───────────────────────────────────────────────────────────────

tar -czf "${WORK_DIR}/${INC_DIR}.tgz" -C "${WORK_DIR}" "${INC_DIR}"
chmod 0600 "${WORK_DIR}/${INC_DIR}.tgz"

# ── Cleanup staging dir ───────────────────────────────────────────────────

rm -rf "${STAGING}"

echo "Incident bundle written to ${WORK_DIR}/${INC_DIR}.tgz"
