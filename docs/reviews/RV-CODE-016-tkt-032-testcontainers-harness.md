---
id: RV-CODE-016
type: code_review
target_pr: "https://github.com/code-yeongyu/openclown-assistant/pull/25"
ticket_ref: TKT-032@0.1.0
status: in_review
created: 2026-05-25
---

# Code Review — PR #25 (TKT-032@0.1.0)

## Summary
The PR introduces a testcontainers-based PostgreSQL integration test harness (`tests/_helpers/postgres.ts`) and rewrites two PRD-003@0.1.3 DB tests to assert DDL/RLS/index/FK characteristics against a live `postgres:17` container instead of regex-matching `src/store/schema.sql`. The harness design (per-file container lifetime, `afterAll` teardown with error-path cleanup, schema+migration application) is sound. However, one High finding — use of the removed `pg_constraint.consrc` column against `postgres:17` — blocks merge. The CHECK-constraint test will error immediately on first run. A Medium finding flags a `regclass::text` schema-qualification ambiguity in the FK tests that the RLS test (in the same file) already solves correctly with a `pg_namespace` join. One more Medium notes that the integration suite was never actually executed against a live container (Docker unavailable in sandbox). The `--exclude 'tests/db/**'` exclusion for `npm test` is wired correctly and the two-commit split satisfies the §8 DoD requirement.

## Verdict
- [ ] pass
- [ ] pass_with_changes
- [x] fail

One-sentence justification: F-H1 (`pg_constraint.consrc` removed in PG 16, the test queries it against `postgres:17`) will cause a column-not-found error on first `npm run test:integration` invocation; this is a blocking correctness defect that must be fixed before merge.
Recommendation to PO: block until F-H1 is resolved; F-M1 and F-M2 should also be addressed in the same iteration (iterate).

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT-032@0.1.0 §5 Outputs
  - `tests/_helpers/postgres.ts`, `tests/_helpers/README.md`, `tests/db/prd003_modality_schema.test.ts`, `tests/db/prd003_right_to_delete.test.ts`, `package.json` — all explicit §5 Outputs. `package-lock.json` is an expected byproduct of dev-dependency addition. `docs/tickets/TKT-032-real-postgres-integration-test-infra.md` has `status: in_review` frontmatter flip + `§10 Execution Log` appends — allowed per CONTRIBUTING.md §6 executor carve-out.
- [x] No changes to TKT §3 NOT-In-Scope items
  - `tests/store/*.test.ts` — zero diff; `migrations/` — zero diff; no CI workflow changes; no test-runner replacement.
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist
  - `testcontainers` (`^12.0.0`) and `@testcontainers/postgresql` (`^12.0.0`) added as `devDependencies` — both explicitly permitted by §7 ("Use testcontainers-node or @testcontainers/postgresql"). No runtime `dependencies` block changes.
- [ ] All Acceptance Criteria from TKT §6 are verifiably satisfied (file:line or test name cited)
  - AC #1 (`npm test` without Docker): `package.json:7` — `vitest run --exclude 'tests/db/**'`. The `--exclude` glob correctly excludes the integration test directory. ✅
  - AC #2 (`npm run test:integration` boots PG, runs both tests): executor could not execute (Docker unavailable in sandbox — see F-M2). Static analysis confirms the script (`package.json:8`: `vitest run tests/db`) targets the correct directory, and both test files wire `beforeAll` → `withPostgres()`. ⚠️ F-M2
  - AC #3 (live-DB `relrowsecurity = true` for all seven tables): `tests/db/prd003_modality_schema.test.ts:72-91` — queries `pg_class.relrowsecurity` for all seven `modalityTables` and asserts each is `true`, plus verifies all seven appeared in results. ✅
  - AC #4 (live-DB `(user_id, attribution_date_local, is_nap)` index on `sleep_records`): `tests/db/prd003_modality_schema.test.ts:121-128` — queries `pg_indexes` for `indexname = 'sleep_records_user_date_nap_idx'` and asserts row count ≥ 1. ✅
  - AC #5 (`npm run lint` clean, `npm run typecheck` clean): executor reports both clean in §10 Execution Log. ✅
  - AC #6 (container teardown reliable): `tests/_helpers/postgres.ts:80-83` — `cleanup` does `pool.end()` + `container.stop()`. `tests/_helpers/postgres.ts:85-90` — catch block ensures teardown on schema/migration failure. Both test files wire `afterAll(async () => { await cleanup(); })`. ✅
- [x] CI green (lint, typecheck, tests, coverage)
  - lint/typecheck: executor reports clean. Unit test suite: executor reports passes (2 pre-existing failures unrelated). Coverage: not separately blocking for this infra-only change.
- [ ] Definition of Done complete
  - [x] All Acceptance Criteria pass — except F-H1 and F-M1/F-M2 findings.
  - [x] PR opened with link to this TKT in description — PR #25 references TKT-032@0.1.0.
  - [x] No `TODO` / `FIXME` left in code — grep of all changed files returns zero hits.
  - [x] Executor filled §10 Execution Log — confirmed at lines 76-78 of the ticket file.
  - [x] Ticket frontmatter `status: in_review` in a separate commit — commit `5684609` is the status flip; commit `c9ecfe8` is the code. Two-commit split verified.
- [x] Ticket frontmatter `status: in_review` in a separate commit

## Findings

### High (blocking)
- **F-H1** (`tests/db/prd003_modality_schema.test.ts:234`): `pg_constraint.consrc` column was **removed in PostgreSQL 16** (per PG 16 release notes: "Remove the pg_constraint columns consrc, consrcbin, and consrcsearch"). The query `SELECT conrelid::regclass::text AS conrelid_name, consrc FROM pg_constraint WHERE contype = 'c' …` will throw `ERROR: column "consrc" does not exist` against the `postgres:17` container. The CHECK constraint test (lines 228-270) will fail immediately on first `npm run test:integration` invocation.
  — *Responsible role:* Executor.
  — *Suggested remediation:* Replace `consrc` with `pg_get_constraintdef(oid)` (the canonical PG 12+ replacement). Change the query to:
    ```sql
    SELECT conrelid::regclass::text AS conrelid_name, pg_get_constraintdef(oid) AS consrc
    FROM pg_constraint
    WHERE contype = 'c' AND …
    ```
    The downstream assertions (lines 251-269) that call `c.includes("volume_ml")`, `c.includes(">")`, etc. will continue to work because `pg_get_constraintdef` returns the same human-readable CHECK expression text.

### Medium
- **F-M1** (`tests/db/prd003_modality_schema.test.ts:162-168` and `tests/db/prd003_right_to_delete.test.ts:164-173`): `conrelid::regclass::text` and `confrelid::regclass::text` comparison ambiguity. With default PostgreSQL `search_path` (which includes `public`), `regclass::text` returns **unqualified** table names (e.g., `water_events`, `users`), NOT schema-qualified names (`public.water_events`, `public.users`). The FK tests compare against schema-qualified strings (`conrelid::regclass::text = ANY(['public.water_events', …])` and `confrelid::regclass::text = 'public.users'`), which would likely return zero rows on a default `postgres:17` container. The RLS test at lines 73-91 of the same file already solves this correctly by joining through `pg_namespace` (`n.nspname = 'public' AND c.relname = ANY(…)`).
  — *Suggested remediation:* Either (a) join through `pg_namespace` as the RLS test does, or (b) strip the `public.` prefix from the comparison arrays and use unqualified names throughout, or (c) set `search_path` explicitly at session start. Option (a) is preferred for consistency with the RLS test in the same file.

- **F-M2** (`tests/db/`): Integration tests were never exercised against a live PostgreSQL container. The executor's `§10 Execution Log` line 78 states "tests N/A (Docker not in sandbox, integration not invoked live)". All correctness analysis in this review is static. The `pass_with_changes` or `pass` verdict cannot be reached until at least ONE end-to-end run of `npm run test:integration` succeeds against `postgres:17`. The reviewer strongly recommends the orchestrator re-run the integration suite (even manually on the host) before merge.

### Low
- **F-L1** (`tests/db/prd003_right_to_delete.test.ts:310`): `rowCount` helper interpolates `table` directly into SQL via template literal: `` `SELECT count(*) AS cnt FROM ${table} WHERE user_id = $1` ``. The `table` variable comes from a hardcoded file-level `modalityDeletionTables` array and is not externally controllable, so there is no actual SQL injection risk. However, direct identifier interpolation is fragile — a one-character typo in the array value would produce a runtime error. Low severity.

- **F-L2** (`tests/_helpers/postgres.ts:68-71`): `readdirSync` on `migrations/` filters for `*.sql` files and applies them in sorted order. If any non-migration `.sql` file (e.g., `QUERIES.sql` or a backup dump) were added to `migrations/`, it would be applied to the test database unconditionally. Low severity because `migrations/` is a controlled directory, and this is test infrastructure.

## Red-team probes (Reviewer must address each)
- **Error paths:** Testcontainers daemon unavailable → `withPostgres()` throws; `catch` block (lines 85-90) ensures `pool.end()` + `container.stop()` still execute. Schema SQL parse error → caught, container cleaned. Migration SQL parse error → caught, container cleaned. These are all test-infra failures — no user data at risk. ✅ No concern.
- **Concurrency:** Vitest runs test files sequentially by default. Each file starts its own container in `beforeAll` and stops it in `afterAll`. No shared mutable state between files. Two simultaneous `npm run test:integration` invocations would each get independent containers (different ports assigned by testcontainers). ✅ No concern.
- **Input validation:** Not applicable — test infrastructure does not process external user input. Hardcoded table names and assertions. ✅ No concern.
- **Prompt injection:** Not applicable — test infrastructure does not touch LLM paths or user text. ✅ No concern.
- **Secrets:** No credentials committed. The Postgres connection URI is obtained from `container.getConnectionUri()` at runtime — never hardcoded. No `.env` or `.env.example` changes. ✅ No concern.
- **Observability:** Not applicable — test infrastructure does not emit telemetry or log to production channels. Console output from testcontainers is purely local. ✅ No concern.
- **Rollback:** If this PR ships and breaks production: `npm test` is unaffected (integration tests excluded); `npm run test:integration` might fail with the `consrc` error, but this does not impact production code. Rollback is a clean revert — no data migration dependencies. ✅ No concern.
