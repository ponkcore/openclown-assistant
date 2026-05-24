---
id: TKT-022
title: C16 Modality Router — hybrid deterministic chain + LLM-fallback classifier
  (ADR-015@0.1.0 amended Option C)
version: 0.1.0
status: done
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
component: C16
depends_on:
- TKT-021@0.1.0
blocks:
- TKT-023@0.1.0
- TKT-029@0.1.0
- TKT-030@0.1.0
- TKT-031@0.1.0
- TKT-025@0.1.0
estimate: M
created: 2026-05-06
updated: 2026-05-06
---

# TKT-022: C16 Modality Router — hybrid deterministic chain + LLM-fallback classifier (ADR-015@0.1.0 amended Option C)

## 1. Goal
Land the C16 Modality Router that classifies inbound Telegram messages into KBJU / water / sleep / workout / mood / ambiguous via the ADR-015@0.1.0 amended Option C Hybrid (deterministic-first chain → LLM tie-breaker on multi-match → LLM full-classifier on zero-match) using ADR-018@0.1.0 LLM picks.

## 2. In Scope
- New module `src/modality/router.ts` exporting `routeModality(input: ModalityRouterInput): Promise<ModalityRouterDecision>` per ADR-015@0.1.0 amended §Decision (Option C Hybrid).
- Configuration file `config/modality-router.json` listing the five deterministic matcher chains (KBJU keywords already in C4; water / sleep / workout / mood keyword sets seeded by Architect per ARCH-001@0.6.0 §6.2 + ADR-015@0.1.0 amendment) — hot-reload per ADR-013@0.1.0 pattern.
- Configuration file `config/modality-router-classifier.json` with the LLM-classifier prompt template + JSON schema + confidence threshold (0.6 default per ADR-018@0.1.0) — hot-reload.
- LLM-fallback wiring through OmniRoute (ADR-002@0.1.0) using ADR-018@0.1.0 picks: default `accounts/fireworks/models/gpt-oss-20b`, fallback `accounts/fireworks/models/qwen3-vl-30b-a3b`, emergency-free `openrouter/nvidia/nemotron-3-super:free`.
- Hard-constrained output set per ADR-006@0.1.0 forced-output guardrail: classifier MUST return exactly one of `{KBJU, WATER, SLEEP, WORKOUT, MOOD, AMBIGUOUS}` plus `confidence: 0..1`.
- Integration into `src/sidecar/factory.ts` so C1 entrypoint routes every claimed text or voice-transcribed message through C16 before dispatching.
- Clarifying-reply inline-keyboard per ARCH-001@0.6.0 §6.2.2 C16 verbatim copy (Architect-ratified per PO Q6 delegation).
- New telemetry counter `kbju_modality_route_outcome` with labels `{deterministic_single, deterministic_multi_llm_resolved, zero_match_llm_resolved, zero_match_llm_ambiguous, ambiguous_clarified}`.
- New telemetry counter `kbju_modality_router_llm_call{outcome ∈ {success_default, success_fallback, success_emergency, failure}}` for ADR-018@0.1.0 default+fallback+emergency wiring observability.
- Golden-test set `tests/modality/router.golden.test.ts` covering ≥30 hand-curated Russian morphology cases for the deterministic chain + ≥20 LLM-fallback round-trip cases mocking OmniRoute (TKT-025@0.1.0 owns the larger golden suite; this ticket seeds the smoke set).

## 3. NOT In Scope
- Per-modality storage logic (TKT-023@0.1.0..TKT-025@0.1.0).
- Per-modality settings (TKT-026@0.1.0).
- Adaptive summary logic (TKT-027@0.1.0).
- Modification of C4 KBJU pattern set; the C4 free-form fallback path is preserved exactly.
- Photo dispatch routing — photos go directly to C7 photo recognition then to C19 Workout Logger if workout modality is active; C16 only routes text + voice-transcribed text.

## 4. Inputs
- ARCH-001@0.6.0 §3.16 (C16 component spec) + §6.2 (Voice/Tone profile + concrete reply strings)
- ADR-015@0.1.0 amended §Decision (verbatim contract for hybrid chain + LLM-fallback + clarifying-reply paths)
- ADR-018@0.1.0 (LLM picks: default + fallback + emergency-free per site)
- ADR-013@0.1.0 (hot-reload config pattern reused for both router JSONs)
- ADR-002@0.1.0 (OmniRoute LLM routing)
- ADR-006@0.1.0 (forced-output guardrail; classifier output validation reuses pattern)
- Existing `src/security/allowlist.ts` (precedent for hot-reload + atomic-rename safety)
- Existing `src/observability/kpiEvents.ts` (precedent for adding metric counters)
- Existing `src/llm/omniroute.ts` (precedent for OmniRoute calls)
- `src/sidecar/factory.ts`, `src/telegram/entrypoint.ts` (integration points)

## 5. Outputs
- [ ] `src/modality/router.ts` exporting `routeModality` (async) + types (`ModalityRouterInput`, `ModalityRouterDecision`).
- [ ] `src/modality/router-classifier.ts` exporting `classifyViaLLM(text, candidateSet?)` that calls OmniRoute per ADR-018@0.1.0 default+fallback+emergency wiring.
- [ ] `config/modality-router.json` with the five deterministic matcher chains seeded by Architect (per ARCH-001@0.6.0 §6.2 + ADR-015@0.1.0 amendment seed list inline).
- [ ] `config/modality-router-classifier.json` with the LLM prompt template + JSON schema + confidence threshold (0.6 default).
- [ ] `config/modality-router.example.json` + `config/modality-router-classifier.example.json` (non-secret example files).
- [ ] `src/observability/kpiEvents.ts` extended with `kbju_modality_route_outcome` (new label set) + `kbju_modality_router_llm_call` counter.
- [ ] `src/sidecar/factory.ts` wires the router into the C1 dispatch path (additive; no breakage of existing KBJU path).
- [ ] `tests/modality/router.unit.test.ts` (matcher-chain + classifier-mock unit tests, ≥80% coverage).
- [ ] `tests/modality/router.golden.test.ts` (≥30 deterministic-chain Russian morphology cases + ≥20 LLM-fallback mock cases inline; TKT-025@0.1.0 owns the full golden suite).
- [ ] `tests/modality/router.hot-reload.test.ts` (mirrors `tests/security/allowlist.test.ts` pattern; verifies both config files reload ≤30 s).
- [ ] `tests/modality/router-classifier.test.ts` (OmniRoute mock harness; verifies default → fallback → emergency degradation; verifies confidence-threshold → AMBIGUOUS branch).

## 6. Acceptance Criteria
- [ ] `npm test -- tests/modality/router.unit.test.ts` passes.
- [ ] `npm test -- tests/modality/router.golden.test.ts` passes (deterministic-chain golden cases + mocked LLM-fallback round-trip cases).
- [ ] `npm test -- tests/modality/router-classifier.test.ts` passes (OmniRoute degradation chain + confidence-threshold branch verified).
- [ ] `npm test -- tests/modality/router.hot-reload.test.ts` passes (both config files reload ≤30 s).
- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean (strict).
- [ ] Existing `tests/telegram/entrypoint.test.ts` still passes (no regression on the C1 path).
- [ ] Manual smoke (against staging OmniRoute):
  - Send `выпил 200мл` → deterministic single → C17 invoked, no LLM call.
  - Send `съел 200г творога` → deterministic single → C4 KBJU invoked, no LLM call.
  - Send `выпил пол-литра кефира` → deterministic multi-match → LLM tie-breaker called → KBJU or WATER routed (whichever LLM picks) OR clarifying keyboard if AMBIGUOUS.
  - Send `вчера вечером было прям овацииииии` (free-form, no chain match) → zero-match → LLM full-classifier → likely AMBIGUOUS → clarifying keyboard.
- [ ] `kbju_modality_route_outcome` metric emits per route decision with the new label set.
- [ ] `kbju_modality_router_llm_call` metric emits per LLM call with outcome label.

## 7. Constraints
- Do NOT add new runtime dependencies for the deterministic chain. Reuse the existing TypeScript regex engine.
- LLM calls MUST go through OmniRoute (`src/llm/omniroute.ts`) per ADR-002@0.1.0 — do NOT instantiate Fireworks / OpenRouter clients directly in the router.
- The deterministic matcher chain MUST be evaluated in fixed order KBJU → water → sleep → workout → mood (PRD-003@0.1.3 §8 R1 ratified order).
- LLM tie-breaker on multi-match MUST be hard-constrained to the deterministic-candidate set + AMBIGUOUS via forced JSON schema.
- LLM zero-match full-classifier MUST return `{label, confidence}`; confidence < 0.6 → AMBIGUOUS branch.
- AMBIGUOUS → emit clarifying inline-keyboard reply per ARCH-001@0.6.0 §6.2.2 verbatim copy.
- Single high-confidence label → route to corresponding component without further user prompt.
- `assigned_executor: "executor"` justified: TypeScript module-creation + OmniRoute integration + JSON-schema validation + configuration loading + observability wiring — a representative GLM workload per the §Phase 8 default rule. Codex-GPT-5.5 is overkill for the regex+schema layer; DeepSeek is reserved for parallel work.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body.
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
- 2026-05-24T00:00:00Z opencode-executor: started
- 2026-05-24T00:31:00Z opencode-executor: in_review; tests 102 pass; lint clean; typecheck clean
- 2026-05-24T00:55:00Z opencode-executor iter2: addressed F-M1 (production wiring + integration test), F-M2 (config dedup), F-M3 (schema strictness)
- 2026-05-24T21:10:00Z opencode-orchestrator: merged in commit 8d49ab1 (PR #6); RV-CODE-002 verdict=pass_with_changes (3 Mediums closed iter-2; F-L1/F-L2/F-L3 backlogged BACKLOG-002)
