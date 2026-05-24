---
id: TKT-017
title: G1 tenant-isolation breach detector
version: 0.1.0
status: done
arch_ref: ARCH-001@0.5.0
prd_ref: PRD-002@0.2.1
created: 2026-05-04
updated: 2026-05-05
---

# TKT-017: G1 tenant-isolation breach detector

## 1. Goal
Detect and alert on every synthetic or real cross-tenant storage access within PRD-002@0.2.1 G1 timing bounds.

## 2. In Scope
- Add C12 breach detector at the C3 repository boundary or the narrowest equivalent data-access boundary.
- Emit redacted structured breach events and metrics.
- Surface sidecar health count `breach_count_last_hour`.
- Add synthetic breach tests for read and write paths.

## 3. NOT In Scope
- No new database table unless Executor proves durable storage is required; ARCH-001@0.5.0 treats `breach_events` as ephemeral logged/metered events.
- No `AUDIT_DB_URL` import in application request handlers.
- No broad Proxy magic if explicit typed wrappers are clearer and safer.
- No remediation or data repair for detected breaches.

## 4. Inputs
- ARCH-001@0.5.0 §0.6, §3.3, §3.12, §5.1, §8, §9.2.
- ADR-001@0.1.0 and PRD-002@0.2.1 §2 G1.
- `src/store/tenantStore.ts`, `src/store/types.ts`, `src/privacy/tenantAudit.ts`.
- `src/observability/events.ts`, `src/observability/kpiEvents.ts`.
- Tests under `tests/store/**`, `tests/privacy/**`, and `tests/observability/**`.

## 5. Outputs
- [ ] `src/observability/breachDetector.ts` or equivalent C12 implementation.
- [ ] Metric name added to `src/observability/kpiEvents.ts` if absent.
- [ ] Sidecar health integration exposing `breach_count_last_hour`.
- [ ] Tests proving same-tenant access passes, cross-tenant read fires a breach, and cross-tenant write fires a breach.
- [ ] Tests proving breach logs/metrics do not include raw meal text, usernames, transcripts, or provider payloads.

## 6. Acceptance Criteria
- [ ] Synthetic cross-tenant read emits one `kbju_tenant_breach_detected` event within 5 minutes p95 in the test clock or within 30 seconds in a deterministic fake-timer test.
- [ ] Synthetic cross-tenant write emits one `kbju_tenant_breach_detected` event and returns/propagates `tenant_not_allowed` or an equivalent typed denial.
- [ ] Same-tenant read/write emits zero breach events.
- [ ] `GET /kbju/health` includes numeric `breach_count_last_hour`.
- [ ] No serialized breach event contains raw user payload fields; tests assert forbidden fields are absent.
- [ ] `npm run lint`, `npm run typecheck`, targeted tests, and `python3 scripts/validate_docs.py` pass.

## 7. Constraints
- Source: synthesized from PR-C C12 boundary and PR-B G1 timing; PR-A's runtime telemetry naming was retained only as non-load-bearing input.
- C12 is a bug alarm; it must not become a user-facing recovery workflow.
- Prefer typed wrappers over `getattr`/dynamic property traversal.

## 8. Definition of Done
- [ ] All §6 Acceptance Criteria pass.
- [ ] PR opened with this ticket referenced as `TKT-017@0.1.0`.
- [ ] No `TODO` / `FIXME` is left without a follow-up backlog note in the PR body.
- [ ] Executor fills §10 Execution Log before hand-back.
- [ ] Ticket frontmatter `status` is promoted to `in_review` in a separate commit.
