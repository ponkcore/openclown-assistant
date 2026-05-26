---
id: TKT-040
title: 'install.sh single-command deploy + setWebhook + getWebhookInfo'
status: in_review
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: Deployment / scripts / ADR-020
depends_on:
- TKT-038@0.1.0
- TKT-039@0.1.0
- TKT-041@0.1.0
- TKT-042@0.1.0
blocks: []
estimate: M
created: 2026-05-25
updated: 2026-05-25
---

# TKT-040: install.sh single-command deploy + setWebhook + getWebhookInfo

## 1. Goal
Implement `./scripts/install.sh` as the idempotent single-command entry point for fresh and existing VPS deploys per ARCH-001@0.7.0 §10.4 Deploy Sequence and ADR-020@0.1.0 §install.sh path.

## 2. In Scope
The script MUST:

1. Validate Docker (`docker --version`, version ≥ 20.10) and `docker compose` plugin (≥ v2).
2. Read `.env.production` if present, else prompt for `KBJU_PUBLIC_DOMAIN` interactively and append to `.env.production` (file mode 0600).
3. Validate `KBJU_PUBLIC_DOMAIN` resolves (`dig +short` or `getent hosts`) to a public IP that matches `curl -fsS https://api.ipify.org` (warn, don't abort, on CDN-fronted IPs); skip this when `INSTALL_TLS_MODE=cloudflare-tunnel`.
4. Validate port 80 reachable on the VPS public IP (loopback bind + reachability check); skip when in cloudflare-tunnel mode.
5. Validate `.env.production` against the application's `parseConfig` requirements (run `node dist/src/main.js --validate-config` once Docker images are built, OR run a lightweight validator the executor can wire); the validator MUST fail fast with a structured list of missing required keys.
6. `docker compose pull` (only the externally-published images: `postgres`, `caddy`, `cloudflared`, `openclaw-gateway`).
7. `docker compose build kbju-sidecar metrics` (the locally-built services).
8. `docker compose up -d postgres`; wait for postgres to be healthy (poll `pg_isready` up to 60 s).
9. Run migrations (delegated to the runMigrations boot path from TKT-041@0.1.0, OR an explicit `kbju-migrate` init container — TKT-041@0.1.0 picks; install.sh either way passes through).
10. Seed `config/allowlist.json` from `TELEGRAM_PILOT_USER_IDS` if the file does not exist (delegated to TKT-042@0.1.0's seeding logic; install.sh just calls it).
11. `docker compose up -d --remove-orphans` (brings up the rest, including Caddy / cloudflared per `INSTALL_TLS_MODE`).
12. Wait for Caddy to expose the HTTPS endpoint: poll `https://<KBJU_PUBLIC_DOMAIN>/health` up to 120 s; ACME issuance can take 30–90 s on first run.
13. Call Telegram `setWebhook` to `https://<KBJU_PUBLIC_DOMAIN>/telegram` (skip path adjusted for cloudflare-tunnel mode if needed).
14. Call Telegram `getWebhookInfo`; assert `last_error_date == null`. Fail fast with the error message if not.
15. Smoke-test `https://<KBJU_PUBLIC_DOMAIN>/health` (Caddy) and `http://localhost:3000/kbju/health` (sidecar) — both must return 200.
16. Print a clear "INSTALL OK" banner with the deployed git SHA on success; non-zero exit on any failure.

The script MUST be idempotent: re-running on a healthy stack is a no-op except for steps 13–15 which re-confirm the webhook.

## 3. NOT In Scope
- Docker / `docker compose` installation itself (operator's responsibility; the script validates presence and aborts with guidance).
- Firewall / UFW configuration — operator's responsibility before running the script; the script's port-80 / 443 reachability check catches the symptom but does not configure the firewall.
- Backup / rollback flow — out of scope for install.sh; ARCH-001@0.7.0 §10.5 / §10.6 owns those, and `scripts/backup-kbju.sh` / `scripts/rollback-kbju.sh` exist already (TKT-013@0.1.0).
- DNS provisioning — the operator points the A-record manually before running install.sh.

## 4. Inputs
- ARCH-001@0.7.0 §10.4 Deploy Sequence (the canonical single-command flow)
- ARCH-001@0.7.0 §10.7 VPS Migration Runbook (calls install.sh)
- ADR-020@0.1.0 §install.sh path (the precise step list)
- ADR-019@0.1.0 (Dockerfile assumed to be multi-stage; build runs inside Docker)
- TKT-038@0.1.0 / TKT-039@0.1.0 / TKT-041@0.1.0 / TKT-042@0.1.0 (depends_on)
- Existing `scripts/migrate-vps.sh`, `scripts/migrate-vps-kbju.sh` for command shape conventions
- Telegram setWebhook reference: <https://core.telegram.org/bots/api#setwebhook>
- Telegram getWebhookInfo reference: <https://core.telegram.org/bots/api#getwebhookinfo>

## 5. Outputs
- [ ] `scripts/install.sh` (new), executable mode 0755.
- [ ] `tests/deployment/installScript.test.ts` (or a shell-level smoke test wrapping `bash -n scripts/install.sh` + lint with `shellcheck` if it's already a project dependency) asserting:
  - The script exits non-zero when DNS validation fails.
  - The script exits non-zero when port 80 is unreachable (mock).
  - The script exits non-zero when `getWebhookInfo` reports an error.
  - The script is idempotent (running it twice in a row leaves the same state).

## 6. Acceptance Criteria
- [ ] `bash -n scripts/install.sh` clean (no syntax errors).
- [ ] `shellcheck scripts/install.sh` clean (no `error` / `warning` level findings; `info` and `style` may remain if the executor justifies them in PR body).
- [ ] `npm test -- tests/deployment/installScript.test.ts` passes.
- [ ] On a fresh local Docker environment with mocked Telegram + DNS, end-to-end `./scripts/install.sh` brings the stack up and exits 0.
- [ ] Re-running install.sh on a healthy stack exits 0, performs no destructive action, and reconfirms the webhook.
- [ ] The script aborts with a structured error if `KBJU_PUBLIC_DOMAIN` doesn't resolve to a reachable public IP (when not in cloudflare-tunnel mode).

## 7. Constraints
- Use `set -euo pipefail` and explicit error traps.
- Use `bash`, not POSIX sh — the script targets Ubuntu 24.04+ (PRD-001@0.3.0 §7 VPS floor).
- Do NOT shell out to `npm` / `node` directly on the VPS host; everything runs through `docker compose` or `docker compose exec`.
- Do NOT commit `.env.production` (verify `.gitignore` covers `.env*` already; do not weaken it).
- Do NOT use `--force` flags on destructive Docker commands.
- File mode of `.env.production` after script writes: 0600.
- All Telegram API calls use `curl -fsS --max-time 10`; on transient failure, retry up to 3 times with linear backoff; on permanent failure, exit 1 with the API error message.
- The script's interactive prompt (`KBJU_PUBLIC_DOMAIN` input) MUST be skippable: when stdin is non-tty, the script MUST refuse to prompt and abort with guidance to populate `.env.production` first.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->

- 2026-05-26T00:00:00Z opencode-executor: started

- 2026-05-26T05:05:00Z opencode-executor: in_review; tests 33 pass (9 installScript + 24 bootEntrypoint); lint clean; typecheck clean. Carve-outs: (1) BACKLOG-004 AllowlistSeedError wiring — src/main.ts constructs Allowlist in startServer(), catches AllowlistSeedError, exits non-zero. Ref: docs/backlog/tkt-042-allowlist-seed-error-boot-wiring.md. (2) BUILD_SHA propagation — install.sh passes `--build-arg BUILD_SHA=$(git rev-parse HEAD)` to `docker compose build`. (3) --validate-config flag added to src/main.ts for install.sh step 5 per ARCH-001@0.7.2 §10.4 step 5. Version-pinned refs: ARCH-001@0.7.2, ADR-020@0.1.1.
