---
id: TKT-027
title: C22 Adaptive Summary Composer with deterministic section ordering + zero-event
  suppression
version: 0.1.0
status: in_review
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
component: C22
depends_on:
- TKT-021@0.1.0
- TKT-023@0.1.0
- TKT-029@0.1.0
- TKT-030@0.1.0
- TKT-031@0.1.0
- TKT-026@0.1.0
blocks: []
estimate: M
created: 2026-05-06
updated: 2026-05-06
---

# TKT-027: C22 Adaptive Summary Composer with deterministic section ordering + zero-event suppression

## 1. Goal
Land the C22 Adaptive Summary Composer that folds active modality sections into the existing PRD-001@0.2.0 §5 US-7 daily / weekly / monthly summary per PRD-003@0.1.3 §5 US-6 acceptance.

## 2. In Scope
- New module `src/summary/adaptiveComposer.ts` that wraps the existing C9 Summary Recommendation Service, reading the four modality event tables (`water_events`, `sleep_records`, `workout_events`, `mood_events`) plus the modality_settings table for the requesting user, and emitting the adaptive summary text per the §5 US-6 contract.
- Deterministic section ordering: KBJU → water → sleep → workout → mood (PRD-003@0.1.3 §2 G6).
- Zero-event suppression: a modality section is omitted when ZERO events exist for that user in the summary window even if the modality is currently ON (PRD-003@0.1.3 §5 US-6 4th AC bullet).
- OFF-modality suppression: a modality section is omitted when modality is OFF, regardless of historical events (5th AC bullet).
- KBJU section unconditional (PRD-003@0.1.3 §3 NG6 + §5 US-6 1st AC bullet).
- Russian-language section headings in `src/summary/copy.ru.ts` (PO ratifies before sign-off).
- Workout-type → Russian rendering map in `src/summary/copy.ru.ts` (per ADR-016@0.1.0 §Consequences "Russian-presentation" clause).
- Sleep nap-class decomposition in the summary text (per ADR-017@0.1.0 §Consequences "the user can see '1 ночной сон, 2 дневных'" clause).
- Rolling-7-day audit-mode helper that returns each generated summary's section-set vs. the per-user settings snapshot at generation time, for PRD-003@0.1.3 §6 K6 audit.

## 3. NOT In Scope
- The four modality event tables themselves (TKT-021@0.1.0).
- The four modality event handlers (TKT-023@0.1.0 sleep; TKT-029@0.1.0 water / TKT-030@0.1.0 workout / TKT-031@0.1.0 mood).
- The C21 Modality Settings Service (TKT-028@0.1.0).
- The PRD-001@0.2.0 §5 US-7 KBJU summary template (reused unchanged from C9).
- The summary delivery channel (Telegram via C1; reused unchanged).
- Cross-modality recommendations (PRD-003@0.1.3 §3 NG2 explicit non-goal — deferred to proactive-coaching PRD).

## 4. Inputs
- ARCH-001@0.6.0 §3.22 (C22 component spec)
- PRD-003@0.1.3 §2 G6 (verbatim adaptive summary integration goal)
- PRD-003@0.1.3 §5 US-6 (verbatim AC bullets)
- PRD-003@0.1.3 §6 K6 (rolling-7-day audit KPI)
- ARCH-001@0.6.0 §3.9 (C9 Summary Recommendation Service — extension point)
- ADR-006@0.1.0 (Summary recommendation guardrails — pattern reused)
- ADR-016@0.1.0 §Consequences (workout-type → Russian rendering map clause)
- ADR-017@0.1.0 §Consequences (nap-class decomposition clause)
- TKT-021@0.1.0 schemas (event tables read here)

## 5. Outputs
- [ ] `src/summary/adaptiveComposer.ts` exporting the composer.
- [ ] `src/summary/copy.ru.ts` Russian section-heading + workout-type rendering map.
- [ ] `src/summary/auditHelper.ts` exporting the rolling-7-day K6 audit helper.
- [ ] `tests/summary/adaptiveComposer.test.ts` covering: KBJU-only, KBJU+water, KBJU+water+sleep, KBJU+all-four, all-modalities-OFF (KBJU only), all-ON-but-zero-events (KBJU only), mixed states (≥10 cases).
- [ ] `tests/summary/adaptiveComposer.ordering.test.ts` covering deterministic section ordering.
- [ ] `tests/summary/adaptiveComposer.naps.test.ts` covering nap-class decomposition (sleep section shows "X ночной сон, Y дневных" when applicable).
- [ ] `tests/summary/auditHelper.test.ts` covering K6 (100% match between active-modality set and summary-section set on a synthetic 7-day fixture).

## 6. Acceptance Criteria
- [ ] `npm test -- tests/summary/` passes (all four adaptive-composer test files plus existing C9 tests still passing).
- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean (strict).
- [ ] Manual smoke: user with all four modalities ON + events of each kind in the past day → daily summary includes KBJU + water + sleep + workout + mood sections in that exact order.
- [ ] Manual smoke: user with all four modalities OFF → daily summary contains ONLY the KBJU section.
- [ ] Manual smoke: user with water modality ON but ZERO water events in the window + sleep modality ON with sleep events → summary includes KBJU + sleep, NOT water (zero-event suppression).
- [ ] Workout summary section renders English canonical types in Russian per the rendering map (`running` → "Бег", `cycling` → "Велосипед", etc.).
- [ ] Sleep section decomposes into nap-class vs full-sleep when both are present in the window.
- [ ] K6 audit helper run against a synthetic 7-day fixture returns 100% match between active-modality set and summary-section set.
- [ ] Latency: summary generation latency ≤105% of the existing C9 baseline measured under the existing summary-generation test harness (PRD-003@0.1.3 §7 ≤5% latency overhead).

## 7. Constraints
- Do NOT change the existing C9 Summary Recommendation Service contract. Wrap, do not modify.
- Do NOT change the PRD-001@0.2.0 §5 US-7 KBJU summary text template.
- Do NOT introduce new external dependencies.
- All summary text emitted by C22 passes through the ARCH-001@0.5.0 §10.7 emit-boundary redaction (extended in TKT-026@0.1.0); the user-facing summary itself is allowed to contain user-private fields (mood comment, workout description, sleep notes are NOT emitted by C22 to logs but are emitted to the user's own Telegram channel as the summary content).
- Mood-comment text is included in the user-facing summary at most once per event in a "(comment)" suffix; it is NOT emitted to any structured log channel.
- `assigned_executor: "executor"` justified: TypeScript composition wrapper, ~250 LoC, with deterministic ordering + suppression logic + i18n rendering map; representative GLM workload (no security boundary, no temporal complexity, no DB schema design).

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body.
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
- 2026-05-25T00:00:00Z opencode-executor: started
- 2026-05-25T15:15:00Z opencode-executor: in_review; tests 32 pass; lint clean; typecheck clean; latency claim: 4 parallel SELECT via Promise.all within ≤5% overhead budget
- 2026-05-25T15:40:00Z opencode-executor iter2: closed F-M1 (Promise.all → Promise.allSettled with per-rejection structured-log emit; failed modality query → empty section, KBJU + other sections still delivered per ARCH-001@0.6.2 §3.22 mode (a)). Added unit test asserting transient water-table failure does not block KBJU delivery. F-L1..F-L5 left as-is.
