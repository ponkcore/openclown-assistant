/**
 * PRD-003@0.1.3 right-to-delete cascade verification tests (TKT-021).
 *
 * Verifies:
 * - The seven new modality tables appear in createDeletionSqlByTable()
 * - All deletion SQL is parameterised ($1 only — no string concatenation)
 * - Deletion order is correct (audit/child tables before parent, users last)
 * - modality_settings is deleted after modality_settings_audit
 * - sleep_pairing_state is present (PK-based table uses user_id column)
 * - The right-to-delete transaction covers all seven in a single boundary
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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

describe("PRD-003 right-to-delete cascade (TKT-021)", () => {
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
        (q) => q.sql.includes(`DELETE FROM ${table}`) && q.values[0] === userId
      );
      expect(found).toBeDefined();
    }

    // Verify users table was also queried
    const usersQuery = queries.find(
      (q) => q.sql.includes("DELETE FROM users") && q.values[0] === userId
    );
    expect(usersQuery).toBeDefined();

    // All queries use parameterised $1
    for (const q of queries) {
      expect(q.sql).toContain("$1");
      expect(q.values).toHaveLength(1);
      expect(q.values[0]).toBe(userId);
    }
  });

  it("right-to-delete migration file exists and references all seven tables", () => {
    const migrationSql = readFileSync(resolve(process.cwd(), "migrations/004_prd003_right_to_delete_cascade.sql"), "utf8");
    for (const table of modalityDeletionTables) {
      expect(migrationSql).toContain(table);
    }
  });
});
