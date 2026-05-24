---
id: TKT-006
title: Food Lookup KBJU Estimator
status: done
arch_ref: ARCH-001@0.2.0
component: C6 KBJU Estimator
depends_on:
- TKT-001@0.1.0
- TKT-002@0.1.0
- TKT-003@0.1.0
blocks:
- TKT-009@0.1.0
- TKT-011@0.1.0
- TKT-014@0.1.0
estimate: L
created: 2026-04-26
updated: 2026-04-30
---

# TKT-006: Food Lookup KBJU Estimator

## 1. Goal (one sentence, no "and")
Implement the hybrid food lookup estimator behind the OmniRoute text path.

## 2. In Scope
- Add Open Food Facts and USDA FoodData Central lookup clients with cache-first behavior through C3.
- Add an OmniRoute-first text model client for structured food parsing and LLM fallback.
- Add deterministic request budgets, one idempotent transport retry, schema validation, and manual-entry failure output.
- Add prompt-injection boundaries that treat user meal text as data only.
- Add tests for lookup order, cache behavior, fallback, suspicious output rejection, and no raw prompt logging.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No voice transcription; that belongs to TKT-007@0.1.0.
- No photo recognition; that belongs to TKT-008@0.1.0.
- No meal confirmation persistence; that belongs to TKT-009@0.1.0.
- No summary recommendation validator; that belongs to TKT-011@0.1.0.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.2.0 §3.6 C6 KBJU Estimator
- ARCH-001@0.2.0 §4.2 Text meal logging
- ARCH-001@0.2.0 §4.8 Cost, latency, and degradation
- ARCH-001@0.2.0 §6 External Interfaces
- ARCH-001@0.2.0 §9.4 LLM Prompt-Injection Mitigations
- ADR-002@0.1.0
- ADR-005@0.1.0
- ADR-009@0.1.0
- docs/knowledge/llm-routing.md
- `src/shared/types.ts`
- `src/store/tenantStore.ts`
- `src/observability/costGuard.ts`
- `src/observability/events.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `src/llm/omniRouteClient.ts` exporting config-driven OmniRoute HTTP calls
- [ ] `src/kbju/types.ts` exporting estimator request/result schemas
- [ ] `src/kbju/foodLookup.ts` exporting Open Food Facts and USDA lookup clients
- [ ] `src/kbju/kbjuEstimator.ts` exporting the C6 estimator
- [ ] `src/kbju/validation.ts` exporting structured output validators
- [ ] `tests/kbju/foodLookup.test.ts`
- [ ] `tests/kbju/kbjuEstimator.test.ts`
- [ ] `tests/kbju/validation.test.ts`

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/kbju/foodLookup.test.ts tests/kbju/kbjuEstimator.test.ts tests/kbju/validation.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] Tests prove cache hits skip external lookup calls.
- [ ] Tests prove lookup order is Open Food Facts, then USDA, then LLM fallback.
- [ ] Tests prove model output with instruction-following text, malformed JSON, missing KBJU totals, or forbidden non-KBJU advice returns a manual-entry failure without retry.
- [ ] Tests prove OmniRoute is used before any direct provider fallback path.
- [ ] Tests prove prompts and provider responses are not passed to C10 logs.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies.
- Do NOT hard-code provider API keys or model aliases inside business logic; read config from shared config.
- Direct provider fallback can exist only as a transport option behind the same client interface.
- No retry on suspicious or malformed model content.
- All external text fed to an LLM must be serialized as data fields with fixed system/developer instructions from ARCH-001@0.2.0 §9.4.
- GLM assignment is acceptable because ADR-002@0.1.0 and ADR-005@0.1.0 constrain the implementation tightly.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
