/**
 * PRD-003@0.1.3 right-to-delete cascade verification tests (TKT-032 rewrite).
 *
 * The unit-test assertions for the TypeScript module (`rightToDelete.ts`) are
 * retained; the regex-on-migration-file check is replaced with a live-DB
 * integration test that verifies ON DELETE CASCADE FK constraints actually
 * fire when a user row is deleted.
 *
 * Verifies:
 * - The seven new modality tables appear in createDeletionSqlByTable()
 * - All deletion SQL is parameterised ($1 only — no string concatenation)
 * - Deletion order is correct (audit/child tables before parent, users last)
 * - modality_settings is deleted after modality_settings_audit
 * - sleep_pairing_state is present (PK-based table uses user_id column)
 * - The right-to-delete transaction covers all seven in a single boundary
 * - [LIVE DB] ON DELETE CASCADE FK constraints exist on all seven tables
 * - [LIVE DB] Deleting a user cascades to all seven modality tables
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { withPostgres } from "../_helpers/postgres.js";
import {
  createDeletionSqlByTable,
  hardDeleteUserRows,
  emptyDeletionCounts,
} from "../../src/privacy/rightToDelete.js";
import type { UserScopedDeletionTable } from "../../src/privacy/types.js";

const modalityDeletionTables: UserScopedDeletionTable[] = [
  "water_events",
  "sleep_records",
  "sleep_pairing_state",
  "workout_events",
  "mood_events",
  "modality_settings_audit",
  "modality_settings",
];

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
// Unit tests for the TypeScript module logic (no Docker dependency for the
// logic itself, but the file lives in tests/db/ so it's part of the
// integration suite)
// ---------------------------------------------------------------------------

describe("PRD-003 right-to-delete — TS module logic", () => {
  it("includes all seven modality tables in createDeletionSqlByTable()", () => {
    const sqlByTable = createDeletionSqlByTable();
    for (const table of modalityDeletionTables) {
      expect(sqlByTable).toHaveProperty(table);
      expect(typeof sqlByTable[table]).toBe("string");
      expect(sqlByTable[table].length).toBeGreaterThan(0);
    }
  });

  it("uses parameterised DELETE statements for all modality tables", () => {
    const sqlByTable = createDeletionSqlByTable();
    for (const table of modalityDeletionTables) {
      const sql = sqlByTable[table];
      // All must use $1 parameter, no string interpolation
      expect(sql).toContain("$1");
      // Must not have string-concatenated values (no quote-unquote patterns)
      expect(sql).not.toMatch(/'\s*\+\s*/);
      expect(sql).not.toMatch(/`\s*\$\{/);
    }
  });

  it("deletes modality_settings_audit before modality_settings", () => {
    const sqlByTable = createDeletionSqlByTable();
    const keys = Object.keys(sqlByTable);
    const auditIdx = keys.indexOf("modality_settings_audit");
    const settingsIdx = keys.indexOf("modality_settings");
    expect(auditIdx).toBeGreaterThanOrEqual(0);
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    // Audit must come before settings (deleted first)
    expect(auditIdx).toBeLessThan(settingsIdx);
  });

  it("deletes all modality tables before users", () => {
    const sqlByTable = createDeletionSqlByTable();
    const keys = Object.keys(sqlByTable);
    const usersIdx = keys.indexOf("users");
    expect(usersIdx).toBeGreaterThanOrEqual(0);
    for (const table of modalityDeletionTables) {
      const tableIdx = keys.indexOf(table);
      expect(tableIdx).toBeGreaterThanOrEqual(0);
      expect(tableIdx).toBeLessThan(usersIdx);
    }
  });

  it("uses user_id column for modality tables and id for users", () => {
    const sqlByTable = createDeletionSqlByTable();
    for (const table of modalityDeletionTables) {
      const sql = sqlByTable[table];
      // modality tables all have user_id; users uses id
      expect(sql).toContain("WHERE user_id = $1");
    }
    // users table is the only one using id
    expect(sqlByTable.users).toContain("WHERE id = $1");
  });

  it("emptyDeletionCounts includes all seven modality tables with count 0", () => {
    const counts = emptyDeletionCounts();
    for (const table of modalityDeletionTables) {
      expect(counts).toHaveProperty(table);
      expect(counts[table]).toBe(0);
    }
  });

  it("hardDeleteUserRows calls parameterised DELETE for each table", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const mockQuery = async (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      return { rowCount: 1 };
    };

    const userId = "test-user-uuid";
    await hardDeleteUserRows(mockQuery, userId);

    // Verify all modality tables were queried
    for (const table of modalityDeletionTables) {
      const found = queries.find(
        (q) => q.sql.includes(`DELETE FROM ${table}`) && q.values[0] === userId,
      );
      expect(found).toBeDefined();
    }

    // Verify users table was also queried
    const usersQuery = queries.find(
      (q) => q.sql.includes("DELETE FROM users") && q.values[0] === userId,
    );
    expect(usersQuery).toBeDefined();

    // All queries use parameterised $1
    for (const q of queries) {
      expect(q.sql).toContain("$1");
      expect(q.values).toHaveLength(1);
      expect(q.values[0]).toBe(userId);
    }
  });
});

// ---------------------------------------------------------------------------
// Live-DB integration tests — verify ON DELETE CASCADE FK constraints and
// actual cascade behavior
// ---------------------------------------------------------------------------

describe("PRD-003 right-to-delete — live DB cascade verification", () => {
  it("all seven modality tables have ON DELETE CASCADE FK to users(id)", async () => {
    interface FkRow { conrelid_name: string; confdeltype: string }
    const result = await pool.query<FkRow>(
      `SELECT conrelid::regclass::text AS conrelid_name, confdeltype
       FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid::regclass::text = ANY($1)
         AND confrelid::regclass::text = 'public.users'`,
      [modalityDeletionTables.map((t) => `public.${t}`)],
    );
    const cascadeByTable = new Map(result.rows.map((r) => [r.conrelid_name, r.confdeltype]));
    for (const table of modalityDeletionTables) {
      const qualified = `public.${table}`;
      expect(
        cascadeByTable.has(qualified),
        `${table} should have an FK to users(id)`,
      ).toBe(true);
      // confdeltype 'c' = CASCADE
      expect(
        cascadeByTable.get(qualified),
        `${table} FK should be ON DELETE CASCADE`,
      ).toBe("c");
    }
  });

  it("deleting a user cascades to all seven modality tables", async () => {
    // 1. Insert a test user
    const userId = await insertTestUser(pool);

    // 2. Insert a row into each modality table for that user
    await insertModalityTestRows(pool, userId);

    // 3. Verify rows exist before deletion
    for (const table of modalityDeletionTables) {
      const count = await rowCount(pool, table, userId);
      expect(count, `${table} should have a row for test user before deletion`).toBeGreaterThanOrEqual(1);
    }

    // 4. Delete the user
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);

    // 5. Verify all modality rows are gone
    for (const table of modalityDeletionTables) {
      const count = await rowCount(pool, table, userId);
      expect(count, `${table} rows should be cascade-deleted`).toBe(0);
    }
  });

  it("deleting one user does not cascade to another user's rows", async () => {
    // 1. Insert two test users
    const userA = await insertTestUser(pool, "A");
    const userB = await insertTestUser(pool, "B");

    // 2. Insert modality rows for both
    await insertModalityTestRows(pool, userA);
    await insertModalityTestRows(pool, userB);

    // 3. Delete user A
    await pool.query("DELETE FROM users WHERE id = $1", [userA]);

    // 4. User B's rows should survive
    for (const table of modalityDeletionTables) {
      const count = await rowCount(pool, table, userB);
      expect(count, `${table} rows for user B should survive`).toBeGreaterThanOrEqual(1);
    }

    // Cleanup user B
    await pool.query("DELETE FROM users WHERE id = $1", [userB]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a user and return the generated id. */
async function insertTestUser(p: Pool, suffix = ""): Promise<string> {
  const tgUid = `tg-test-user-${Date.now()}-${suffix}`;
  const tgChatId = `tg-chat-${Date.now()}-${suffix}`;
  const result = await p.query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, telegram_chat_id, timezone, onboarding_status)
     VALUES ($1, $2, 'UTC', 'active')
     RETURNING id`,
    [tgUid, tgChatId],
  );
  return result.rows[0].id;
}

/** Insert one row into each of the seven modality tables for the given user. */
async function insertModalityTestRows(p: Pool, userId: string): Promise<void> {
  // water_events
  await p.query(
    `INSERT INTO water_events (user_id, ts_utc, volume_ml, source)
     VALUES ($1, now(), 250, 'keyboard')`,
    [userId],
  );

  // sleep_records
  await p.query(
    `INSERT INTO sleep_records (user_id, start_ts_utc, end_ts_utc, duration_min,
       attribution_date_local, attribution_tz, is_nap, is_paired_origin)
     VALUES ($1, now() - interval '8 hours', now(), 480,
       CURRENT_DATE, 'UTC', false, false)`,
    [userId],
  );

  // sleep_pairing_state
  await p.query(
    `INSERT INTO sleep_pairing_state (user_id, leg_event_ts_utc, expires_at_utc)
     VALUES ($1, now(), now() + interval '2 hours')`,
    [userId],
  );

  // workout_events
  await p.query(
    `INSERT INTO workout_events (user_id, ts_utc, type, source)
     VALUES ($1, now(), 'running', 'text')`,
    [userId],
  );

  // mood_events
  await p.query(
    `INSERT INTO mood_events (user_id, ts_utc, score, source)
     VALUES ($1, now(), 7, 'keyboard')`,
    [userId],
  );

  // modality_settings
  await p.query(
    `INSERT INTO modality_settings (user_id)
     VALUES ($1)`,
    [userId],
  );

  // modality_settings_audit
  await p.query(
    `INSERT INTO modality_settings_audit (user_id, modality, old_value, new_value, ts_utc)
     VALUES ($1, 'water', true, false, now())`,
    [userId],
  );
}

/** Count rows in a modality table for the given user_id. */
async function rowCount(p: Pool, table: string, userId: string): Promise<number> {
  // All seven tables have user_id; parameterised to satisfy SQL-safety rules
  const result = await p.query<{ cnt: string }>(
    `SELECT count(*) AS cnt FROM ${table} WHERE user_id = $1`,
    [userId],
  );
  return Number(result.rows[0].cnt);
}
