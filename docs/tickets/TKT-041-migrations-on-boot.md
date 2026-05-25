---
id: TKT-041
title: Wire migrations on boot (runMigrations before server.listen)
status: in_review
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: src/main.ts boot path
depends_on: []
blocks:
- TKT-040@0.1.0
estimate: S
created: 2026-05-25
updated: 2026-05-25
---

# TKT-041: Wire migrations on boot (runMigrations before server.listen)

## 1. Goal
Run pending database migrations as part of `src/main.ts startServer()` before `server.listen()`, so a fresh `docker compose up` on a clean Postgres volume boots with the schema applied without an explicit operator step.

## 2. In Scope
- In `src/main.ts` (the existing boot path — see TKT-016@0.1.0 outputs for current shape) add a `await runMigrations(pool)` call immediately after the Postgres pool is constructed and immediately before `server.listen(port)`.
- The migration runner reads from the existing `migrations/` directory and applies any unapplied migrations in lexicographic order, idempotently. If the project already has a runner, reuse it; if not, the executor implements a minimal one (read directory, query `migrations_applied` table for previously-applied filenames, apply remaining ones in transactions).
- A `migrations_applied` (or `schema_migrations` — pick one and stick to it; reuse whatever was set up in TKT-002@0.1.0 if present) tracking table is created on first boot if it does not exist.
- On migration failure, the boot path MUST log structured error and exit non-zero — never start the HTTP server with a partially-applied schema.
- The migration runner is wrapped by C13 Stall Watchdog only if migrations could plausibly stall (long migrations); for v0.1 schema migrations the runner just times out at 120 s and aborts.
- Boot smoke test in `tests/deployment/bootEntrypoint.test.ts` (per ARCH-001@0.7.0 §11.1) asserting:
  - On a fresh test DB, the server's `runMigrations` applies all migrations and the resulting schema includes the seven PRD-003@0.1.3 tables (proxied via a typecheck against `pg_class`; this part is best done with TKT-032@0.1.0 testcontainers if available, otherwise a minimal `pg-mem` or schema-string assertion).
  - When `runMigrations` throws, the server does NOT call `server.listen`.

## 3. NOT In Scope
- Adding new migrations.
- Changing the SQL of existing migrations.
- A separate `kbju-migrate` init container (rejected — see ADR-020@0.1.0 §install.sh path; same-process migration is the chosen topology fit because it removes a coordinator surface and the migrations are bounded in size).
- Backfill scripts.
- A migrate-down / rollback path.

## 4. Inputs
- ARCH-001@0.7.0 §10.4 Deploy Sequence (install.sh expects boot-time migration)
- ARCH-001@0.7.0 §11.1 Mandatory boot smoke
- TKT-002@0.1.0 outputs (existing `migrations/` setup)
- TKT-016@0.1.0 outputs (existing `src/main.ts startServer()` shape)
- BACKLOG-001 §A3 (related — migrations/004_prd003_right_to_delete_cascade.sql is a marker; not in scope to change here)

## 5. Outputs
- [ ] `src/main.ts` updated to invoke `runMigrations(pool)` before `server.listen()`.
- [ ] `src/store/runMigrations.ts` (or wherever it lives — match existing convention) implementing the runner if not already present.
- [ ] `tests/deployment/bootEntrypoint.test.ts` (or extend existing) covering the two assertions in §2.

## 6. Acceptance Criteria
- [ ] `npm test` passes.
- [ ] `npm run lint` clean. `npm run typecheck` clean.
- [ ] On a fresh Postgres test DB, `node dist/src/main.js` applies all migrations before listening.
- [ ] On a partial migration failure (simulated by injecting bad SQL via fixture), the process exits non-zero and the HTTP server does NOT bind.

## 7. Constraints
- Migrations run as the application DB role (not the `kbju_audit` BYPASSRLS role).
- Each migration is a single transaction; partial application is impossible by design.
- Do NOT add new runtime dependencies; reuse the existing pg / migration libraries.
- Do NOT change how `migrations_applied` rows are written; if TKT-002@0.1.0 set up a runner already, this ticket only WIRES it, not redesigns it.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->
- 2026-05-25T12:00:00Z opencode-executor: started
- 2026-05-25T19:40:00Z opencode-executor: in_review; tests 21 pass; lint clean; typecheck clean
