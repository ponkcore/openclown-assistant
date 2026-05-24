---
id: TKT-010
title: History Mutation Flow
status: done
arch_ref: ARCH-001@0.2.0
component: C8 History Mutation Service
depends_on:
- TKT-002@0.1.0
- TKT-004@0.1.0
- TKT-009@0.1.0
blocks:
- TKT-011@0.1.0
- TKT-012@0.1.0
- TKT-014@0.1.0
estimate: M
created: 2026-04-26
updated: 2026-05-01
---

# TKT-010: History Mutation Flow

## 1. Goal (one sentence, no "and")
Implement paginated meal history mutation with audit records.

## 2. In Scope
- Add C8 history pagination newest-first with page size 5.
- Add owned-meal edit flow for item, portion, and KBJU changes using C4 recomputation/manual values where needed.
- Add ordinary meal delete as `confirmed_meals.deleted_at` soft-delete.
- Write per-user `audit_events` for edits and deletes.
- Add correction-delta metadata for future summaries without rewriting delivered summaries.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No initial meal confirmation flow; that belongs to TKT-009@0.1.0.
- No scheduled summary delivery; that belongs to TKT-011@0.1.0.
- No right-to-delete hard deletion; that belongs to TKT-012@0.1.0.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.2.0 §3.8 C8 History Mutation Service
- ARCH-001@0.2.0 §4.5 Manual entry, edit, and delete history
- ARCH-001@0.2.0 §5 `confirmed_meals`, `meal_items`, `audit_events`, `summary_records`
- ARCH-001@0.2.0 §9.2 Access Control and Tenant Isolation
- `src/shared/types.ts`
- `src/store/tenantStore.ts`
- `src/telegram/types.ts`
- `src/meals/mealOrchestrator.ts`
- `src/meals/messages.ts`
- `src/observability/events.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `src/history/types.ts` exporting history cursor and mutation types
- [ ] `src/history/messages.ts` exporting Russian history/edit/delete copy
- [ ] `src/history/historyService.ts` exporting C8 history operations
- [ ] `tests/history/historyService.test.ts`

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/history/historyService.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] Tests prove pagination returns 5 meals per page newest-first.
- [ ] Tests prove a meal ID owned by another `user_id` returns not-found without existence leakage.
- [ ] Tests prove edits write before/after audit snapshots and increment meal version.
- [ ] Tests prove deletes set `deleted_at`, write audit events, and exclude the meal from future summary query inputs.
- [ ] Tests prove already delivered summary records are not modified.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies.
- Do NOT hard-delete ordinary meal rows in this ticket.
- Do NOT expose another user's meal existence through error messages.
- Use C3 transactions for edit/delete mutations.
- GLM assignment is appropriate because history behavior is deterministic repository work.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
