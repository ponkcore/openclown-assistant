---
id: RV-CODE-019
type: code_review
target_pr: "PR #29"
ticket_ref: TKT-035@0.1.0
status: in_review
created: 2026-05-26
---

# Code Review — PR #29 (TKT-035@0.1.0)

## Summary
The executor migrated 5 extractor manifests (`config/{water,workout-text,workout-photo,mood,modality-router-classifier}.json`) from inline `defaultModel`/`fallbackModel`/`emergencyModel` triples to `call_type` aliases pointing at `config/llm.json` per ADR-024@0.1.0. The consuming `src/` extractors (C16, C17, C19, C20) now resolve through `registry.resolve()` instead of reading model config from the manifest. The photo adapter (C7) was similarly updated to use `registry.resolve()` for its `call_type`, though it continues to use a pre-existing raw `fetch()` path for the actual vision HTTP call. Logger interfaces in water and mood modules had stale `omniRouteBaseUrl`/`omniRouteApiKey` parameters cleaned up. A smoke test validates all 5 migrated manifests resolve correctly against a fixture `config/llm.json`. CI reports 1333 tests pass, typecheck clean, lint clean, with 2 pre-existing failures unrelated to this PR.

## Verdict
- [ ] pass
- [x] pass_with_changes
- [ ] fail

One-sentence justification: All Acceptance Criteria are verifiably met and the hard cut-over from inline model triples to call-type aliases is clean, but there are two Medium findings (photo adapter bypass of centralized Stall Watchdog/kill-switch, and dead-code `VISION_MODEL_ALIAS` constant) that should be addressed before merge or backlogged.
Recommendation to PO: approve with changes — Mediums can be fixed in a follow-up or this iteration; no High findings.

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT-035@0.1.0 §5 Outputs — all 27 files are either explicitly listed in §5 (manifests, consuming src modules, tests) or are necessary cleanup paths (logger.ts files removing stale omniRoute params, router test goldens updated for call_type).
- [x] No changes to TKT-035@0.1.0 §3 NOT-In-Scope items — no new call-type aliases added; prompts, JSON schemas, and `modality-router.json` keyword chains unchanged; modality-router-classifier preserved; no hot-reload changes to manifests.
- [x] No new runtime dependencies beyond TKT-035@0.1.0 §7 Constraints allowlist — `package.json` and `package-lock.json` unchanged.
- [x] All Acceptance Criteria from TKT-035@0.1.0 §6 are verifiably satisfied (file:line or test name cited) — see AC breakdown below.
- [x] CI green (lint, typecheck, tests, coverage) — executor reports clean typecheck, clean lint, 1333/1335 tests pass (2 pre-existing failures — see F-M3).
- [x] Definition of Done complete — ACs met, PR opened with TKT link, §10 Execution Log filled, frontmatter flip in separate commit `96888cb`.
- [x] Ticket frontmatter `status: in_review` in a separate commit — commit `96888cb` changes ONLY `docs/tickets/TKT-035-*.md`.

### Acceptance Criteria detailed verification

| AC | Status | Evidence |
|----|--------|----------|
| `npm test` passes | ✅ | Executor log: "1333 tests pass (2 pre-existing failures)" |
| `npm run lint` clean, `npm run typecheck` clean | ✅ | Executor log: "typecheck clean; lint clean" |
| No `model:` hard-coded IDs outside llm.json/llm.example.json | ✅ | `grep -rn '"model"' config/` returns ONLY `config/llm.example.json` lines |
| Every `call_type` is from ADR-024@0.1.0 canonical list | ✅ | `water-extractor.json:2` `"kbju.water_volume_extractor"`, `workout-extractor-text.json:2` `"kbju.workout_extractor"`, `workout-extractor-photo.json:2` `"kbju.workout_extractor"`, `mood-extractor.json:2` `"kbju.mood_inferrer"`, `modality-router-classifier.json:2` `"kbju.modality_router_classifier"` — all match ADR-024@0.1.0 §Schema example |
| Smoke test: load manifests, resolve call_types | ✅ | `tests/llm/call-type-resolution.test.ts:109-127` validates all 5 manifests resolve against fixture `config/llm.json`; `tests/llm/call-type-resolution.test.ts:142-158` validates all ADR-024@0.1.0 aliases resolve |

## Findings

### High (blocking)
(None)

### Medium
- **F-M1 (`src/photo/photoRecognitionAdapter.ts:362`): Raw `fetch()` bypasses centralized llmClient protections.** The `attemptVisionCall()` function uses raw `fetch()` directly (line 362–373) instead of `llmClient.vision()`. This is a **pre-existing** pattern that predates this PR (main-branch photo adapter also used raw fetch), but now that the adapter resolves its provider/model via `registry.resolve()`, it should also route the HTTP call through `llmClient.vision()` to inherit C13 Stall Watchdog wrapping (ADR-012@0.1.0), kill-switch checks, and centralized `redactPii`/`isPromptOrResponseSafeForLogging` guards. The photo adapter has genuine bespoke retry behaviour (latency-budget-aware with `VISION_LATENCY_BUDGET_MS` check at line 292) that the standard `vision()` helper's `retryOnceChat` does not replicate, so migration is non-trivial. This is not a regression from this PR, but it is a layering gap that should be tracked. *Suggested remediation:* Backlog a ticket to migrate `attemptVisionCall()` to use `llmClient.vision()` (if the standard retry is sufficient) or to extend `vision()` with a `retryConfig` option that supports latency-budget-aware retry.
- **F-M2 (`src/photo/types.ts:8`): Dead-code `VISION_MODEL_ALIAS` constant.** `export const VISION_MODEL_ALIAS = "qwen3-vl-30b-a3b-instruct"` is no longer imported by any module (confirmed via `grep -rn "VISION_MODEL_ALIAS" src/ tests/` — only the definition at `src/photo/types.ts:8` appears). This was the old hard-coded model string that should have been removed when the migration replaced it with `call_type`-based resolution. Its presence misleads future maintainers into thinking a hard-coded model is still in play. *Suggested remediation:* Remove the dead constant from `src/photo/types.ts`.
- **F-M3 (CI): 2 pre-existing test failures.** The executor's execution log notes "2 pre-existing failures" in both commits without identifying which tests fail. These are not regressions from this PR, but they add noise to CI and should be tracked. *Suggested remediation:* Document the failing tests in a backlog item for the maintainer.

### Low
- **F-L1 (`docs/tickets/TKT-035-*.md:76`): Execution log does not name the 2 pre-existing failures.** Knowing which tests fail (flaky or known-issue) would help the orchestrator distinguish signal from noise. *Suggested remediation:* In future execution logs, include the test names of pre-existing failures.

## Red-team probes (Reviewer must address each)
- **Error paths (Telegram/OpenFoodFacts/Whisper API failure, DB lock, LLM timeout):** No new error paths introduced. The migrated extractors (water, mood, workout, router-classifier) already handled LLM failures through try/catch blocks around `chatCompletion()`; the migration from `callOmniRoute` to `chatCompletion` preserves the same fallback-to-failure-result pattern (e.g. `src/modality/water/extractVolume.ts` returns `modelTier: "failure"` with volumeMl=0). The photo adapter's raw `fetch()` error handling (`src/photo/photoRecognitionAdapter.ts:377-399`) distinguishes transient (5xx/429) from permanent errors, but does not benefit from llmClient's standardized `ChatCompletionResult.outcome` taxonomy — this is covered by F-M1.
- **Concurrency (two messages from the same user simultaneously):** No new concurrency concerns. The extractors are stateless functions called per-message. `registry.resolve()` is a read-only lookup into an in-memory `Map` protected by the hot-reload `fs.watchFile` pattern; the registry's reload path (`_resetLegacyWarned`) is idempotent. No new shared mutable state.
- **Input validation (malformed voice, corrupt photo, huge text, unicode):** No regression. The JSON-schema validators (e.g. `parseVolumeOutput`, `parseMoodOutput`, `parseWorkoutOutput`, `parseClassifierOutput`) remain unchanged. The registry's `resolve()` function throws `RegistryError` on unknown aliases, which callers catch (e.g. `src/photo/photoRecognitionAdapter.ts:184-208` catches the registry-resolve error and emits `registry_resolve_failed`).
- **Prompt injection:** No new risk. All extractor prompts are unchanged. The `call_type` values are operator-controlled JSON keys, not user-supplied strings. User messages still pass through the same `systemPromptTemplate` substitution path as before.
- **Secrets:** No credentials committed or leaked. All `api_key_env` references are environment variable names (not values). The migrated manifests contain no `api_key_env` field. The registry's `getApiKey()` reads `process.env` at call time.
- **Observability:** Improved. The extractors now emit `call_type` in log events (e.g. `src/photo/photoRecognitionAdapter.ts:199` logs `call_type: config.call_type` on registry error, line 270 logs it on provider call start). A 3am operator can trace which `call_type` alias was resolved, then look up the actual model in `config/llm.json`. The stale `omniRouteBaseUrl`/`omniRouteApiKey` parameters have been removed from logger interfaces, reducing operator confusion about where model config lives.
- **Rollback:** Straightforward. Reverting this PR restores the old manifest format with `defaultModel`/`fallbackModel`/`emergencyModel` and the old extractor code calling `callOmniRoute` with hard-coded model IDs. The registry (`src/llm/registry.ts`) is unchanged by this PR (no diff on `src/llm/registry.ts`). No schema migration or database change required.
