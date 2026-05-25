---
id: RV-CODE-018
type: code_review
target_pr: "https://github.com/code-yeongyu/openclown-assistant/pull/28"
ticket_ref: TKT-033@0.1.0
status: in_review
created: 2026-05-25
---

# Code Review — PR #28 (TKT-033)

## Summary
The refactor to provider-agnostic LLM client + model registry is well-structured: `registry.ts` correctly mirrors the ADR-013@0.1.0 allowlist hot-reload pattern, `llmClient.ts` cleanly delegates provider resolution to the registry, tests cover all six error modes and both ACs for hot-reload and secret-free logging. However, `src/shared/config.ts` still mandates the legacy `OMNIROUTE_*` / `FIREWORKS_API_KEY` env vars at boot, which means operators who set only the new `LLM_*` names cannot boot the application — a direct violation of §6 AC #3.

## Verdict
- [ ] pass
- [ ] pass_with_changes
- [x] fail

One-sentence justification: `config.ts` blocks boot when only new `LLM_*` env-var names are set, violating §6 AC #3 — the application must reach the registry/backward-compat layer to satisfy the AC.

Recommendation to PO: **iterate** — dispatch Executor to relax `config.ts`'s `REQUIRED_CONFIG_NAMES` (accept `LLM_*` names as alternatives for `OMNIROUTE_*` / `FIREWORKS_API_KEY`), then re-review.

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT §5 Outputs (verified: `src/llm/{registry,llmClient,omniRouteClient}.ts`, `config/llm.example.json`, `.env.example`, `docker-compose.yml`, `infra/omniroute/README.md` deleted, `tests/llm/{registry,llmClient}.test.ts`, TKT frontmatter `§10`). Note: `.gitignore` already had `config/llm.json` on main; no change needed.
- [x] No changes to TKT §3 NOT-In-Scope items (voice, extractor migration, new call-type aliases, firewall algorithm, Fireworks secret removal, ArchSpec prose renames — none touched).
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist (only `node:fs`, `node:path`, existing project modules; zero new `package.json` entries).
- [ ] All Acceptance Criteria from TKT §6 are verifiably satisfied — **FAILED**: AC #3 (new-name-only boot) is violated by `config.ts` (see F-H1).
- [ ] CI green (lint, typecheck, tests, coverage) — Could not run locally (no `npm`); executor §10 claims `npm run lint` clean, `npm run typecheck` clean, 1333 tests pass. Defer to CI on PR open.
- [x] Definition of Done complete — ACs, PR link, no TODO/FIXME, §10 Execution Log filled, `status: in_review` in separate commit (f8f98f9).
- [x] Ticket frontmatter `status: in_review` in a separate commit — commit f8f98f9 is the status+log update, bb65396 is the code; two-commit split confirmed.

## Findings

### High (blocking)

- **F-H1 (`src/shared/config.ts:16-29`): Boot blocks new-name-only operators — §6 AC #3 violation.**
  `REQUIRED_CONFIG_NAMES` still lists `OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY`, and `FIREWORKS_API_KEY` as mandatory. `parseConfig()` (line 46) throws `ConfigError` if any are missing. When an operator sets only `LLM_OMNIROUTE_BASE_URL` / `LLM_OMNIROUTE_API_KEY` / `LLM_FIREWORKS_API_KEY` (without the legacy equivalents), `src/main.ts:278` → `parseConfig()` → boot fails. The backward-compat layer in `registry.ts:89-111` (`resolveEnvVar`) correctly handles the fallback, but the application never reaches it. The docker-compose forward also leaves `OMNIROUTE_API_KEY` empty when only `LLM_OMNIROUTE_API_KEY` is set. This violates §6 AC #3 ("setting `LLM_OMNIROUTE_API_KEY` AND `LLM_OMNIROUTE_BASE_URL` works without the deprecation warning"). ARCH-001@0.7.1 §9.1 says "New deploys MUST use the `LLM_*` names" — impossible without this fix.
  - *Responsible role:* Executor.
  - *Suggested remediation:* Modify `parseConfig` to accept `LLM_OMNIROUTE_BASE_URL`/`LLM_OMNIROUTE_API_KEY`/`LLM_FIREWORKS_API_KEY` as alternatives for the legacy names (read new first, fall back to legacy, error only if neither is present). If `config.ts` is deemed outside §5 Outputs strict scope, escalate to Architect-consult to add it as a follow-up patch; but practically the executor must either modify `config.ts` or the AC cannot be met. The ticket already authorised `.env.example` and env-loading layer changes — relaxing `config.ts` is the moral equivalent.

### Medium

*none*

### Low

- **F-L1 (`src/llm/omniRouteClient.ts:142-145`): Temporary `process.env` mutation in backward-compat adapter.**
  The `callOmniRoute` adapter temporarily assigns `process.env[apiKeyEnvName] = config.apiKey` to inject the API key for the registry's `resolveEnvVar`. While a `finally` block on lines 185-191 restores the previous value, two concurrent calls to the legacy path would race on the global `process.env` object. Practically low risk for this single-user chatbot, but worth noting for the `omniRouteClient.ts` deprecation cleanup in v0.8.0.
- **F-L2 (`config/llm.example.json:19`): `kbju.mood_inferrer` uses model name `"executor"`.**
  The model string `"accounts/fireworks/models/executor"` appears to be a humorous/placeholder name, not a real Fireworks model. Since Constraint #6 says "the application MUST NOT refuse a different model in the registry" and this is only an example config (operators override it), this is cosmetic. Consider using a real model name from ADR-018@0.1.0.

## Red-team probes (Reviewer must address each)
- **Error paths — Telegram/OpenFoodFacts/Whisper/OmniRoute/DB failure:** The registry surfaces errors via typed `RegistryError` codes (`missing_alias`, `dangling_provider`, `missing_env_var`, `registry_empty`, `registry_not_initialized`). `llmClient.chatCompletion` catches all registry errors returning `outcome: "registry_error"`, and all fetch errors returning `outcome: "provider_failure"`. Retries (HTTP 5xx/429/timeout) and stall detection are preserved from the old `omniRouteClient.ts` logic. **No concern.**
- **Concurrency — two messages from same/different users:** The registry is a singleton with no internal mutation during `resolve()` calls — read-only after load. `loadFile()` replaces the snapshot atomically (assigns new object). Two concurrent `resolve()` calls are safe. Two concurrent hot-reloads are a last-write-wins race on the in-memory snapshot, but the file is always re-parsed from disk. The backward-compat adapter's `process.env` mutation (F-L1) is the only minor concurrency concern. **Low concern (F-L1).**
- **Input validation — malformed voice / corrupt photo / unicode edges:** The LLM client is transport-layer only and does not validate payload content. Payload validation remains the caller's responsibility (unchanged from the old `omniRouteClient.ts`). **No concern — unchanged.**
- **Prompt injection — does any external string reach LLM unsanitised:** The `buildMealParsingSystemPrompt`/`buildMealParsingUserContent` functions in `omniRouteClient.ts:197-214` remain unchanged — they embed user text inside a JSON string value with the pre-existing "DATA ONLY" instruction. The `redactPii` filter is applied on all log emits via `buildRedactedEvent`. **No regression; existing posture preserved.**
- **Secrets — credential committed, logged, or leaked:** `registry.test.ts:311-322` verifies no raw API key in logs. `llmClient.test.ts:262-292` ("no raw API key appears in any log line") verifies the client does not leak the key to `ctx.logger`. The registry's `resolveEnvVar` emits env-var *names* only (e.g., `"kbju_llm_legacy_env_in_use{var=\"LLM_OMNIROUTE_API_KEY\"}"`). `.env.example` documents variable names only with empty values. **No concern.**
- **Observability — 3am operator debug from logs alone:** The registry emits `kbju_llm_registry_reload` (success) and `kbju_llm_registry_reload_failed{outcome,source}` metrics. `llmClient` emits `provider_call_finished` events with `call_type`, `provider_alias`, `model_alias`, and `outcome` (success/provider_failure/budget_blocked/stall_detected/registry_error). Cost tracking via `spendTracker.recordCostAndCheckBudget` is preserved. The C13 `llm_call_stalled` event is preserved with provider/model/tenant/retry_count. **No concern — adequate for incident response.**
- **Rollback — if this PR breaks production:** The backward-compat adapter in `omniRouteClient.ts` preserves the old `callOmniRoute` API surface; all callers (`extractScore`, `router-classifier`, `extractVolume`, `kbjuEstimator`, `extractWorkout`, `summaryScheduler`) still import from `omniRouteClient.js`. A revert of this PR restores the old direct-OmniRoute client. **Rollback is straightforward.**
- **Tenant isolation — per-user_id boundary (ADR-001@0.1.0):** The `llmClient.chatCompletion` receives `ctx.userId` and passes it to the StallWatchdog constructor for tenant labelling. The registry does not deal with user data. **No regression.**
