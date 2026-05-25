/**
 * PRD-003@0.1.3 modality schema verification tests (TKT-032 rewrite).
 *
 * All assertions now query a live PostgreSQL container instead of
 * regex-matching `src/store/schema.sql`. The harness is provided by
 * `tests/_helpers/postgres.ts`.
 *
 * Verifies:
 * (a) all seven tables exist in the live DB
 * (b) all seven have RLS enabled  (pg_class.relrowsecurity)
 * (c) per-table RLS policies with user_id isolation pattern per ADR-001@0.1.0
 * (d) the indexes from ADR-017@0.1.0 + ARCH-001@0.7.0 §5.3 exist
 * (e) user_id FK with ON DELETE CASCADE on every modality table
 * (f) GRANT CRUD to kbju_app, SELECT to kbju_audit
 * (g) CHECK constraints per ARCH-001@0.7.0 §5.3
 * (h) modality_settings flags default to true
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool, QueryResultRow } from "pg";
import { withPostgres } from "../_helpers/postgres.js";

const modalityTables = [
  "water_events",
  "sleep_records",
  "sleep_pairing_state",
  "workout_events",
  "mood_events",
  "modality_settings",
  "modality_settings_audit",
] as const;

type ModalityTable = (typeof modalityTables)[number];

/** Tables where user_id is the PK (not a separate FK column). */
const pkUserIdTables = new Set<ModalityTable>(["modality_settings", "sleep_pairing_state"]);

let pool: Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await withPostgres();
  pool = ctx.pool;
  cleanup = ctx.cleanup;
}, 120_000);

afterAll(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------
// (a) Table existence
// ---------------------------------------------------------------------------

describe("PRD-003 modality schema — live DB (TKT-032)", () => {
  it("creates all seven modality tables", async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [modalityTables],
    );
    const found = new Set(result.rows.map((r) => r.table_name));
    for (const table of modalityTables) {
      expect(found.has(table), `${table} should exist in information_schema.tables`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // (b) RLS enabled — pg_class.relrowsecurity
  // -------------------------------------------------------------------------

  it("enables RLS on all seven modality tables (pg_class.relrowsecurity = true)", async () => {
    const result = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [modalityTables],
    );
    for (const row of result.rows) {
      expect(
        row.relrowsecurity,
        `${row.relname} should have relrowsecurity = true`,
      ).toBe(true);
    }
    // Verify we got rows for all seven tables
    const found = new Set(result.rows.map((r) => r.relname));
    for (const table of modalityTables) {
      expect(found.has(table), `${table} should appear in pg_class`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // (c) RLS policies — pg_policy
  // -------------------------------------------------------------------------

  it("creates per-table RLS policies with user_id isolation pattern per ADR-001@0.1.0", async () => {
    for (const table of modalityTables) {
      const policyName = `${table}_user_id_isolation`;
      const result = await pool.query<{ polname: string }>(
        `SELECT p.polname
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = $1
           AND p.polname = $2`,
        [table, policyName],
      );
      expect(
        result.rows.length,
        `${table} should have policy ${policyName}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  // -------------------------------------------------------------------------
  // (d) Indexes — pg_indexes
  // -------------------------------------------------------------------------

  it("creates the mandatory (user_id, attribution_date_local, is_nap) index on sleep_records per ADR-017@0.1.0 §Decision", async () => {
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'sleep_records'
         AND indexname = 'sleep_records_user_date_nap_idx'`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("creates the (user_id, ts_utc DESC) index on water_events, workout_events, mood_events", async () => {
    const tsIdxTables: ModalityTable[] = ["water_events", "workout_events", "mood_events"];
    for (const table of tsIdxTables) {
      const idxName = `${table}_user_ts_idx`;
      const result = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = $1 AND indexname = $2`,
        [table, idxName],
      );
      expect(result.rows.length, `${table} should have index ${idxName}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("creates the (user_id, ts_utc DESC) index on modality_settings_audit", async () => {
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'modality_settings_audit'
         AND indexname = 'modality_settings_audit_user_ts_idx'`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // (e) user_id FK with ON DELETE CASCADE — pg_constraint + pg_namespace
  //     (pg_namespace join pattern consistent with RLS test above,
  //      avoiding regclass::text schema-qualification ambiguity)
  // -------------------------------------------------------------------------

  it("requires user_id with ON DELETE CASCADE on every modality table", async () => {
    interface FkRow extends QueryResultRow {
      relname: string;
      confdeltype: string;
    }
    const result = await pool.query<FkRow>(
      `SELECT cf.relname, cn.confdeltype
       FROM pg_constraint cn
       JOIN pg_class cf ON cf.oid = cn.conrelid
       JOIN pg_namespace nf ON nf.oid = cf.relnamespace
       JOIN pg_class cp ON cp.oid = cn.confrelid
       JOIN pg_namespace np ON np.oid = cp.relnamespace
       WHERE cn.contype = 'f'
         AND nf.nspname = 'public'
         AND cf.relname = ANY($1)
         AND np.nspname = 'public'
         AND cp.relname = 'users'`,
      [modalityTables],
    );

    const cascadeByTable = new Map(result.rows.map((r) => [r.relname, r.confdeltype]));
    for (const table of modalityTables) {
      expect(
        cascadeByTable.has(table),
        `${table} should have an FK to users(id)`,
      ).toBe(true);
      // confdeltype 'c' = CASCADE
      expect(
        cascadeByTable.get(table),
        `${table} FK should be ON DELETE CASCADE`,
      ).toBe("c");
    }
  });

  // -------------------------------------------------------------------------
  // (f) GRANT CRUD to kbju_app, SELECT to kbju_audit
  // -------------------------------------------------------------------------

  it("grants CRUD to kbju_app and SELECT to kbju_audit for all seven tables", async () => {
    for (const table of modalityTables) {
      // kbju_app should have SELECT, INSERT, UPDATE, DELETE
      const appResult = await pool.query<{ privilege_type: string }>(
        `SELECT privilege_type
         FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name = $1
           AND grantee = 'kbju_app'
           AND privilege_type = ANY($2)`,
        [table, ["SELECT", "INSERT", "UPDATE", "DELETE"]],
      );
      const appPrivs = new Set(appResult.rows.map((r) => r.privilege_type));
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect(appPrivs.has(priv), `kbju_app should have ${priv} on ${table}`).toBe(true);
      }

      // kbju_audit should have SELECT
      const auditResult = await pool.query<{ privilege_type: string }>(
        `SELECT privilege_type
         FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND table_name = $1
           AND grantee = 'kbju_audit'
           AND privilege_type = 'SELECT'`,
        [table],
      );
      expect(
        auditResult.rows.length,
        `kbju_audit should have SELECT on ${table}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  // -------------------------------------------------------------------------
  // (g) CHECK constraints — pg_get_constraintdef (PG 12+ replacement for
  //     removed consrc column). Assertions use substring matching because
  //     PG canonicalises CHECK expressions (e.g. "x > 0" may become
  //     "x > 0" or "(x > 0)" depending on version).
  // -------------------------------------------------------------------------

  it("enforces CHECK constraints per ARCH-001@0.7.0 §5.3", async () => {
    interface CheckRow extends QueryResultRow {
      relname: string;
      constraintdef: string;
    }
    const result = await pool.query<CheckRow>(
      `SELECT cf.relname, pg_get_constraintdef(cn.oid) AS constraintdef
       FROM pg_constraint cn
       JOIN pg_class cf ON cf.oid = cn.conrelid
       JOIN pg_namespace nf ON nf.oid = cf.relnamespace
       WHERE cn.contype = 'c'
         AND nf.nspname = 'public'
         AND cf.relname IN ('water_events', 'sleep_records', 'mood_events')`,
    );
    const checksByTable = new Map<string, string[]>();
    for (const row of result.rows) {
      const existing = checksByTable.get(row.relname) ?? [];
      existing.push(row.constraintdef);
      checksByTable.set(row.relname, existing);
    }

    // water_events volume_ml: 0 < volume_ml <= 5000
    // PG canonicalises to e.g. CHECK ((volume_ml > 0 AND volume_ml <= 5000))
    const waterChecks = checksByTable.get("water_events") ?? [];
    expect(
      waterChecks.some((c) => c.includes("volume_ml") && c.includes(">") && c.includes("<=")),
      "water_events should have CHECK on volume_ml",
    ).toBe(true);

    // sleep_records duration_min: 30 <= duration_min <= 1440
    const sleepChecks = checksByTable.get("sleep_records") ?? [];
    expect(
      sleepChecks.some((c) => c.includes("duration_min") && c.includes(">=")),
      "sleep_records should have CHECK on duration_min",
    ).toBe(true);

    // mood_events score: 1 <= score <= 10
    const moodChecks = checksByTable.get("mood_events") ?? [];
    expect(
      moodChecks.some((c) => c.includes("score") && c.includes(">=")),
      "mood_events should have CHECK on score",
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (h) modality_settings defaults — information_schema.columns
  // -------------------------------------------------------------------------

  it("defaults all four modality flags to true in modality_settings per PRD-003@0.1.3 §5 US-5", async () => {
    const flagColumns = ["water_on", "sleep_on", "workout_on", "mood_on"];
    const result = await pool.query<{ column_name: string; column_default: string }>(
      `SELECT column_name, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'modality_settings'
         AND column_name = ANY($1)`,
      [flagColumns],
    );
    const defaults = new Map(result.rows.map((r) => [r.column_name, r.column_default]));
    for (const col of flagColumns) {
      expect(defaults.has(col), `modality_settings.${col} should exist`).toBe(true);
      expect(defaults.get(col), `modality_settings.${col} should default to true`).toContain("true");
    }
  });
});
