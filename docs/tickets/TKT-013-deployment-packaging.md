---
id: TKT-013
title: Deployment Packaging
status: done
arch_ref: ARCH-001@0.4.0
component: Deployment / ADR-008
depends_on:
- TKT-001@0.1.0
- TKT-002@0.1.0
- TKT-003@0.1.0
blocks:
- TKT-014@0.1.0
estimate: M
created: 2026-04-26
updated: 2026-05-02
---

# TKT-013: Deployment Packaging

## 1. Goal (one sentence, no "and")
Package the KBJU Coach stack for portable Docker Compose deployment.

## 2. In Scope
- Add Docker build files for the Node 24 OpenClaw skill package.
- Add Docker Compose services for the app, PostgreSQL, and optional local/private OmniRoute endpoint wiring.
- Add `.env.example` with variable names only and no secret values.
- Add Docker log rotation settings and loopback/internal metrics binding.
- Add backup, rollback, and VPS migration helper scripts matching ARCH-001@0.4.0 §10.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No application feature implementation beyond health checks.
- No production secret values.
- No Kubernetes, systemd unit, host-network, or host bind-mount deployment path.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.4.0 §6 External Interfaces
- ARCH-001@0.4.0 §8 Observability
- ARCH-001@0.4.0 §9 Security
- ARCH-001@0.4.0 §10 Deployment
- ADR-002@0.1.0
- ADR-008@0.1.0
- ADR-009@0.1.0
- docs/knowledge/llm-routing.md
- `package.json`
- `src/index.ts`
- `src/shared/config.ts`
- `src/store/schema.sql`
- `src/observability/metricsEndpoint.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `.env.example` documenting required variable names with blank/example-safe values only
- [ ] `Dockerfile`
- [ ] `docker-compose.yml`
- [ ] `infra/omniroute/README.md` documenting router-first config expectations without secrets
- [ ] `scripts/backup-kbju.sh`
- [ ] `scripts/rollback-kbju.sh`
- [ ] `scripts/migrate-vps-kbju.sh` (operator-facing helper that runs the ARCH-001@0.4.0 §10.6 sequence, including `setWebhook` + `getWebhookInfo` verification — reference: `scripts/migrate-vps.sh` already in repo)
- [ ] `src/deployment/healthCheck.ts` exporting a health check used by the container
- [ ] `tests/deployment/compose.test.ts`
- [ ] `tests/deployment/envExample.test.ts`

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/deployment/compose.test.ts tests/deployment/envExample.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `docker compose config` succeeds.
- [ ] Tests prove `.env.example` contains every required variable from ARCH-001@0.4.0 §9.1 and contains no plausible secret values.
- [ ] Tests prove `docker-compose.yml` uses named volumes for PostgreSQL/OpenClaw state and no host bind mounts for production data.
- [ ] Tests prove metrics bind to loopback/internal network only and Docker logs have bounded rotation.
- [ ] Scripts include backup, rollback, and VPS migration command sequences from ARCH-001@0.4.0 §10.
- [ ] `scripts/rollback-kbju.sh` runs the §10.5.1 pre-flight (DB snapshot, migration check), the §10.5.2 health-check loop on `http://127.0.0.1:9464/metrics`, and posts a Telegram PO ping to `$PO_ALERT_CHAT_ID` on success; tests assert the script aborts (non-zero exit) when health checks fail.
- [ ] `scripts/migrate-vps-kbju.sh` calls Telegram `setWebhook` and verifies `getWebhookInfo` returns the new URL with `last_error_date: null`; tests assert the script fails fast if `getWebhookInfo` reports an error.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies.
- Do NOT commit real secrets, tokens, Telegram IDs, provider keys, or DB passwords.
- Do NOT use host networking or systemd.
- Do NOT use host bind mounts for production data; named Docker volumes only.
- Do NOT change ADR-selected providers or routing topology.
- GLM assignment is appropriate because this is packaging with concrete file-based ACs.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
