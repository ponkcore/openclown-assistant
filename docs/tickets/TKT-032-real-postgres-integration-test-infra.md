---
id: TKT-032
title: 'Real-Postgres integration test infrastructure (testcontainers)'
status: ready
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: Test infrastructure
depends_on: []
blocks: []
estimate: M
created: 2026-05-25
updated: 2026-05-25
---

# TKT-032: Real-Postgres integration test infrastructure (testcontainers)

## 1. Goal
Stand up `testcontainers-node`-based PostgreSQL integration tests so DDL / RLS / index assertions run against a live database instead of regex-matching `src/store/schema.sql`.

## 2. In Scope
- Add `testcontainers` (or equivalent — `@testcontainers/postgresql`) as a dev dependency.
- Create a shared test harness `tests/_helpers/postgres.ts` that boots a `postgres:17` container per test file (or per suite, whichever the executor benchmarks as faster), applies all repo migrations, and exposes a typed `PoolClient`.
- Migrate `tests/db/prd003_modality_schema.test.ts` to assert against `pg_catalog.pg_class.relrowsecurity` and `pg_indexes` directly via the live container instead of regex-matching `src/store/schema.sql`.
- Migrate `tests/db/prd003_right_to_delete.test.ts` similarly.
- Add a thin wrapper script or npm script (`npm run test:integration`) that runs only the integration suite (so unit tests still run without Docker).
- Document the prerequisite (Docker available) in the test README or root README — Architect zone forbids editing root README, so the executor places this note in `tests/_helpers/README.md`.
- CI job (`.github/workflows/`) addition or adjustment: out of scope here (architect cannot author it; the executor's TKT-032 only adds the harness).

## 3. NOT In Scope
- Migrating PRD-001@0.3.0 / PRD-002@0.2.1 store tests (`tests/store/*.test.ts`) — `tests/store/*` keeps its current regex assertions until a follow-up ticket. This ticket is scoped to the two PRD-003@0.1.3 DB tests cited in BACKLOG-001 §A2.
- Changing existing migration SQL.
- CI workflow changes (out of architect zone; if the integration suite needs CI integration, file a follow-up ticket).
- Replacing `node:test` / `vitest` / whatever the project uses as the unit-test runner.

## 4. Inputs
- ARCH-001@0.7.0 §11 Test Strategy
- BACKLOG-001 §A2 (the source finding)
- `tests/db/prd003_modality_schema.test.ts` (existing — to migrate)
- `tests/db/prd003_right_to_delete.test.ts` (existing — to migrate)
- `src/store/schema.sql` (existing — to apply against the live container)
- `package.json` (existing — for npm script wiring)
- `migrations/` directory (existing — to apply at container boot)

## 5. Outputs
- [ ] `tests/_helpers/postgres.ts` exporting a `withPostgres(testFn)` helper or equivalent.
- [ ] `tests/_helpers/README.md` documenting the prerequisite (Docker available locally).
- [ ] `tests/db/prd003_modality_schema.test.ts` rewritten to use the live-DB harness; same assertions, `pg_class.relrowsecurity` and `pg_indexes` queried directly.
- [ ] `tests/db/prd003_right_to_delete.test.ts` rewritten similarly.
- [ ] `package.json` updated with a `test:integration` script (and `testcontainers` dev dependency added).

## 6. Acceptance Criteria
- [ ] `npm test` (unit) still passes without Docker available.
- [ ] `npm run test:integration` boots a Postgres container, applies migrations, runs both PRD-003@0.1.3 DB tests, all pass.
- [ ] Live-DB query confirms `relrowsecurity = true` for all seven new tables.
- [ ] Live-DB query confirms the `(user_id, attribution_date_local, is_nap)` index on `sleep_records`.
- [ ] `npm run lint` clean. `npm run typecheck` clean.
- [ ] Container teardown is reliable (no orphaned containers after `npm run test:integration`).

## 7. Constraints
- Use `testcontainers-node` (or `@testcontainers/postgresql`) — both are MIT and well-maintained. Do NOT add a generic Docker-orchestration dependency beyond that.
- Do NOT change the SQL of existing migrations.
- Do NOT modify `tests/store/*.test.ts` in this ticket.
- Container image MUST be `postgres:17` (matches `docker-compose.yml`) and SHOULD be pinned to a digest matching ADR-019@0.1.0 / TKT-043@0.1.0 once that ticket lands; for this ticket the tag-only reference is acceptable.
- Tests MUST clean up containers on success and failure (`afterAll` hook).

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body.
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->
