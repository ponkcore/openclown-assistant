---
id: TKT-044
title: '/diag Telegram command (incident diagnostic block)'
status: in_review
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: C1 Entrypoint / IncidentDiagnostic
depends_on:
- TKT-033@0.1.0
blocks: []
estimate: M
created: 2026-05-25
updated: 2026-05-25
---

# TKT-044: /diag Telegram command (incident diagnostic block)

## 1. Goal
Implement the Telegram `/diag` command that returns a redacted plain-text diagnostic block fit for forwarding back to the PO per ADR-021@0.1.0 §C2.

## 2. In Scope
- C1 routing: add `/diag` to the C1 command dispatcher; allowlisted to `TELEGRAM_PILOT_USER_IDS`-equivalent entries (C15 allowlist), same as every other command.
- New `IncidentDiagnostic` handler (`src/incident/diagHandler.ts` — path may differ; pick a clean one) returning a plain-text reply (no Markdown, no inline keyboard) with the field set in ADR-021@0.1.0 §`/diag` command contract:
  - `version`, `build_sha`, `started_at_utc`, `telegram_user_id`, `last_event_id`, `last_error_id`, `db_ping_ms`, `llm_ping_ms_default`, `llm_ping_ms_voice`, `webhook_last_error_date`, `webhook_last_error_message`, `redaction_version`.
- All field values pass through the existing `redactPii` allowlist (TKT-015@0.1.0 + TKT-026@0.1.0); never include raw user text, raw secrets, raw provider responses.
- `last_event_id` queries the most recent `metric_events` row for the requesting user with `outcome = success` in the last 24 h.
- `last_error_id` queries the most recent `metric_events` row for the requesting user with `outcome IN ('provider_failure','validation_blocked','budget_blocked')` in the last 24 h.
- `db_ping_ms`: `SELECT 1` round-trip.
- `llm_ping_ms_default`: cheapest `chatCompletion` against `kbju.modality_router_classifier` (1-token "ok" prompt). Uses ADR-024@0.1.0 registry; if the alias is missing or the provider unreachable, return literal "n/a".
- `llm_ping_ms_voice`: `kbju.voice_transcription` against a 1-second audio probe (project-bundled fixture); "n/a" if absent.
- `webhook_last_error_*`: cached background poll of `getWebhookInfo` every 60 s; the handler reads the cache.
- `build_sha`: baked into the image at Dockerfile build time as a `LABEL` or `ARG` derived from `git rev-parse HEAD`; the handler reads it from a known env var (e.g. `BUILD_SHA`) the Dockerfile sets via `--build-arg`.
- New metric `kbju_diag_invocations_total{telegram_user_id_hashed}` (hashed, not raw) for observability of how often users invoke `/diag`.
- Unit tests at ≥80% coverage: redaction allowlist enforcement, missing-data graceful degradation ("none" / "n/a"), allowlist gate (non-allowlisted user gets the standard "not allowed" copy), webhook cache freshness boundary.

## 3. NOT In Scope
- Operator-side `scripts/diag-bundle.sh` — TKT-045@0.1.0 owns.
- GitHub issue template + `docs/incidents/` — TKT-046@0.1.0 owns.
- Adding alerting on critical-severity log events — out of scope per ADR-021@0.1.0 §Follow-up.
- Allowing non-allowlisted users to invoke `/diag` (security regression).
- Running the diag LLM pings on every Telegram message (only when `/diag` is invoked).

## 4. Inputs
- ARCH-001@0.7.0 §3.1 C1 Entrypoint (where the routing lives)
- ADR-021@0.1.0 (full `/diag` contract)
- ADR-024@0.1.0 (`kbju.modality_router_classifier` and `kbju.voice_transcription` aliases)
- TKT-015@0.1.0 (the redactPii allowlist)
- TKT-026@0.1.0 (PRD-003@0.1.3 redaction extension)
- TKT-033@0.1.0 (registry — depends_on; `/diag` consumes it for the LLM pings)

## 5. Outputs
- [ ] `src/incident/diagHandler.ts` (new).
- [ ] C1 routing extended to dispatch `/diag` to the new handler.
- [ ] `src/observability/webhookInfoCache.ts` (or wherever C10 sits) implementing the 60-s cached `getWebhookInfo` poll.
- [ ] Dockerfile (TKT-038@0.1.0 outputs) takes a `BUILD_SHA` build arg and exports it as an env var; install.sh / docker-compose.yml passes the current `git rev-parse HEAD` at build time.
- [ ] `tests/incident/diagHandler.test.ts` covering the redaction, missing-data, allowlist-gate, and cache-boundary cases.

## 6. Acceptance Criteria
- [ ] `npm test` passes.
- [ ] `npm run lint` clean. `npm run typecheck` clean.
- [ ] Allowlisted user invokes `/diag` → bot replies with the plain-text block; every field present, no Markdown, no raw user text.
- [ ] Non-allowlisted user invokes `/diag` → bot returns the existing "Извините, бот пока в закрытом тестировании." copy.
- [ ] When `kbju.modality_router_classifier` provider is unreachable, `llm_ping_ms_default: n/a` and the rest of the block still renders.
- [ ] `webhook_last_error_*` updates within ≤60 s of a real error (asserted via mocked `getWebhookInfo`).

## 7. Constraints
- Do NOT add new runtime dependencies.
- Do NOT log raw `BUILD_SHA` as a secret — it's a public commit SHA, but treat the `LABEL` as semi-public per usual hygiene.
- Do NOT make a fresh `getWebhookInfo` call per `/diag` invocation; the 60-s cache is the contract.
- The handler returns the block as a single `sendMessage` payload, no Markdown, no `parse_mode`.
- The `kbju_diag_invocations_total` metric label MUST hash the Telegram user ID (e.g. SHA256 of `user_id` salted with `request_id`); raw IDs are forbidden in metric labels per ARCH-001@0.7.0 §8.2.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->
- 2026-05-26T00:00:00Z opencode-executor: started
- 2026-05-26T03:30:00Z opencode-executor: in_review; tests 47 pass; lint clean; typecheck clean
