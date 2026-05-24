---
id: TKT-004
title: Telegram Entrypoint Routing
status: done
arch_ref: ARCH-001@0.2.0
component: C1 Access-Controlled Telegram Entrypoint
depends_on:
- TKT-001@0.1.0
- TKT-002@0.1.0
- TKT-003@0.1.0
blocks:
- TKT-005@0.1.0
- TKT-007@0.1.0
- TKT-008@0.1.0
- TKT-009@0.1.0
- TKT-010@0.1.0
- TKT-012@0.1.0
estimate: M
created: 2026-04-26
updated: 2026-04-28
closed_at: 2026-04-28
closed_by: orchestrator (PO-delegated)
review_ref: null
---

# TKT-004: Telegram Entrypoint Routing

## 1. Goal (one sentence, no "and")
Implement the allowlisted Telegram entrypoint router for Russian bot flows.

## 2. In Scope
- Add C1 event normalization for Telegram text, voice, photo, callback, and command updates.
- Enforce `TELEGRAM_PILOT_USER_IDS` before creating any user-owned state.
- Route `/start`, meal inputs, history requests, callbacks, scheduled summary deliveries, and `/forget_me` to typed handler interfaces.
- Maintain Telegram typing status during long provider work through a cancellable renewal helper.
- Add Russian generic recovery messages and one-retry send behavior for transient Telegram send errors.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No onboarding step implementation; that belongs to TKT-005@0.1.0.
- No voice transcription provider implementation; that belongs to TKT-007@0.1.0.
- No meal draft persistence orchestration; that belongs to TKT-009@0.1.0.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.2.0 §3.1 C1 Access-Controlled Telegram Entrypoint
- ARCH-001@0.2.0 §4.1 Onboarding and target creation
- ARCH-001@0.2.0 §4.2 Text meal logging
- ARCH-001@0.2.0 §4.3 Voice meal logging
- ARCH-001@0.2.0 §4.4 Photo meal logging
- ARCH-001@0.2.0 §6 External Interfaces
- ARCH-001@0.2.0 §9.2 Access Control and Tenant Isolation
- docs/knowledge/openclaw.md
- `src/shared/types.ts`
- `src/shared/config.ts`
- `src/store/tenantStore.ts`
- `src/observability/events.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [x] `src/telegram/types.ts` exporting normalized Telegram update and handler interfaces
- [x] `src/telegram/messages.ts` exporting Russian C1 generic/recovery copy
- [x] `src/telegram/typing.ts` exporting the typing renewal helper
- [x] `src/telegram/entrypoint.ts` exporting the C1 router
- [x] `tests/telegram/entrypoint.test.ts`
- [x] `tests/telegram/typing.test.ts`
- [x] `src/observability/kpiEvents.ts` (KPI-event-name additions only, no other modifications) — post-hoc ratified per Path 1 (TKT-003@0.1.0 Option A precedent); D-I6 scope-violation flag from orchestrator Review on iter-1 head 471a3e0 ratified inline.

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/telegram/entrypoint.test.ts tests/telegram/typing.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] Tests prove non-allowlisted Telegram IDs produce no C3 write calls.
- [ ] Tests prove voice messages longer than 15 seconds are rejected before media download handler invocation.
- [ ] Tests prove route selection for `/start`, `/forget_me`, text meal, voice meal, photo meal, history command, and callback payloads.
- [ ] Tests prove typing renewal stops after success, user fallback, or thrown error.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies.
- Do NOT log full Telegram usernames, bot tokens, raw meal text, or callback payloads containing meal text.
- Use C10 event helpers for all route outcomes.
- Handler interfaces must be dependency-injected so later tickets can implement flows without editing C1 tests.
- GLM assignment is appropriate because routing behavior is deterministic and testable.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
