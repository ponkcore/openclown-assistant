---
id: TKT-012
title: Right To Delete Audit
status: done
arch_ref: ARCH-001@0.4.0
component: C11 Right-to-Delete and Tenant Audit Service
depends_on:
- TKT-002@0.1.0
- TKT-003@0.1.0
- TKT-004@0.1.0
- TKT-010@0.1.0
- TKT-011@0.1.0
blocks:
- TKT-014@0.1.0
estimate: M
created: 2026-04-26
updated: 2026-05-02
---

# TKT-012: Right To Delete Audit

## 1. Goal (one sentence, no "and")
Implement right-to-delete plus the tenant isolation audit runner.

## 2. In Scope
- Add C11 `/forget_me` and Russian natural-language deletion intent handler interface for C1.
- Require a single yes/no Russian confirmation before deletion.
- Hard-delete all user-scoped rows listed in ARCH-001@0.4.0 §5 inside one transaction after locking the user (per-user PostgreSQL advisory lock on `users.id`); the `users` row itself is removed in the same transaction.
- Handle the no-row-to-mark case: a repeat `/forget_me` from a Telegram user with no matching `users` row returns the Russian fresh-start message (ARCH-001@0.4.0 §3.11) without persisting anything.
- Stop future summary schedules before deleting the user row.
- Add end-of-pilot K4 audit runner that opens its own connection using `AUDIT_DB_URL` (the `kbju_audit` `BYPASSRLS` role provisioned in TKT-002@0.1.0); the runner writes only aggregate counts/findings to `tenant_audit_runs.findings`.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No ordinary meal soft-delete behavior; that belongs to TKT-010@0.1.0.
- No backup restore tooling; that belongs to TKT-013@0.1.0.
- No admin web UI or dashboard.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.4.0 §3.11 C11 Right-to-Delete and Tenant Audit Service
- ARCH-001@0.4.0 §4.7 Right-to-delete and tenant audit
- ARCH-001@0.4.0 §5 Data Model / Schemas
- ARCH-001@0.4.0 §9.2 Access Control and Tenant Isolation
- ARCH-001@0.4.0 §9.5 PII Handling and Deletion
- ADR-001@0.1.0
- ADR-009@0.1.0
- `src/shared/types.ts`
- `src/store/tenantStore.ts`
- `src/telegram/types.ts`
- `src/observability/events.ts`
- `src/history/historyService.ts`
- `src/summary/summaryScheduler.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `src/privacy/types.ts` exporting deletion and audit types
- [ ] `src/privacy/messages.ts` exporting Russian deletion confirmation/result copy
- [ ] `src/privacy/rightToDelete.ts` exporting C11 deletion flow
- [ ] `src/privacy/tenantAudit.ts` exporting K4 audit runner
- [ ] `tests/privacy/rightToDelete.test.ts`
- [ ] `tests/privacy/tenantAudit.test.ts`

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/privacy/rightToDelete.test.ts tests/privacy/tenantAudit.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] Tests prove cancellation leaves all user rows unchanged.
- [ ] Tests prove confirmed deletion removes `users`, profiles, targets, schedules, onboarding state, transcripts, drafts, confirmed meals, items, summaries, audit events, metric/cost events, lookup cache rows, and K7 labels for that `user_id`.
- [ ] Tests prove repeated deletion after prior deletion returns a Russian fresh-start/already-deleted result without old personalization.
- [ ] Tests prove concurrent delete and meal confirmation serialize on `user_id` lock.
- [ ] Tests prove tenant audit returns counts/findings without user payloads.
- [ ] Tests prove the audit runner refuses to start if `AUDIT_DB_URL` is unset, and that no application skill imports `AUDIT_DB_URL` (CI lint check).
- [ ] Tests prove a repeat `/forget_me` after prior deletion does not insert any new `users` row and returns the Russian fresh-start copy.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies.
- Do NOT retain user-scoped audit events after right-to-delete completes.
- Do NOT expose another user's data in tenant audit output.
- Use C3 transactions and repository methods only.
- Codex assignment is required because permanent deletion, locks, and tenant audit are security-critical.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
