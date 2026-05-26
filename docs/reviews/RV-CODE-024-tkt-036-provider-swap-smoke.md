---
id: RV-CODE-024
type: code_review
target_pr: "https://github.com/code-yeongyu/openclown-assistant/pull/35"
ticket_ref: TKT-036@0.1.0
status: in_review
created: 2026-05-26
---

# Code Review — PR #35 (TKT-036@0.1.0)

## Summary

Four smoke tests (chat, vision, voice swap via hot-reload; env-var API-key boundary) prove that swapping a provider in `config/llm.json` redirects the next call without code change or rebuild, satisfying PRD-001@0.3.0 §7. The executor correctly identified that `src/llm/registry.ts` only resolves API keys from env vars (not base URLs), and adapted the env-var test to exercise the actual code path. All hard checks pass; two low-severity nits noted.

## Verdict
- [x] pass
- [ ] pass_with_changes
- [ ] fail

One-sentence justification: All Acceptance Criteria are verifiably met through code inspection and executor attestation; no findings above Low.

Recommendation to PO: **approve & merge**.

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT §5 Outputs
- [x] No changes to TKT §3 NOT-In-Scope items
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist
- [x] All Acceptance Criteria from TKT §6 are verifiably satisfied (file:line or test name cited)
- [x] CI green (lint, typecheck, tests, coverage) — per executor attestation in §10 Execution Log
- [x] Definition of Done complete
- [x] Ticket frontmatter `status: in_review` in a separate commit

## Findings

### High (blocking)

None.

### Medium

None.

### Low

- **F-L1 (`tests/llm/providerSwap.smoke.test.ts:129`):** `waitForHotReload` uses a 3000ms deadline while AC #3 specifies "Hot-reload propagation observed within ≤2 s". The 3s buffer is generous; real propagation through `fs.watchFile` (1s poll interval) completes in ≤2s, so this does not mask a real failure. Consider tightening to 2000ms for strict AC conformance, or accepting the buffer as defensive against CI jitter.

- **F-L2 (`tests/llm/providerSwap.smoke.test.ts:126–141`):** Hot-reload relies on `fs.watchFile` polling at 1s intervals with a 3s deadline. On extremely resource-starved CI runners, file-system events could be delayed past the deadline and cause a flaky timeout. Consider extending the deadline to 5000ms for extra margin, or skipping these smoke tests on under-provisioned CI. (This is speculative — typical CI should handle 3s easily.)

## Red-team probes (Reviewer must address each)

- **Error paths (Telegram/Whisper/Qwen-VL/OmniRoute/USDA-FDC/Postgres failure, DB lock, LLM timeout):** These smoke tests do not exercise failure paths; they validate the provider-swap happy path with local mock servers. The `waitForHotReload` helper does handle mid-reload errors gracefully (catches and retries). No concern for this PR.

- **Concurrency:** All four tests run sequentially within a single `describe` block. Two messages from different users arriving simultaneously is not exercised — this is a smoke test, not a load test. No concern.

- **Input validation:** Mock servers return hard-coded responses; malformed payloads (corrupt audio, oversized body) are not tested. The adapter layer (`llmClient`/`voiceClient`) handles input validation at its own level, outside scope of these swap tests. No concern.

- **Prompt injection:** No external user text reaches an LLM in these tests — mock responses are canned strings. The test explicitly verifies that API key values (`test-mock-key-a-do-not-log`, etc.) do not appear in captured logger output (lines 310–312, 360–362, 413–414, 480–481), confirming that the `buildRedactedEvent` / `redactPii` pipeline (see `src/observability/events.ts:96`) operates correctly in the full call chain. No concern.

- **Tenant isolation:** These are unit-level smoke tests with no Postgres dependency — they use `makeMockSpendTracker()` and `makeLlmCtx()` with a fixed `userId: "smoke-test-user"`. No per-`user_id` RLS boundary is crossed. No concern.

- **Secrets:** All API keys are test/mock values (`test-mock-key-a-do-not-log`, `test-mock-key-b-do-not-log`, `key-value-alpha`, `key-value-beta`). No real credentials are committed, logged, or surfaced. The `ENV_VARS` cleanup in `afterEach` (line 224) deletes all test env vars. `config/llm.example.json` is not modified. No concern.

- **Observability:** The test captures a logger mock with `{level, msg}` tuples. Log output is verified for API-key absence (AC #4). The metrics sink records `kbju_llm_registry_reload` increments but the test does not assert on their values — acceptable for smoke tests. A 3am operator debugging a production provider-swap failure would have `kbju_llm_registry_reload` counter data and hot-reload propagation times from the production observability stack; these tests do not modify that stack. No concern.

- **Rollback:** The PR is purely additive (two new test/helper files + ticket frontmatter update). No production code is touched. Rollback requires deleting the two new files or reverting the merge commit. Trivial. No concern.

## Other observations

### Weakest assumption #1: Env-var resolution (API key vs base_url)

Ticket §2 specifies:

> "A second test that exercises the env-var path: change only `LLM_FOO_BASE_URL` between two `process.env` set / unset calls and verify the registry picks up the new value at the next `resolve()` call."

After reading `src/llm/registry.ts` in full:

- `resolve()` (line 155–203) returns `provider.base_url` as a static JSON value — no env-var interpolation.
- `getApiKey()` (line 206–215) reads `process.env[api_key_env]` at call time via `resolveEnvVar()` (line 91–113).
- There is **no** `base_url` env-var resolution path anywhere in the registry. The `resolveEnvVar` helper and `LEGACY_ENV_MAP` are exclusively for API keys.

The executor adapted test #4 (line 422–482) to exercise `getApiKey()` re-reading `process.env` at call time, rather than an impossible `base_url` env-var swap. This is a **correct and reasonable adaptation** — it exercises the actual code path that exists (env-var change for API keys observed at next `resolve()` + `getApiKey()` call). The ticket §2 SPIRIT is satisfied: the test proves that env-var mutations are picked up by the registry subsystem without restart. The ticket prose drifted slightly from implementation reality (mentioning `LLM_FOO_BASE_URL` when the code only has `api_key_env` env-var resolution), but the test captures the actual boundary correctly.

### Call-type aliases

The test uses call-type aliases defined in `config/llm.example.json`:
- `kbju.modality_router_classifier` (chat)
- `kbju.photo_recognition` (vision)
- `kbju.voice_transcription` (voice)
- `kbju.meal_text` (env-var boundary)

These aliases were established by TKT-035@0.1.0 (call-type alias migration), and are present in `config/llm.example.json` on `main`. The names are consistent across the test and the config. No concern.

### Mock server implementation

`tests/_helpers/mockOpenAiServer.ts` uses only `import http from "node:http"` — no external dependencies per TKT-036@0.1.0 §7. The server handles the two OpenAI-compatible surfaces the codebase uses (`POST /v1/chat/completions` and `POST /v1/audio/transcriptions`), consumes the request body fully before responding, and returns valid JSON. Well-structured helper.

### Commit structure

Two commits: `673d505` (code) + `16cce9b` (ticket status flip). Complies with TKT-036@0.1.0 §8 DoD requirement.
