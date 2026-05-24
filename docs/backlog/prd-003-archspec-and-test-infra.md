# PRD-003 — ArchSpec amendments and test-infra gaps

Carried forward from PRD-003 ticket-cycle review findings. None of these gate code; all require either Architect amendment of approved artefacts (out of orchestrator and executor write-zones) or a separate infra ticket.

## A1. ArchSpec §5.3 + ADR-017 §Decision: `user_id: bigint` → `user_id: uuid_fk_users`

- Source finding: RV-CODE-001 F-H1 (TKT-021 review, PR #4).
- Architect-consult ratification: HIGH confidence (in-session consult by `architect-consult` subagent on 2026-05-24).
- Affected lines:
  - `docs/architecture/ARCH-001-kbju-coach-v0-1.md` §5.3 lines ~1141, 1151, 1163, 1170, 1186, 1197, 1207 (seven occurrences of `bigint` for `user_id`).
  - `docs/architecture/adr/ADR-017-sleep-midnight-spanning-and-nap-class.md` §Decision lines 180 (`sleep_records.user_id: bigint`) and 196 (`sleep_pairing_state.user_id: bigint PK`).
  - `docs/tickets/TKT-021-prd-003-modality-data-model-and-rls.md` §6 line 64 (`::bigint` in the RLS-policy AC must read `::uuid` to match the actual policy template established by TKT-002 in `src/store/schema.sql:498-545`).
- Why this is a typo and not real intent:
  - ArchSpec §5.0 line 871 declares `users.id: uuid` and lines 885 / 900 / 915 / 926 / 934 / 945 / … all existing user-owned tables declare `user_id: uuid_fk_users`.
  - ArchSpec §5.1 (the only other §5 table authored alongside §5.3) line 1108 uses `target_user_id: uuid` for the same conceptual reference.
  - The deployed RLS policy template in `src/store/schema.sql:501-546` is `current_setting('app.user_id')::uuid = user_id` for every existing user-owned table; ADR-001@0.1.0 does not specify a concrete type, only the `user_id NOT NULL` predicate.
  - PostgreSQL cannot create a `bigint` FK referencing a `uuid` PK, so the bigint declaration is structurally non-implementable against the existing `users.id`.
  - The executor (TKT-021, PR #4) used `uuid` and merged on this basis; the implementation is FK-compatible and matches every other user-owned table in the repo.
- Required action (when promoted to a Ticket): Architect produces an amended ARCH-001 vNEXT bumping §5.3 + ADR-017 §Decision to `uuid_fk_users` / `uuid PK REFERENCES users(id) ON DELETE CASCADE`, and the TKT-021 AC §6 line 64 `::bigint` is fixed to `::uuid`. No code changes required because the deployed schema is already correct.

## A2. Project-wide PostgreSQL integration test infrastructure (testcontainers)

- Source finding: RV-CODE-001 F-M1 (TKT-021 review).
- Existing convention: every `tests/store/*.test.ts` and the new `tests/db/prd003_*.test.ts` files verify DDL via regex/string matching of `src/store/schema.sql` rather than executing against a live PostgreSQL. This is consistent across the repo and predates PRD-003.
- Gap: AC §6 lines 64–65 of TKT-021 reference `pg_class.relrowsecurity` and `pg_indexes` — implying live-DB verification — but no `testcontainers` or equivalent harness exists.
- Required action (when promoted to a Ticket): introduce a `testcontainers-node`-style harness and migrate `tests/store/*` and `tests/db/prd003_*.test.ts` to assert against `pg_catalog` directly. Should be scoped to its own infra ticket; not specific to PRD-003.

## A3. `migrations/004_prd003_right_to_delete_cascade.sql` — marker-only file

- Source finding: RV-CODE-001 F-M2 (TKT-021 review).
- Current state: 14 lines of comment-only SQL because the actual cascade is implemented in TypeScript at `src/privacy/rightToDelete.ts:createDeletionSqlByTable()` (the existing TKT-002 right-to-delete pattern).
- Two acceptable resolutions:
  1. Replace the file's body with the real `DELETE FROM water_events WHERE user_id = $1; …` statements so the migration carries actionable SQL (defensive: matches §5 Output filename intent literally).
  2. Rename to `migrations/004_prd003_right_to_delete_cascade_marker.sql` and document explicitly that the cascade is TypeScript-owned; a future architecture decision for "all right-to-delete cascade SQL must live in migrations" would deprecate the TS pattern uniformly across PRD-001 + PRD-003.
- Required action (when promoted to a Ticket): Architect picks resolution; orchestrator does not.
