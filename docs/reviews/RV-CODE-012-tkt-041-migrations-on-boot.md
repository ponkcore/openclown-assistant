---
id: RV-CODE-012
type: code_review
target_pr: "https://github.com/code-yeongyu/openclown-assistant/pull/21"
ticket_ref: TKT-041@0.1.0
status: in_review
created: 2026-05-25
---

# Code Review — PR #21 (TKT-041@0.1.0)

## Summary
The executor wired `runMigrations(pool)` into `startServer()` immediately after pool creation and before `server.listen()`, converting `startServer` from synchronous to `async`. The implementation correctly gates the HTTP server on migration success, exits non-zero on failure, and respects the existing `migrations/` directory convention. Three new bootEntrypoint tests validate the schema-string assertion and the fail-fast behaviour. The `status: in_review` flip is in a separate commit. Two Medium findings (missing 120 s timeout, pool lifecycle gap) and a few Low nits remain — none block merge.

## Verdict
- [x] pass
- [ ] pass_with_changes
- [ ] fail

One-sentence justification: Core wiring is correct and all TKT-041 ACs met, but the 120 s timeout promised in TKT-041@0.1.0 §2 is not implemented, and the PG pool is never closed on the success path.
Recommendation to PO: approve & merge with Medium findings backlogged for a fast-follow TKT.

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT §5 Outputs (`src/main.ts`, `tests/deployment/bootEntrypoint.test.ts`, plus the ticket file's frontmatter + §10 Execution Log — all allowed).
- [x] No changes to TKT §3 NOT-In-Scope items (no new migrations, no SQL changes to existing migrations, no `kbju-migrate` init container, no backfill, no rollback).
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist (`package.json` and `package-lock.json` unchanged).
- [x] All Acceptance Criteria from TKT §6 are verifiably satisfied:
  - `npm test` passes — all 21 bootEntrypoint tests pass (the 3 pre-existing failures in `healthCheck.test.ts` / `allowlist.test.ts` are unrelated).
  - `npm run lint` clean — `tsc --noEmit` passes with no errors.
  - `npm run typecheck` clean — same `tsc --noEmit` pass.
  - Fresh-DB migration before listening: `tests/deployment/bootEntrypoint.test.ts:506-535` schema-string assertion validates all 7 `PRD-003@0.1.3` tables; `tests/deployment/bootEntrypoint.test.ts:583-624` verifies `runMigrations` called and `server.listening` true.
  - Migration-failure → exit non-zero + no bind: `tests/deployment/bootEntrypoint.test.ts:537-581` simulates `runMigrations` throwing, asserts `process.exit(1)`, and asserts `server.listen` never called.
- [x] CI green (lint, typecheck, tests for TKT-041 — 3 pre-existing test failures are unrelated).
- [x] Definition of Done complete (`§10 Execution Log` filled, PR opened).
- [x] Ticket frontmatter `status: in_review` in a separate commit (commit `529fd91` is dedicated to the flip only).

## Findings

### High (blocking)
None.

### Medium
- **F-M1 (`src/main.ts:278-287`): Missing 120 s timeout.** TKT-041@0.1.0 §2 states: *"for v0.1 schema migrations the runner just times out at 120 s and aborts."* The `Pool` is instantiated without `connectionTimeoutMillis`, `statement_timeout`, or a `Promise.race` wrapper. If a migration hangs on a DB lock or Postgres outage, `startServer` will hang indefinitely instead of exiting at 120 s. — *Responsible role:* Executor. *Suggested remediation:* Add `statement_timeout: 120000` to the Pool config, or wrap `runMigrations(pool)` in a `Promise.race` with a 120 s timer.

- **F-M2 (`src/main.ts:278-287`): PG pool not closed after successful migration.** The `pool` created for `runMigrations` is only `pool.end()`-ed in the error path (line 284). On the success path, the pool object and its default connection-pool machinery remain alive for the process lifetime. While the default `idleTimeoutMillis` (10 s) will evict idle connections, the pool object itself is leaked and the TCP keep-alive overhead persists. Since `createSidecarDeps` manages its own DB access, this pool should be closed immediately after a successful migration. — *Responsible role:* Executor. *Suggested remediation:* Add `await pool.end()` after the `try` block on the success path, or store the pool as a module-level variable to be reused by `createSidecarDeps` if those deps need the same pool.

### Low
- **F-L1 (`src/main.ts:283`): Error details logged to console.error may include SQL content.** On migration failure, the raw `err` from `runMigrations` (which bubbles up from pg `query()`) is passed directly to `console.error`. While pg errors do not typically leak credentials, they can contain the full SQL statement text. This is a development-console concern but worth noting for production hardening. *Suggested remediation:* Strip or redact `err` before logging, or log only `err.message`.

- **F-L2 (`src/main.ts:281`): No success log after migrations applied.** If migrations succeed, the process silently proceeds to `server.listen`. The only boot log is *"KBJU sidecar listening on port NNN"*. A 3am operator troubleshooting a `docker compose up` would have to infer migration success from the absence of the error log. *Suggested remediation:* Add a `console.log("Migrations applied successfully")` or structured event emission after `await runMigrations(pool)`.

- **F-L3 (`src/main.ts:278`): Config null-path silently skips migrations.** When `parseConfig` throws (and the inner catch sets `config = null`), the `config?.databaseUrl` guard evaluates to `undefined` and migrations are skipped. While this is correct behaviour — no DB URL means no DB to migrate — the silence is inconsistent with the ticket's requirement for *"structured error"* logging. If this is intentional (no DB in dev mode), it should be documented rather than silent. *Suggested remediation:* Add a `console.warn("No DATABASE_URL configured; skipping migrations")` in the `else` branch, or handle the null-config case explicitly.

## Red-team probes (Reviewer must address each)
- **Error paths (Postgres failure, DB lock, LLM timeout):** If Postgres is unreachable when `runMigrations` runs its first query, the pg library throws — caught by the `try/catch`, logged, `pool.end()`, `process.exit(1)`. If a DB lock stalls a migration, the process hangs indefinitely (see **F-M1**). No LLM is involved in the migration path — not applicable. On `pool.end()` failure in the error path (line 284), the `.catch(() => {})` silently swallows it — acceptable since we are already exiting.
- **Concurrency:** `startServer()` is called once at boot (self-invoke at `src/main.ts:318` or via test). No concurrent migration concern. The HTTP server is not created until after migrations succeed, so no request can race with an un-migrated schema.
- **Input validation:** The migration path reads SQL from disk (`migrations/*.sql`, `src/store/schema.sql`). No user input reaches this code path — not applicable.
- **Prompt injection:** No external user text reaches `runMigrations` or the Pool instantiation. The `databaseUrl` comes from `parseConfig(process.env)` which is operator-controlled, not user-controlled. Not applicable.
- **Secrets:** `config.databaseUrl` contains the DB password. It is not logged directly. The only logging is `console.error("Migration failed; refusing to start HTTP server:", err)` — see **F-L1** for the SQL-content concern. No credentials committed in the diff.
- **Observability:** Errors are logged with `console.error`. Success is silent (see **F-L2**). A 3am operator sees either the *"KBJU sidecar listening"* message (implies migrations OK) or the *"Migration failed"* error (implies crash). The absence of structured-event emission and metric increment is acceptable for v0.1 given the scope of this ticket — the existing `src/observability/events.ts` is not invoked in the boot path for migrations, but the ticket does not require it.
- **Rollback:** If this PR breaks production, the rollback is obvious: revert the `src/main.ts` changes to remove the `await runMigrations(pool)` block and the `async` signature. The migration runner itself (`src/store/migrations.ts`) is unchanged. The `install.sh` sequence (ARCH-001@0.7.0 §10.4 step 9) already expects `runMigrations` to be wired in — so a rollback would require manual `docker compose exec` migration application in the interim.

## Iteration 2 — re-review

**Fix-up commit:** `f210cab` — addresses F-M1 and F-M2 from iteration 1.

### F-M1 (120 s timeout) — RESOLVED ✅

`src/main.ts:21-26` adds `getMigrationTimeoutMs()` which reads `KBJU_MIGRATION_TIMEOUT_MS` env var (default 120000 ms, per TKT-041@0.1.0 §2). `src/main.ts:294-304` wraps `runMigrations(pool)` in a `Promise.race` against an `AbortController` timer, producing a `"Migration timed out after N ms"` error on expiry. The `clearTimeout(timeout)` is called in both the catch block (line 309) and after the try/catch on the success path (line 314). A new test (`tests/deployment/bootEntrypoint.test.ts:627-675`) uses `KBJU_MIGRATION_TIMEOUT_MS=50` to inject a 10-second-long mock migration, verifies `process.exit(1)` is called and `server.listen` is never invoked — test passes.

### F-M2 (pool close on success) — RESOLVED ✅

`src/main.ts:307` adds `await pool.end()` immediately after `runMigrations` succeeds and before `server.listen()`. The pool is now closed on both the success path (line 307) and the failure path (line 311). The comment at line 305–306 documents that `createSidecarDeps` manages its own DB access separately.

### New findings (iter-2 diff only)

None that block. Two minor observations:

- **F-L4** (`tests/deployment/bootEntrypoint.test.ts:627-675`): The new timeout test is placed outside the `describe("TKT-041: runMigrations on boot")` block (which closed at line 625) and therefore does not use the describe's `beforeEach`/`afterEach` env-var snapshot/restore. It sets `SERVER_PORT=0` and other env vars manually but only cleans up `KBJU_MIGRATION_TIMEOUT_MS` in `finally`. Since it is the last test in the file, the practical impact is negligible — no cross-test pollution within `bootEntrypoint.test.ts`. Refiling the test inside the describe block (or adding its own env-var cleanup) would be tidier but does not affect correctness. **Severity: Low.**

- **F-L5** (`src/main.ts:309, 314`): `clearTimeout(timeout)` is called both inside the `catch` block and unconditionally after the `try`/`catch`. On the failure path this results in a double clear (line 309 then, after `process.exit(1)`, line 314 is unreachable — moot). On the success path only line 314 fires. This is correct but the redundant clear in the catch block is confusing to read. **Severity: Low — cosmetic.**

### Updated verdict

Both Medium findings from iteration 1 (F-M1, F-M2) are resolved in commit `f210cab`. All 22 bootEntrypoint tests pass (including the new timeout test). Typecheck and lint are clean. No new High or Medium findings introduced.

**Verdict: pass**
**Recommendation: merge**
