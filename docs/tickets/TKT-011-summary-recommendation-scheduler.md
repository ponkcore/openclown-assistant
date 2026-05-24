---
id: TKT-011
title: Summary Recommendation Scheduler
status: done
arch_ref: ARCH-001@0.4.0
component: C9 Summary Recommendation Service
depends_on:
- TKT-002@0.1.0
- TKT-003@0.1.0
- TKT-005@0.1.0
- TKT-006@0.1.0
- TKT-010@0.1.0
blocks:
- TKT-012@0.1.0
- TKT-014@0.1.0
estimate: L
created: 2026-04-26
updated: 2026-05-02
---

# TKT-011: Summary Recommendation Scheduler

## 1. Goal (one sentence, no "and")
Implement scheduled KBJU summary generation with guarded recommendations.

## 2. In Scope
- Add C9 due-schedule selection using user timezone, local period boundaries, and idempotency key `(user_id, period_type, period_start)`.
- Aggregate confirmed non-deleted meals into daily, weekly, and monthly totals.
- Compute deltas vs targets and previous-period comparisons.
- Load PO persona from `PERSONA_PATH` at startup and fail closed when missing.
- Generate Russian summary recommendations through OmniRoute with ADR-006@0.1.0 prompt/validator/fallback rules.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No onboarding schedule creation; that belongs to TKT-005@0.1.0.
- No meal edit/delete implementation; that belongs to TKT-010@0.1.0.
- No right-to-delete hard deletion; that belongs to TKT-012@0.1.0.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.4.0 §3.9 C9 Summary Recommendation Service
- ARCH-001@0.4.0 §4.6 Scheduled summaries
- ARCH-001@0.4.0 §5 `summary_schedules`, `summary_records`, `confirmed_meals`, `meal_items`, `user_targets`
- ARCH-001@0.4.0 §8 Observability
- ARCH-001@0.4.0 §9.4 LLM Prompt-Injection Mitigations
- ADR-002@0.1.0
- ADR-006@0.1.0
- ADR-009@0.1.0
- docs/knowledge/llm-routing.md
- `src/shared/types.ts`
- `src/store/tenantStore.ts`
- `src/kbju/kbjuEstimator.ts`
- `src/llm/omniRouteClient.ts`
- `src/observability/costGuard.ts`
- `src/observability/events.ts`
- `src/history/historyService.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `src/summary/types.ts` exporting summary period, aggregate, and recommendation types
- [ ] `src/summary/personaLoader.ts` exporting startup persona loading
- [ ] `src/summary/recommendationGuard.ts` exporting prompt builder, output validator, and deterministic fallback
- [ ] `src/summary/summaryScheduler.ts` exporting C9 schedule processing
- [ ] `src/summary/messages.ts` exporting Russian no-meal nudge and deterministic fallback copy
- [ ] `tests/summary/personaLoader.test.ts`
- [ ] `tests/summary/recommendationGuard.test.ts`
- [ ] `tests/summary/summaryScheduler.test.ts`

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/summary/personaLoader.test.ts tests/summary/recommendationGuard.test.ts tests/summary/summaryScheduler.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] Tests prove duplicate cron events produce one `summary_records` row per idempotency key.
- [ ] Tests prove zero-meal periods send a deterministic Russian nudge without an LLM call.
- [ ] Tests prove validator blocks Russian and English forbidden terms for medical/clinical advice, vitamins, supplements, drugs, hydration, glycemic index, meal timing, micronutrients, diagnosis, treatment, and exercise.
- [ ] Tests prove blocked recommendations send deterministic numeric KBJU fallback and emit `summary_recommendation_blocked`.
- [ ] Tests prove missing `PERSONA_PATH` fails startup for C9.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies.
- Do NOT pass raw full meal text into the recommendation model unless it is a numeric correction note required by ARCH-001@0.4.0 §3.9.
- Do NOT retry suspicious recommendation output.
- Recommendations must be limited to calories, protein, fat, and carbs relative to targets.
- Qwen assignment is appropriate because this ticket is independent after dependencies and heavily language/guardrail oriented.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
