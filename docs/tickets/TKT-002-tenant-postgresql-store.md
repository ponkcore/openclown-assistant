---
id: TKT-002
title: Tenant PostgreSQL Store
status: done
arch_ref: ARCH-001@0.2.0
component: C3 Tenant-Scoped Store
depends_on:
- TKT-001@0.1.0
blocks:
- TKT-003@0.1.0
- TKT-004@0.1.0
- TKT-005@0.1.0
- TKT-009@0.1.0
- TKT-010@0.1.0
- TKT-011@0.1.0
- TKT-012@0.1.0
- TKT-014@0.1.0
estimate: L
created: 2026-04-26
updated: 2026-04-27
closed_at: 2026-04-27
closed_by: orchestrator (PO-delegated)
review_ref: null
---

# TKT-002: Tenant PostgreSQL Store

## 1. Goal (one sentence, no "and")
Implement the PostgreSQL tenant store with RLS-backed repositories.

## 2. In Scope
- Add the C3 PostgreSQL schema matching ARCH-001@0.2.0 §5, including `kbju_accuracy_labels`.
- Add RLS policy SQL for every user-owned table and ownership checks for child rows.
- Provision a separate PostgreSQL role `kbju_audit` with `BYPASSRLS` per ARCH-001@0.2.0 §9.2 in the schema bootstrap so the C11 K4 audit job can run; the application role must NOT inherit this privilege.
- Add a typed tenant repository layer that requires `user_id` for all user-owned reads and writes.
- Add transaction helpers, optimistic version helpers, and migration startup validation.
- Add tests proving unscoped repository methods do not exist and SQL/RLS invariants are present.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No OpenClaw Telegram entrypoint or UX messages; that belongs to TKT-004@0.1.0.
- No meal estimation, summary, or provider calls; those belong to TKT-006@0.1.0, TKT-008@0.1.0, and TKT-011@0.1.0.
- No Docker Compose deployment; that belongs to TKT-013@0.1.0.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.2.0 §3.3 C3 Tenant-Scoped Store
- ARCH-001@0.2.0 §4 Data Flow
- ARCH-001@0.2.0 §5 Data Model / Schemas
- ARCH-001@0.2.0 §9.2 Access Control and Tenant Isolation
- ADR-001@0.1.0
- ADR-009@0.1.0
- docs/knowledge/openclaw.md
- `package.json`
- `src/shared/types.ts`
- `src/shared/config.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `package.json` updated only if adding the allowed PostgreSQL dependency
- [ ] `package-lock.json` updated only if adding the allowed PostgreSQL dependency
- [ ] `src/store/schema.sql` containing DDL and RLS policies
- [ ] `src/store/types.ts` exporting table and repository request types
- [ ] `src/store/tenantStore.ts` exporting the C3 repository surface
- [ ] `src/store/migrations.ts` exporting migration/version validation helpers
- [ ] `tests/store/schema.test.ts` verifying schema invariants from ARCH-001@0.2.0 §5
- [ ] `tests/store/tenantStore.test.ts` verifying repository scoping and transaction behavior with mocks

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/store/schema.test.ts tests/store/tenantStore.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] Tests assert every user-owned table in ARCH-001@0.2.0 §5 has `user_id NOT NULL` except `users` and `tenant_audit_runs`.
- [ ] Tests assert every user-owned table has an `ENABLE ROW LEVEL SECURITY` statement.
- [ ] Tests assert no exported repository method can list or mutate user-owned rows without a `userId` parameter.
- [ ] Tests assert raw voice/photo durable columns do not exist in `schema.sql`.
- [ ] Tests assert `users` has no `deleted_at` column and `onboarding_status` enum has no `deleted` value (right-to-delete is hard-delete only per ARCH-001@0.2.0 §9.5).
- [ ] Tests assert the `kbju_audit` role exists with `BYPASSRLS` and that the application role is not a member of it.

## 7. Constraints (hard rules for Executor)
- Allowed new runtime dependencies: `pg`.
- Allowed new dev dependencies: `@types/pg`.
- Do NOT add an ORM unless you raise a Q-TKT and receive approval.
- All SQL must be parameterized; no string-concatenated values.
- The app DB role must be documented in SQL comments as non-owner and unable to bypass RLS.
- Codex assignment is required because RLS, deletion semantics, and tenant repository typing are security-critical.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
