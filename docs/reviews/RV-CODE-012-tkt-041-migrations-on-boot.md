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
- [ ] pass
- [x] pass_with_changes
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
