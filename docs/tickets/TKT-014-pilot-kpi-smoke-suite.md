---
id: TKT-014
title: Pilot KPI Smoke Suite
status: done
arch_ref: ARCH-001@0.4.0
component: End-to-end pilot readiness / K1-K7
depends_on:
- TKT-003@0.1.0
- TKT-005@0.1.0
- TKT-009@0.1.0
- TKT-010@0.1.0
- TKT-011@0.1.0
- TKT-012@0.1.0
- TKT-013@0.1.0
blocks: []
estimate: M
created: 2026-04-26
updated: 2026-05-02
---

# TKT-014: Pilot KPI Smoke Suite

## 1. Goal (one sentence, no "and")
Implement the pilot KPI smoke suite for end-to-end readiness evidence.

## 2. In Scope
- Add deterministic KPI query helpers for K1-K7 over C3 data and C10 events.
- Add an end-to-end mocked pilot smoke test covering onboarding, text meal, voice fallback, photo low confidence, confirmation, history delete, summary fallback, and right-to-delete.
- Add a CLI/report helper that prints a redacted pilot readiness summary without user payloads.
- Add fixture data for the ADR-005@0.1.0 K7 proposed accuracy calculations.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No new product features or UX copy beyond test fixtures.
- No real provider calls.
- No changes to production flow behavior outside KPI/report helpers.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.4.0 §1.1 Trace matrix
- ARCH-001@0.4.0 §4 Data Flow
- ARCH-001@0.4.0 §8.3 KPI Measurement
- ARCH-001@0.4.0 §12 Risks & Open Questions
- ADR-005@0.1.0
- ADR-009@0.1.0
- `src/shared/types.ts`
- `src/store/tenantStore.ts`
- `src/observability/kpiEvents.ts`
- `src/onboarding/onboardingFlow.ts`
- `src/meals/mealOrchestrator.ts`
- `src/history/historyService.ts`
- `src/summary/summaryScheduler.ts`
- `src/privacy/rightToDelete.ts`
- `src/privacy/tenantAudit.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `src/pilot/kpiQueries.ts` exporting K1-K7 query helpers
- [ ] `src/pilot/pilotReadinessReport.ts` exporting redacted report formatting
- [ ] `tests/pilot/fixtures.ts` containing synthetic two-user pilot fixtures without real personal data
- [ ] `tests/pilot/kpiQueries.test.ts`
- [ ] `tests/pilot/pilotSmoke.test.ts`

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/pilot/kpiQueries.test.ts tests/pilot/pilotSmoke.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] Tests prove K1-K7 helpers calculate the ARCH-001@0.4.0 §8.3 KPI values from synthetic data.
- [ ] Smoke test proves no user B receives user A meal, summary, history, transcript, or audit data.
- [ ] Smoke test proves low-confidence photo output is labelled `низкая уверенность` and is not persisted before confirmation.
- [ ] Smoke test proves summary forbidden-topic output is blocked and deterministic fallback is delivered.
- [ ] Smoke test proves right-to-delete removes all user A data and allows fresh onboarding.
- [ ] Readiness report output contains no Telegram IDs, usernames, raw meal text, transcripts, or provider prompts.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies.
- Do NOT perform real network calls in tests.
- Do NOT include real pilot personal data in fixtures.
- Do NOT alter production behavior merely to make smoke tests pass; raise a Q-TKT if a previous ticket left an untestable seam.
- Qwen assignment is appropriate because this ticket is parallel-review friendly and focused on integration evidence across completed modules.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
