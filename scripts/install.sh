#!/usr/bin/env bash
# shellcheck source=/dev/null
# install.sh — idempotent single-command deploy per ARCH-001@0.7.2 §10.4

set -euo pipefail
# ── Error trap ──────────────────────────────────────────────────────────────
# Structured error output on any unhandled failure.
err_trap() {
  local exit_code=$?
  local line_no=$1
  echo "INSTALL FAILED at line ${line_no} (exit ${exit_code}). See output above for details." >&2
  exit "$exit_code"
}
trap 'err_trap ${LINENO}' ERR

# ── Constants ───────────────────────────────────────────────────────────────
ENV_FILE=".env.production"
COMPOSE_FILES_DEFAULT="docker-compose.yml"
COMPOSE_FILES_CF_TUNNEL="docker-compose.yml docker-compose.cf-tunnel.yml"
CADDY_HEALTH_TIMEOUT=120     # seconds
POSTGRES_HEALTH_TIMEOUT=60  # seconds
TELEGRAM_API_BASE="https://api.telegram.org"
TELEGRAM_MAX_RETRIES=3
TELEGRAM_CURL_OPTS=(-fsS --max-time 10)
BUILD_SHA=""

# ── Helpers ─────────────────────────────────────────────────────────────────

log_step() {
  echo "[$1] $2"
}

is_cf_tunnel() {
  [[ "${INSTALL_TLS_MODE:-}" == "cloudflare-tunnel" ]]
}

# Resolve the compose file list based on TLS mode.
compose_files() {
  if is_cf_tunnel; then
    echo "${COMPOSE_FILES_CF_TUNNEL}"
  else
    echo "${COMPOSE_FILES_DEFAULT}"
  fi
}

# docker compose with the correct -f flags.
dc() {
  local files
  files="$(compose_files)"
  local -a fflags=()
  for f in ${files}; do
    fflags+=(-f "$f")
  done
  docker compose "${fflags[@]}" "$@"
}

# Retry a command up to N times with linear backoff.
# Usage: retry <max_attempts> <delay_seconds> <cmd...>
retry() {
  local max=$1 delay=$2; shift 2
  local attempt=1
  while (( attempt <= max )); do
    if "$@"; then
      return 0
    fi
    if (( attempt < max )); then
      local actual_delay=$((delay * attempt))
      echo "  attempt ${attempt}/${max} failed, retrying in ${actual_delay}s..." >&2
      sleep "$actual_delay"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

# ── Step 1: Validate Docker and docker compose versions ─────────────────────

step_validate_docker() {
  log_step 1 "Validating Docker and docker compose versions..."

  if ! command -v docker &>/dev/null; then
    echo "ERROR: docker is not installed. Install Docker Engine ≥ 20.10 and re-run." >&2
    exit 1
  fi

  local docker_ver
  docker_ver="$(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1)"
  local docker_major docker_minor
  IFS='.' read -r docker_major docker_minor _ <<< "$docker_ver"
  if (( docker_major < 20 || (docker_major == 20 && docker_minor < 10) )); then
    echo "ERROR: Docker version ${docker_ver} is below 20.10. Upgrade and re-run." >&2
    exit 1
  fi

  if ! docker compose version &>/dev/null; then
    echo "ERROR: docker compose plugin (v2) is not installed. Install the Compose plugin and re-run." >&2
    exit 1
  fi

  local compose_ver
  compose_ver="$(docker compose version --short 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo "0.0.0")"
  local compose_major
  IFS='.' read -r compose_major _ _ <<< "$compose_ver"
  if (( compose_major < 2 )); then
    echo "ERROR: docker compose version ${compose_ver} is below v2. Upgrade and re-run." >&2
    exit 1
  fi

  echo "  Docker ${docker_ver}, Compose ${compose_ver} — OK"
}

# ── Step 2: Read or prompt KBJU_PUBLIC_DOMAIN ───────────────────────────────

step_env_domain() {
  log_step 2 "Reading .env.production / prompting for KBJU_PUBLIC_DOMAIN..."

  # Source existing .env.production if present
  if [[ -f "${ENV_FILE}" ]]; then
    # shellcheck disable=SC1090
    # shellcheck source=/dev/null
    set -a; source "${ENV_FILE}"; set +a
    echo "  Loaded ${ENV_FILE}"
  fi

  # If KBJU_PUBLIC_DOMAIN is already set, nothing to do
  if [[ -n "${KBJU_PUBLIC_DOMAIN:-}" ]]; then
    echo "  KBJU_PUBLIC_DOMAIN=${KBJU_PUBLIC_DOMAIN}"
    return 0
  fi

  # Interactive prompt — MUST be on a tty
  if [[ ! -t 0 ]]; then
    echo "ERROR: KBJU_PUBLIC_DOMAIN is not set and stdin is not a tty." >&2
    echo "  Populate ${ENV_FILE} with KBJU_PUBLIC_DOMAIN=<your-domain> and re-run." >&2
    exit 1
  fi

  read -r -p "Enter KBJU_PUBLIC_DOMAIN (e.g. bot.example.com): " KBJU_PUBLIC_DOMAIN
  if [[ -z "${KBJU_PUBLIC_DOMAIN}" ]]; then
    echo "ERROR: KBJU_PUBLIC_DOMAIN cannot be empty." >&2
    exit 1
  fi

  # Append to .env.production
  {
    echo ""
    echo "# Added by install.sh"
    echo "KBJU_PUBLIC_DOMAIN=${KBJU_PUBLIC_DOMAIN}"
  } >> "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  echo "  Appended KBJU_PUBLIC_DOMAIN to ${ENV_FILE} (mode 0600)"

  # Re-source so the rest of the script sees it
  # shellcheck disable=SC1090
  # shellcheck source=/dev/null
    set -a; source "${ENV_FILE}"; set +a
}

# ── Step 3: Validate DNS A-record ───────────────────────────────────────────

step_validate_dns() {
  log_step 3 "Validating DNS for ${KBJU_PUBLIC_DOMAIN}..."

  if is_cf_tunnel; then
    echo "  Skipped (INSTALL_TLS_MODE=cloudflare-tunnel)"
    return 0
  fi

  local public_ip dns_ip
  public_ip="$(curl -fsS --max-time 10 https://api.ipify.org)" || {
    echo "ERROR: Cannot determine this host's public IP via api.ipify.org" >&2
    exit 1
  }

  # Try dig first, fall back to getent
  if command -v dig &>/dev/null; then
    dns_ip="$(dig +short "${KBJU_PUBLIC_DOMAIN}" A 2>/dev/null | tail -1)" || true
  elif command -v getent &>/dev/null; then
    dns_ip="$(getent hosts "${KBJU_PUBLIC_DOMAIN}" 2>/dev/null | awk '{print $1; exit}')" || true
  else
    echo "WARN: Neither dig nor getent available; skipping DNS resolution check." >&2
    return 0
  fi

  if [[ -z "${dns_ip}" ]]; then
    echo "ERROR: ${KBJU_PUBLIC_DOMAIN} does not resolve to any IP address." >&2
    echo "  Create a DNS A-record pointing to ${public_ip} and re-run." >&2
    exit 1
  fi

  if [[ "${dns_ip}" != "${public_ip}" ]]; then
    echo "  WARN: ${KBJU_PUBLIC_DOMAIN} resolves to ${dns_ip} but this host's public IP is ${public_ip}." >&2
    echo "  This may be normal for CDN-fronted domains, but ACME HTTP-01 challenge will fail if Caddy can't reach the domain." >&2
  else
    echo "  DNS ${KBJU_PUBLIC_DOMAIN} → ${dns_ip} matches public IP — OK"
  fi
}

# ── Step 4: Validate port 80 reachability ────────────────────────────────────

step_validate_port80() {
  log_step 4 "Validating port 80 reachability..."

  if is_cf_tunnel; then
    echo "  Skipped (INSTALL_TLS_MODE=cloudflare-tunnel)"
    return 0
  fi

  # Quick check: can we bind port 80?
  if ! python3 -c "
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(('0.0.0.0', 80))
    s.close()
except OSError as e:
    print(f'Cannot bind port 80: {e}', file=sys.stderr)
    sys.exit(1)
" 2>/dev/null; then
    echo "ERROR: Cannot bind port 80 — another process is using it or firewall blocks it." >&2
    echo "  Free port 80 (or stop the competing process) and re-run." >&2
    exit 1
  fi

  # Reachability check: start a temp listener, then curl it
  local tmp_pid
  python3 -c "
import socket, http.server, threading
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.send_response(200); self.end_headers(); self.write=b'port80-ok'
    def log_message(self, *a): pass
s = http.server.HTTPServer(('0.0.0.0', 80), H)
threading.Thread(target=s.serve_forever, daemon=True).start()
import time; time.sleep(10)
s.shutdown()
" &>/dev/null &
  tmp_pid=$!

  # Give the server a moment to start
  sleep 1

  if ! curl -fsS --max-time 5 http://127.0.0.1:80 &>/dev/null; then
    kill "${tmp_pid}" 2>/dev/null || true
    echo "ERROR: Port 80 is not reachable on loopback. Firewall may be blocking it." >&2
    exit 1
  fi

  kill "${tmp_pid}" 2>/dev/null || true
  wait "${tmp_pid}" 2>/dev/null || true
  echo "  Port 80 reachable — OK"
}

# ── Step 5: Validate .env.production via --validate-config ──────────────────

step_validate_config() {
  log_step 5 "Validating .env.production via --validate-config..."

  # First build the sidecar image so we can run the validator
  dc build kbju-sidecar --build-arg BUILD_SHA="${BUILD_SHA}" &>/dev/null || {
    echo "ERROR: Failed to build kbju-sidecar image for config validation." >&2
    exit 1
  }

  # Run --validate-config inside a throwaway container
  if ! dc run --rm kbju-sidecar node dist/src/main.js --validate-config; then
    echo "ERROR: Config validation failed. Missing or invalid required keys in ${ENV_FILE}." >&2
    exit 1
  fi
  echo "  Config validation — OK"
}

# ── Step 6: docker compose pull (externally-published images) ────────────────

step_pull_images() {
  log_step 6 "Pulling externally-published images..."

  local -a pull_services=(postgres caddy openclaw-gateway)
  if is_cf_tunnel; then
    pull_services=(postgres cloudflared openclaw-gateway)
  fi

  dc pull "${pull_services[@]}" || {
    echo "WARN: Some images failed to pull; continuing (may build from cache)." >&2
  }
  echo "  Image pull — done"
}

# ── Step 7: docker compose build (locally-built services) ────────────────────

step_build_images() {
  log_step 7 "Building locally-built services (kbju-sidecar, metrics)..."

  dc build kbju-sidecar metrics --build-arg "BUILD_SHA=${BUILD_SHA}"
  echo "  Build — done"
}

# ── Step 8: postgres health ─────────────────────────────────────────────────

step_postgres_up() {
  log_step 8 "Starting postgres and waiting for healthy..."

  dc up -d postgres

  local waited=0
  while (( waited < POSTGRES_HEALTH_TIMEOUT )); do
    if dc exec -T postgres pg_isready -U postgres &>/dev/null; then
      echo "  Postgres healthy after ${waited}s"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done

  echo "ERROR: Postgres did not become healthy within ${POSTGRES_HEALTH_TIMEOUT}s." >&2
  dc logs --since=2m postgres
  exit 1
}

# ── Steps 9-10: migrations + allowlist seed (delegated to boot path) ─────────

step_sidecar_boot() {
  log_step "9-10" "Starting sidecar (migrations + allowlist seed via boot path)..."

  # Bring up the sidecar; its boot path handles:
  #   - TKT-041: runMigrations before HTTP bind
  #   - TKT-042: seed allowlist from TELEGRAM_PILOT_USER_IDS if file missing
  #   - BACKLOG-004: exit non-zero on AllowlistSeedError
  dc up -d kbju-sidecar

  # Wait for sidecar health
  local waited=0
  while (( waited < 60 )); do
    if dc exec -T kbju-sidecar node -e \
      "const http=require('http');const req=http.get('http://localhost:3000/kbju/health',r=>{process.exit(r.statusCode===200?0:1)});req.on('error',()=>process.exit(1));" &>/dev/null; then
      echo "  Sidecar healthy after ${waited}s — migrations + allowlist seed complete"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done

  echo "ERROR: Sidecar did not become healthy within 60s." >&2
  dc logs --since=2m kbju-sidecar
  exit 1
}

# ── Step 11: docker compose up -d --remove-orphans ──────────────────────────

step_full_up() {
  log_step 11 "Bringing up the full stack..."

  dc up -d --remove-orphans
  echo "  Stack up — done"
}

# ── Step 12: Wait for Caddy HTTPS endpoint ──────────────────────────────────

step_wait_caddy() {
  log_step 12 "Waiting for Caddy HTTPS endpoint..."

  if is_cf_tunnel; then
    echo "  Skipped (INSTALL_TLS_MODE=cloudflare-tunnel; cloudflared handles TLS)"
    return 0
  fi

  local waited=0
  while (( waited < CADDY_HEALTH_TIMEOUT )); do
    if curl -fsS --max-time 5 "https://${KBJU_PUBLIC_DOMAIN}/health" &>/dev/null; then
      echo "  Caddy HTTPS healthy after ${waited}s"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done

  echo "ERROR: Caddy HTTPS endpoint not healthy within ${CADDY_HEALTH_TIMEOUT}s." >&2
  echo "  ACME issuance may have failed. Check 'docker compose logs caddy'." >&2
  dc logs --since=3m caddy
  exit 1
}

# ── Steps 13-14: Telegram setWebhook + getWebhookInfo ───────────────────────

step_telegram_webhook() {
  log_step 13 "Calling Telegram setWebhook..."

  : "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required for setWebhook}"

  local webhook_url
  webhook_url="https://${KBJU_PUBLIC_DOMAIN}/telegram"

  if ! retry "${TELEGRAM_MAX_RETRIES}" 2 \
    curl "${TELEGRAM_CURL_OPTS[@]}" \
      -X POST "${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
      -d "url=${webhook_url}" \
      -d "drop_pending_updates=false"; then
    echo "ERROR: Telegram setWebhook failed after ${TELEGRAM_MAX_RETRIES} attempts." >&2
    exit 1
  fi
  echo ""

  log_step 14 "Calling Telegram getWebhookInfo..."

  local info_response
  info_response="$(retry "${TELEGRAM_MAX_RETRIES}" 2 \
    curl "${TELEGRAM_CURL_OPTS[@]}" \
      "${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo")" || {
    echo "ERROR: Telegram getWebhookInfo failed after ${TELEGRAM_MAX_RETRIES} attempts." >&2
    exit 1
  }

  # Parse last_error_date; if present and non-null, fail fast
  local last_error_date
  last_error_date="$(echo "${info_response}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = d.get('result', {})
led = r.get('last_error_date')
if led is not None:
    err_msg = r.get('last_error_message', 'unknown error')
    print(f'ERROR_DATE:{led}:ERROR_MSG:{err_msg}', file=sys.stderr)
    sys.exit(1)
else:
    print('ok')
" 2>&1)" || {
    echo "ERROR: Telegram webhook reports an error:" >&2
    echo "  ${last_error_date}" >&2
    exit 1
  }

  echo "  getWebhookInfo: no errors — OK"
}

# ── Step 15: Smoke test /health endpoints ───────────────────────────────────

step_smoke_test() {
  log_step 15 "Smoke-testing /health endpoints..."

  if ! is_cf_tunnel; then
    curl -fsS --max-time 10 "https://${KBJU_PUBLIC_DOMAIN}/health" &>/dev/null || {
      echo "ERROR: Caddy /health returned non-200." >&2
      exit 1
    }
    echo "  Caddy /health — OK"
  fi

  dc exec -T kbju-sidecar node -e \
    "const http=require('http');const req=http.get('http://localhost:3000/kbju/health',r=>{process.exit(r.statusCode===200?0:1)});req.on('error',()=>process.exit(1));" &>/dev/null || {
    echo "ERROR: Sidecar /kbju/health returned non-200." >&2
    exit 1
  }
  echo "  Sidecar /kbju/health — OK"
}

# ── Step 16: INSTALL OK banner ──────────────────────────────────────────────

step_banner() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  INSTALL OK                                                 ║"
  echo "║  Deployed git SHA: ${BUILD_SHA}                                   ║"
  echo "║  Domain: ${KBJU_PUBLIC_DOMAIN}                                     ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  # Resolve BUILD_SHA from git
  BUILD_SHA="$(git rev-parse HEAD 2>/dev/null || echo "unknown")"

  step_validate_docker      # 1
  step_env_domain           # 2
  step_validate_dns         # 3
  step_validate_port80      # 4
  step_validate_config      # 5
  step_pull_images          # 6
  step_build_images         # 7
  step_postgres_up          # 8
  step_sidecar_boot         # 9-10
  step_full_up              # 11
  step_wait_caddy           # 12
  step_telegram_webhook     # 13-14
  step_smoke_test           # 15
  step_banner               # 16
}

main "$@"
