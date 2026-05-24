---
id: TKT-003
title: Observability Cost Guard
status: done
arch_ref: ARCH-001@0.2.0
component: C10 Cost, Degrade, and Observability Service
depends_on:
- TKT-001@0.1.0
- TKT-002@0.1.0
blocks:
- TKT-006@0.1.0
- TKT-007@0.1.0
- TKT-008@0.1.0
- TKT-009@0.1.0
- TKT-011@0.1.0
- TKT-014@0.1.0
estimate: M
created: 2026-04-26
updated: 2026-04-27
closed_at: 2026-04-27
closed_by: orchestrator (PO-delegated)
review_ref: null
---

# TKT-003: Observability Cost Guard

## 1. Goal (one sentence, no "and")
Implement C10 observability events, spend guard, degrade flags, metrics export.

## 2. In Scope
- Add redacted JSON event creation for all components to use.
- Add cost preflight checks using worst-case configured prices from ADR-002@0.1.0, ADR-003@0.1.0, ADR-004@0.1.0, and ADR-005@0.1.0.
- Add monthly spend counters, degrade-mode decisions, and once-per-month PO alert suppression.
- Add a local-only Prometheus-format metrics renderer with the metric names from ARCH-001@0.2.0 §8.2.
- Add tests for redaction, spend threshold behavior, concurrency-safe increments via the C3 mock, and metrics label policy.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No real Telegram send implementation; that belongs to TKT-004@0.1.0.
- No provider HTTP calls; those belong to TKT-006@0.1.0, TKT-007@0.1.0, and TKT-008@0.1.0.
- No Docker log rotation config; that belongs to TKT-013@0.1.0.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.2.0 §3.10 C10 Cost, Degrade, and Observability Service
- ARCH-001@0.2.0 §4.8 Cost, latency, and degradation
- ARCH-001@0.2.0 §8 Observability
- ARCH-001@0.2.0 §9.5 PII Handling and Deletion
- ADR-002@0.1.0
- ADR-003@0.1.0
- ADR-004@0.1.0
- ADR-005@0.1.0
- ADR-009@0.1.0
- `src/shared/types.ts`
- `src/store/tenantStore.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `src/observability/events.ts` exporting redacted event builders and log helpers
- [ ] `src/observability/costGuard.ts` exporting budget checks and degrade-mode decisions
- [ ] `src/observability/metricsEndpoint.ts` exporting a local-only metrics renderer/server factory
- [ ] `src/observability/kpiEvents.ts` exporting stable event names for K1-K7
- [ ] `tests/observability/events.test.ts`
- [ ] `tests/observability/costGuard.test.ts`
- [ ] `tests/observability/metricsEndpoint.test.ts`

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/observability/events.test.ts tests/observability/costGuard.test.ts tests/observability/metricsEndpoint.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] Tests prove raw prompt text, transcript text, audio/photo markers, Telegram tokens, provider keys, and usernames are redacted from log events.
- [ ] Tests prove projected spend above `$10` enables degrade mode and suppresses duplicate PO alerts for the same UTC month.
- [ ] Tests prove `/metrics` output contains no Telegram ID, internal `user_id`, username, meal text, or free-form error text labels.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies.
- Do NOT store raw prompts, raw transcripts, raw media bytes, provider responses, or secret values in metrics/logs.
- Use only C3 repository methods for durable observability writes.
- Metrics endpoint must bind only to an explicitly supplied loopback/internal host; never default to `0.0.0.0`.
- GLM assignment is appropriate because this ticket is bounded infrastructure logic with direct tests.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
