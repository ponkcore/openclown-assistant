---
id: BACKLOG-006
title: Run TKT-032 testcontainers integration suite on a Docker-capable host
status: open
spec_ref: TKT-032@0.1.0
created: 2026-05-25
---

# BACKLOG-006: Live `npm run test:integration` invocation pending

Carried forward from RV-CODE-016 finding F-M2 (verdict `pass_with_changes` after iter 2).

## Summary
TKT-032@0.1.0 stood up the `tests/_helpers/postgres.ts` testcontainers harness, rewrote `tests/db/prd003_modality_schema.test.ts` and `tests/db/prd003_right_to_delete.test.ts` to query the live container, and added a `npm run test:integration` script that excludes the integration suite from the default `npm test`. The implementation was validated statically (lint, typecheck, unit-test parity, code-review against `postgres:17` semantics — including the iter-2 fix replacing `pg_constraint.consrc` with `pg_get_constraintdef`). However the suite was never invoked against a real Postgres container in this PRD walk because the orchestrator's local sandbox does not expose a Docker daemon.

## Why backlogged (not iterated)
The §6 Acceptance Criteria #1 ("`npm test` (unit) still passes without Docker available") is satisfied. AC #2-#4 ("integration suite boots a container and asserts RLS / index / FK") are statically correct against `postgres:17` per RV-CODE-016 iter-2 review. The remaining work is just running the suite once in a Docker-capable environment to confirm no further static-vs-live drift, then closing this entry.

## Follow-up
- On a developer machine or CI runner with Docker available, run `npm run test:integration` from `main`.
- Expected: harness boots `postgres:17`, applies all migrations, both test files pass green, container is cleaned up (no orphans).
- If any test fails at runtime, file an iter-3 fix-up patch on its own ticket.
- A future ticket may also wire the integration suite into a CI workflow under `.github/workflows/` (out of architect zone for TKT-032@0.1.0; the executor was correctly forbidden from creating CI workflows in §3 NOT-In-Scope of TKT-032@0.1.0).

## Status
- 2026-05-25 BACKLOG-006 opened during TKT-032 close-out.
