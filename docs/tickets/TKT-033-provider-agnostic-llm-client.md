---
id: TKT-033
title: 'Provider-agnostic LLM client + model registry + LLM_* env-var rename'
status: ready
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: C23 LLM Gateway / src/llm
depends_on: []
blocks:
- TKT-034@0.1.0
- TKT-035@0.1.0
- TKT-036@0.1.0
estimate: L
created: 2026-05-25
updated: 2026-05-25
---

# TKT-033: Provider-agnostic LLM client + model registry + LLM_* env-var rename

## 1. Goal
Refactor `src/llm/omniRouteClient.ts` into a generic `src/llm/llmClient.ts` driven by a hot-reloadable `config/llm.json` model registry per ADR-022@0.1.0 and ADR-024@0.1.0.

## 2. In Scope
- New module `src/llm/registry.ts` exporting `resolve(callType: string)` and `reload()` per ADR-024@0.1.0 §Lookup contract; `fs.watchFile` on `config/llm.json` mirroring the C15 Allowlist hot-reload pattern (ADR-013@0.1.0).
- New module `src/llm/llmClient.ts` exporting `chatCompletion(opts)` and `vision(opts)` against the OpenAI HTTP surface (`POST /v1/chat/completions`); accepts `{call_type, messages, response_format?, max_tokens?, temperature?, image_url?}` and reads `(base_url, api_key, model)` from the registry at call time.
- Refactor `src/llm/omniRouteClient.ts` (existing): re-export the new client surface OR delete the file and update its callers; the executor picks whichever is cleaner. The contract shape (request → response types) does NOT change for callers; only the indirection layer and the env-var names change.
- New `config/llm.example.json` seeding the v0.1 defaults from ADR-018@0.1.0 (gpt-oss-120b for meal text + summary; per-site picks for C16/C17/C18/C19/C20; whisper-v3-turbo for voice; qwen3-vl-30b-a3b for photo recognition).
- Env-var rename: `OMNIROUTE_BASE_URL` → `LLM_OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY` → `LLM_OMNIROUTE_API_KEY`, `FIREWORKS_API_KEY` → `LLM_FIREWORKS_API_KEY`. Add backward-compat aliases (registry reads the new name, falls back to the old one if unset, emits one-shot `kbju_llm_legacy_env_in_use{var}` warn-level log per ADR-024@0.1.0 §Backward compatibility).
- Update `.env.example` to declare the new `LLM_*` names, mark old names DEPRECATED with a removal target of `v0.8.0`.
- Update `docker-compose.yml` `kbju-sidecar.environment` block to pass through the new `LLM_*` names AND the old `OMNIROUTE_*` / `FIREWORKS_API_KEY` names for one minor version (so existing `.env.production` files keep working until v0.8.0 deprecation removal).
- Reframe `infra/omniroute/README.md` → delete it; the new operator guide at `docs/architecture/llm-providers.md` (Architect-authored under ARCH-001@0.7.0) is its replacement.
- Add `config/llm.example.json` to git; add `config/llm.json` to `.gitignore` (real config is operator-authored, not committed; mirrors the `config/allowlist.json` pattern).
- C13 Stall Watchdog (`src/observability/stallWatchdog.ts` or wherever it lives) wraps the new `llmClient.chatCompletion` call site identically to today; one place to update.
- Unit tests at ≥80% coverage for `registry.ts` and `llmClient.ts`: schema validation, missing-alias error, dangling-provider error, missing env-var error, hot-reload happy path, hot-reload failure-keeps-old-snapshot path.

## 3. NOT In Scope
- Voice transcription client refactor — TKT-034@0.1.0 owns; this ticket only handles `chat.completions` + vision.
- Migrating `config/water-extractor.json`, `config/workout-extractor-*.json`, `config/mood-extractor.json`, `config/modality-router-classifier.json` to call-type aliases — TKT-035@0.1.0.
- Adding a new call-type alias not already in ADR-024@0.1.0 §Schema example.
- Removing the legacy `OMNIROUTE_*` env-var alias (deferred to v0.8.0).
- Changing C13 Stall Watchdog algorithm (ADR-012@0.1.0 unchanged).
- Removing `FIREWORKS_API_KEY` from the secret list — kept as a runtime fallback name; just renamed.
- ArchSpec `OmniRoute` reference renames in the prose (Architect-zone work, already done in ARCH-001@0.7.0).

## 4. Inputs
- ARCH-001@0.7.0 §3.23 (C23 LLM Gateway), §6 External Interfaces, §7 Tech Stack Decisions, §9.1 Secrets Management
- ADR-022@0.1.0 (LLM provider-agnostic abstraction; defines `chatCompletion` + `vision` surface)
- ADR-024@0.1.0 (model registry; full schema, lookup contract, hot-reload behaviour)
- ADR-013@0.1.0 (analogue: `config/allowlist.json` hot-reload — TS pattern to mirror)
- ADR-018@0.1.0 (illustrative defaults to seed `config/llm.example.json`)
- ADR-002@0.1.0 (superseded; preserved for empirical claims, not for code)
- Existing `src/llm/omniRouteClient.ts` (the file being refactored; do not assume its current shape — read it before designing the diff)
- Existing `src/observability/stallWatchdog.ts` (the wrapper over the LLM client; verify it doesn't reach into provider-specific internals)
- Existing `src/shared/config.ts` and `.env.example` (env-var declarations live here)
- `docker-compose.yml` `kbju-sidecar.environment` block

## 5. Outputs
- [ ] `src/llm/registry.ts` (new) with `resolve()` / `reload()`.
- [ ] `src/llm/llmClient.ts` (new) with `chatCompletion()` / `vision()`.
- [ ] `src/llm/omniRouteClient.ts` (existing) refactored or deleted; callers updated.
- [ ] `config/llm.example.json` (new) seeding v0.1 defaults from ADR-018@0.1.0.
- [ ] `config/llm.json` added to `.gitignore`.
- [ ] `.env.example` updated with `LLM_*` names; legacy `OMNIROUTE_*` names marked DEPRECATED.
- [ ] `docker-compose.yml` updated to pass through both the new and legacy env-var names.
- [ ] `infra/omniroute/README.md` deleted (replaced by `docs/architecture/llm-providers.md`).
- [ ] `tests/llm/registry.test.ts` covering all six failure modes from §2.
- [ ] `tests/llm/llmClient.test.ts` covering chat + vision happy paths and `api_key_env` resolution at call time.

## 6. Acceptance Criteria
- [ ] `npm test` passes (existing tests + new ones).
- [ ] `npm run lint` clean. `npm run typecheck` clean (strict).
- [ ] `config/llm.example.json` is valid JSON and validates against the ADR-024@0.1.0 schema (test asserts every required key, every `call_types[*].provider` resolves to a `providers[*]` entry).
- [ ] Setting only `OMNIROUTE_API_KEY` and `OMNIROUTE_BASE_URL` (legacy) in env still produces a working LLM call AND emits a one-shot `kbju_llm_legacy_env_in_use` log; setting `LLM_OMNIROUTE_API_KEY` AND `LLM_OMNIROUTE_BASE_URL` works without the deprecation warning.
- [ ] Hot-reload test: write `config/llm.json` to a temp dir, call `resolve()`, edit the file (atomic rename), wait ≤2 s, call `resolve()` again, observe new value.
- [ ] Hot-reload failure test: write a malformed JSON to the file; the in-memory snapshot remains the old value; `kbju_llm_registry_reload_failed{reason}` metric increments.
- [ ] No raw API key value appears in any log line in any test (assert on `provider_id` and `api_key_env` *names* only).

## 7. Constraints
- Do NOT add new runtime dependencies beyond what's already in `package.json` for HTTP / JSON parsing. The OpenAI HTTP surface needs only `fetch`.
- Do NOT introduce a per-provider TS adapter file (rejected option in ADR-022@0.1.0).
- Do NOT hard-code provider names in `llmClient.ts`; the client takes `call_type` and asks the registry.
- Use the existing `redactPii` allowlist on any log emit involving `provider_id` / `model` / call payload metadata; do not let raw prompts or raw responses reach `ctx.log`.
- C13 Stall Watchdog wrapping point MUST be `llmClient.chatCompletion` (one place); if the executor finds the old wrapping was in `omniRouteClient.ts`, move the wrapper accordingly.
- Maintain the §13 Q5 invariant from ARCH-001@0.6.2: model identity is an orchestrator runtime concern, not an ArchSpec lock. The example config carries ADR-018@0.1.0 picks but the application MUST NOT refuse a different model in the registry.
- File mode on `config/llm.json` MUST be `0644` (operator-readable, world-readable for compose mount; same as `config/allowlist.json`).

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body.
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->
