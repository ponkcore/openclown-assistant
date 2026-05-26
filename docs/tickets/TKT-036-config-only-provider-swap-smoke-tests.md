---
id: TKT-036
title: 'Smoke tests proving config-only provider swap (no rebuild)'
status: done
arch_ref: ARCH-001@0.7.2
prd_ref: PRD-001@0.3.0
component: Test infrastructure / C23 LLM Gateway
depends_on:
- TKT-033@0.1.0
- TKT-034@0.1.0
- TKT-035@0.1.0
blocks: []
estimate: S
created: 2026-05-25
updated: 2026-05-26
closed_at: 2026-05-26
closed_by: orchestrator (PO-delegated)
review_ref: RV-CODE-024
---

# TKT-036: Smoke tests proving config-only provider swap (no rebuild)

## 1. Goal
Add an end-to-end smoke test that proves swapping a provider in `config/llm.json` and / or its referenced `LLM_*` env var redirects the next call without code change or rebuild, satisfying PRD-001@0.3.0 §7.

## 2. In Scope
- New `tests/llm/providerSwap.smoke.test.ts` (path may differ if a project convention exists — pick one and stick to it):
  - Boot a mock OpenAI-compatible server "A" on port X with a known response.
  - Boot a mock OpenAI-compatible server "B" on port Y with a different known response.
  - Write `config/llm.json` pointing `kbju.modality_router_classifier` at server A.
  - Call `llmClient.chatCompletion({call_type: "kbju.modality_router_classifier", ...})`; assert response matches A.
  - Atomically rewrite `config/llm.json` to point the same alias at server B.
  - Wait ≤2 s for hot-reload.
  - Call again; assert response matches B.
  - The test process is not restarted between the two calls.
- A second test that exercises the env-var path: change only `LLM_FOO_BASE_URL` between two `process.env` set / unset calls and verify the registry picks up the new value at the next `resolve()` call (env-var changes are NOT auto-reloaded but the next `resolve()` re-reads `process.env`; this asserts the boundary).
- A third test that exercises `kbju.voice_transcription` over a mock `POST /v1/audio/transcriptions` endpoint with a similar A → B swap.
- The tests use the new `tests/_helpers/postgres.ts`-style helper pattern from TKT-032@0.1.0 *only if Postgres is needed*; the LLM-swap tests should not need Postgres.

## 3. NOT In Scope
- Real-provider integration tests (Fireworks, OpenAI, OpenRouter networks) — out of scope; this is a local mock.
- CI workflow changes.
- Performance benchmarks of hot-reload propagation.

## 4. Inputs
- ARCH-001@0.7.0 §11 Test Strategy + §11.1 Mandatory boot smoke
- ADR-022@0.1.0 + ADR-023@0.1.0 + ADR-024@0.1.0 (the abstraction this test guards)
- TKT-033@0.1.0 / TKT-034@0.1.0 / TKT-035@0.1.0 (depends_on — the surface this tests must exist)

## 5. Outputs
- [ ] `tests/llm/providerSwap.smoke.test.ts` covering chat / vision / voice each with an A → B mock swap.
- [ ] If needed for the test, a tiny `tests/_helpers/mockOpenAiServer.ts` (or equivalent) — purpose-built for these tests, not a public surface.

## 6. Acceptance Criteria
- [ ] `npm test -- tests/llm/providerSwap.smoke.test.ts` passes.
- [ ] All three swap scenarios (chat, vision, voice) succeed without process restart.
- [ ] Hot-reload propagation observed within ≤2 s.
- [ ] No raw API key (real or mock) appears in any log line during the test.

## 7. Constraints
- Mocks are localhost-bound; do not make outbound calls to real providers.
- Do NOT add new runtime dependencies beyond what TKT-033@0.1.0 / TKT-034@0.1.0 / TKT-035@0.1.0 already added; mocks can use Node's built-in `http` module.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->
- 2026-05-26T00:00:00Z opencode-executor: started
- 2026-05-26T04:35:00Z opencode-executor: in_review; tests 4 pass; lint clean; typecheck clean
- 2026-05-26T01:41Z opencode-orchestrator: merged in commit ae417c5; RV-CODE-024 verdict=pass (0H/0M/2L deferred); env-var path adaptation accepted (registry only resolves API keys via getApiKey, NOT base_url — ticket §2 prose drift, not a bug); arch_ref bumped to ARCH-001@0.7.2; status=done
