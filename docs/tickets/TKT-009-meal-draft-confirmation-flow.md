---
id: TKT-009
title: Meal Draft Confirmation Flow
status: done
arch_ref: ARCH-001@0.2.0
component: C4 Meal Logging Orchestrator
depends_on:
- TKT-002@0.1.0
- TKT-003@0.1.0
- TKT-004@0.1.0
- TKT-005@0.1.0
- TKT-006@0.1.0
- TKT-007@0.1.0
- TKT-008@0.1.0
blocks:
- TKT-010@0.1.0
- TKT-011@0.1.0
- TKT-014@0.1.0
estimate: L
created: 2026-04-26
updated: 2026-05-01
---

# TKT-009: Meal Draft Confirmation Flow

## 1. Goal (one sentence, no "and")
Implement the meal draft confirmation orchestration for text, voice, photo, manual sources.

## 2. In Scope
- Add C4 orchestration for text meal input, voice transcript input, photo candidate input, correction edits, and manual KBJU entry.
- Create versioned `meal_drafts` and `meal_draft_items` records before user confirmation.
- Persist `confirmed_meals` and `meal_items` only after explicit confirm callback.
- Apply US-7 manual fallback when transcription, vision, or KBJU estimation returns no usable draft.
- Render Russian itemized draft messages with confirm/edit affordances and low-confidence labels for photo drafts.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No history pagination after confirmation; that belongs to TKT-010@0.1.0.
- No scheduled summaries; that belongs to TKT-011@0.1.0.
- No right-to-delete implementation; that belongs to TKT-012@0.1.0.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.2.0 §3.4 C4 Meal Logging Orchestrator
- ARCH-001@0.2.0 §4.2 Text meal logging
- ARCH-001@0.2.0 §4.3 Voice meal logging
- ARCH-001@0.2.0 §4.4 Photo meal logging
- ARCH-001@0.2.0 §4.5 Manual entry, edit, and delete history
- ARCH-001@0.2.0 §5 `meal_drafts`, `meal_draft_items`, `confirmed_meals`, `meal_items`, `audit_events`
- ARCH-001@0.2.0 §8 Observability
- `src/shared/types.ts`
- `src/store/tenantStore.ts`
- `src/telegram/types.ts`
- `src/telegram/messages.ts`
- `src/onboarding/types.ts`
- `src/kbju/kbjuEstimator.ts`
- `src/voice/transcriptionAdapter.ts`
- `src/photo/photoRecognitionAdapter.ts`
- `src/photo/photoConfidence.ts`
- `src/observability/events.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `src/store/types.ts` — `deleteMealDraftItemsByDraftId` added to `TenantScopedRepository` interface (iter-3 scope expansion)
- [ ] `src/store/tenantStore.ts` — proxy + impl for `deleteMealDraftItemsByDraftId` (iter-3 scope expansion)
- [ ] `src/meals/types.ts` exporting draft, confirmation, correction, and manual-entry types
- [ ] `src/meals/messages.ts` exporting Russian meal draft/fallback copy
- [ ] `src/meals/manualEntry.ts` exporting guided manual KBJU parsing
- [ ] `src/meals/mealOrchestrator.ts` exporting the C4 orchestrator
- [ ] `tests/meals/manualEntry.test.ts`
- [ ] `tests/meals/mealOrchestrator.test.ts`

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/meals/manualEntry.test.ts tests/meals/mealOrchestrator.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] Tests prove text, voice, photo, and manual sources create drafts before confirmation.
- [ ] Tests prove photo drafts never create `confirmed_meals` without explicit confirm.
- [ ] Tests prove stale draft versions cannot be confirmed after a correction creates a newer version.
- [ ] Tests prove duplicate confirm callbacks are idempotent.
- [ ] Tests prove KBJU failure opens manual entry and does not persist a confirmed meal.
- [ ] Tests prove K1/K2/K5 metric events are emitted on confirm.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies.
- Do NOT bypass C3 repository methods for meal, draft, or audit writes.
- Do NOT auto-save any photo-derived estimate.
- Do NOT retry suspicious model output from C6 or C7.
- All Russian UX copy must be deterministic strings or templates, not LLM-generated.
- GLM assignment is acceptable because the ticket integrates existing typed components under direct tests.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
