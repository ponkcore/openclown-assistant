---
id: TKT-005
title: Onboarding Target Calculator
status: done
arch_ref: ARCH-001@0.3.1
component: C2 Onboarding and Target Calculator
depends_on:
- TKT-001@0.1.0
- TKT-002@0.1.0
- TKT-004@0.1.0
blocks:
- TKT-009@0.1.0
- TKT-011@0.1.0
- TKT-014@0.1.0
estimate: M
created: 2026-04-26
updated: 2026-04-30
closed_at: 2026-04-30
closed_by: orchestrator (PO-delegated)
review_ref: null
---

# TKT-005: Onboarding Target Calculator

## 1. Goal (one sentence, no "and")
Implement deterministic onboarding state handling with KBJU target calculation.

## 2. In Scope
- Add C2 step-state machine for `/start` onboarding in Russian.
- Validate sex, age, height, weight, activity level, weight goal, optional pace, IANA timezone, report time, and target confirmation.
- Implement Mifflin-St Jeor BMR, activity multiplier, goal delta, and macro target calculation from ADR-005@0.2.0.
- Persist profile, targets, onboarding status, and summary schedules through C3 after explicit confirmation.
- Add Russian onboarding prompts, examples, default pace disclosure, target summary, and one-sentence non-medical disclaimer.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No meal logging or draft confirmation; that belongs to TKT-009@0.1.0.
- No summary generation wording beyond schedule rows; that belongs to TKT-011@0.1.0.
- No LLM calls in onboarding.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.3.1 §3.2 C2 Onboarding and Target Calculator
- ARCH-001@0.3.1 §4.1 Onboarding and target creation
- ARCH-001@0.3.1 §5 `users`, `user_profiles`, `user_targets`, `summary_schedules`, `onboarding_states`
- ARCH-001@0.3.1 §9.1 Secrets Management
- ADR-005@0.2.0
- `src/shared/types.ts`
- `src/store/tenantStore.ts`
- `src/telegram/types.ts`
- `src/telegram/messages.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `src/onboarding/types.ts` exporting onboarding state and answer types
- [ ] `src/onboarding/messages.ts` exporting Russian onboarding copy
- [ ] `src/onboarding/targetCalculator.ts` exporting target calculation functions
- [ ] `src/onboarding/onboardingFlow.ts` exporting the C2 handler
- [ ] `tests/onboarding/targetCalculator.test.ts`
- [ ] `tests/onboarding/onboardingFlow.test.ts`

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/onboarding/targetCalculator.test.ts tests/onboarding/onboardingFlow.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] Tests cover invalid age, height, weight, pace, activity level, timezone, and report time with Russian re-ask examples.
- [ ] Tests cover skipped pace applying `0.5 kg/week` and telling the user the default.
- [ ] Tests cover male and female Mifflin-St Jeor calculations with deterministic rounded calories/protein/fat/carbs.
- [ ] Tests prove profile/targets/schedules persist only after explicit target confirmation.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies.
- Do NOT infer timezone from Telegram client fields; ask explicitly.
- Do NOT call an LLM from onboarding.
- Store only validated answers as profile facts.
- GLM assignment is appropriate because this is deterministic state-machine and arithmetic work.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
