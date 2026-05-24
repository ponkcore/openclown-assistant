---
id: TKT-021
title: PRD-003 modality data model migrations + RLS + right-to-delete cascade
version: 0.1.0
status: done
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
component: C-data-model
depends_on: []
blocks:
- TKT-022@0.1.0
- TKT-023@0.1.0
- TKT-029@0.1.0
- TKT-030@0.1.0
- TKT-031@0.1.0
- TKT-026@0.1.0
- TKT-027@0.1.0
- TKT-028@0.1.0
estimate: M
created: 2026-05-06
updated: 2026-05-06
---

# TKT-021: PRD-003@0.1.3 modality data model migrations + RLS + right-to-delete cascade

## 1. Goal
Land the four modality storage schemas (water / sleep / workout / mood) plus the per-modality settings table, with RLS policies and right-to-delete cascade.

## 2. In Scope
- Migration `migrations/NNN_prd003_modality_tables.sql` adding `water_events`, `sleep_records`, `sleep_pairing_state`, `workout_events`, `mood_events`, `modality_settings`, `modality_settings_audit` tables per ARCH-001@0.6.0 §5 data-model deltas.
- Per-table RLS policies following ADR-001@0.1.0 pattern (per-`user_id` row-level security).
- Composite indexes per the access pattern (see ARCH-001@0.6.0 §5 + ADR-017@0.1.0 §Decision sleep-records index).
- Extend the `/forget_me` (PRD-001@0.2.0 §5 US-8) right-to-delete transaction to cascade deletes through all seven new tables in a single transaction boundary, matching PRD-003@0.1.3 §5 US-7 acceptance.
- Schema-level smoke test that confirms every new table has RLS enabled.

## 3. NOT In Scope
- C16..C22 component implementation (split into TKT-022@0.1.0..TKT-028@0.1.0).
- Any business logic over the new tables (logging, settings flow, summary read).
- Modifications to PRD-001@0.2.0 / PRD-002@0.2.1 tables.
- Backfill of historical data (PRD-003@0.1.3 §3 NG11 forbids retroactive backfill).
- Changes to redaction allowlist (TKT-026@0.1.0 owns C10 emit-boundary extension).

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.6.0 §5 (data model deltas)
- ARCH-001@0.6.0 §3.16..§3.22 (component summaries; data shape only — no logic)
- PRD-003@0.1.3 §5 US-7 (right-to-delete acceptance bullets)
- PRD-003@0.1.3 §7 (data retention + right-to-delete scope extension)
- ADR-001@0.1.0 (Postgres + RLS pattern)
- ADR-017@0.1.0 §Decision (sleep_records + sleep_pairing_state schemas — verbatim)
- Existing `migrations/` directory; latest right-to-delete migration as the cascade-add reference

## 5. Outputs
- [ ] `migrations/NNN_prd003_modality_tables.sql` creating the seven new tables with RLS + indexes.
- [ ] `migrations/NNN_prd003_right_to_delete_cascade.sql` extending the existing `/forget_me` cascade to include the seven new tables.
- [ ] `tests/db/prd003_modality_schema.test.ts` (or equivalent integration test file under the existing test layout) verifying: (a) all seven tables created, (b) all seven have RLS enabled (PG `pg_class.relrowsecurity`), (c) the indexes from ADR-017@0.1.0 + ARCH-001@0.6.0 §5 exist, (d) inserting two rows with different `user_id` and querying as one user returns only that user's row.
- [ ] `tests/db/prd003_right_to_delete.test.ts` verifying: insert rows into all seven tables for `user_id=A`, run the `/forget_me` cascade, assert all rows for `user_id=A` deleted in a single transaction, rows for `user_id=B` untouched.

## 6. Acceptance Criteria
- [ ] `npm test -- tests/db/prd003_modality_schema.test.ts` passes.
- [ ] `npm test -- tests/db/prd003_right_to_delete.test.ts` passes.
- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean (strict).
- [ ] Migration up + down tested: `npm run migrate:up && npm run migrate:down && npm run migrate:up` reaches the same final schema (idempotent, reversible).
- [ ] Each new table has at least one RLS policy with `FOR ALL TO authenticated USING (user_id = current_setting('app.current_user_id')::bigint)` shape (mirrors ADR-001@0.1.0).
- [ ] `sleep_records` index `(user_id, attribution_date_local, is_nap)` exists (verifiable via `pg_indexes`).

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies. Use the existing migration tool already in the repo.
- Do NOT add ORMs / query-builders that aren't already used.
- Do NOT modify the existing `meals`, `users`, `summary` tables or any PRD-002@0.2.1 telemetry table — additive only.
- All migrations idempotent (use `IF NOT EXISTS` where appropriate).
- All foreign keys ON DELETE CASCADE except the cross-modality-summary table (none in this ticket).
- All `text` columns subject to PII redaction at emit (raw_workout_text, mood_comment_text, sleep_text_input — these are *stored* but redacted at emit boundary by C10; persistence is fine).
- Schema names follow the existing repo convention (snake_case, lower).
- `assigned_executor: "executor"` justified: SQL-heavy migration with foreign-key cascade ordering and RLS policy correctness (typing-heavy, security-critical per `docs/prompts/architect.md` §Phase 8 executor-assignment rule).

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body.
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
- 2026-05-24T21:55:00Z opencode-executor: started
- 2026-05-24T22:00:00Z opencode-executor: all outputs implemented; tests 20 pass (12 modality_schema + 8 right_to_delete); lint clean; typecheck clean
- 2026-05-24T22:01:00Z opencode-executor: in_review; tests 20 pass; lint clean; typecheck clean
- 2026-05-24T20:04:00Z opencode-orchestrator: merged in commit e5fff04 (PR #4); RV-CODE-001 verdict=pass_with_changes (orchestrator override after architect-consult HIGH on F-H1; F-H1/F-M1/F-M2 backlogged in BACKLOG-001)
