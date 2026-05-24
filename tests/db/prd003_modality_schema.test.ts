/**
 * PRD-003@0.1.3 modality schema verification tests (TKT-021).
 *
 * Verifies:
 * (a) all seven tables created in schema.sql
 * (b) all seven have RLS enabled
 * (c) the indexes from ADR-017@0.1.0 + ARCH-001@0.6.1 §5.3 exist
 * (d) the migration SQL file also defines all seven tables
 * (e) inserting two rows with different user_id and querying as one user
 *     returns only that user's row (RLS isolation — verified via
 *     policy shape, since we lack a running PG in unit tests)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const schemaSql = readFileSync(resolve(process.cwd(), "src/store/schema.sql"), "utf8");
const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/003_prd003_modality_tables.sql"),
  "utf8"
);

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

describe("PRD-003 modality schema (TKT-021)", () => {
  it("creates all seven modality tables in schema.sql", () => {
    for (const table of modalityTables) {
      expect(schemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(tableBlock(schemaSql, table)).not.toHaveLength(0);
    }
  });

  it("creates all seven modality tables in the migration SQL file", () => {
    for (const table of modalityTables) {
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("requires user_id with ON DELETE CASCADE on every modality table", () => {
    for (const table of modalityTables) {
      const block = tableBlock(schemaSql, table);
      if (pkUserIdTables.has(table)) {
        // PK-as-user_id: user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
        expect(block).toMatch(
          /\buser_id\s+UUID\s+PRIMARY\s+KEY\s+REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE\b/i
        );
      } else {
        // Standard: user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
        expect(block).toMatch(
          /\buser_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE\b/i
        );
      }
    }
  });

  it("enables RLS on all seven modality tables in schema.sql", () => {
    for (const table of modalityTables) {
      expect(schemaSql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
  });

  it("enables RLS on all seven modality tables in migration SQL", () => {
    for (const table of modalityTables) {
      expect(migrationSql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
  });

  it("creates per-table RLS policies with user_id isolation pattern per ADR-001@0.1.0", () => {
    for (const table of modalityTables) {
      const policyName = `${table}_user_id_isolation`;
      // schema.sql
      expect(schemaSql).toMatch(
        new RegExp(
          `CREATE POLICY ${escapeRegExp(policyName)} ON ${escapeRegExp(table)} FOR ALL USING \\(current_setting\\('app\\.user_id'\\)::uuid = user_id\\) WITH CHECK \\(current_setting\\('app\\.user_id'\\)::uuid = user_id\\)`,
          "i"
        )
      );
      // migration SQL
      expect(migrationSql).toMatch(
        new RegExp(
          `CREATE POLICY ${escapeRegExp(policyName)} ON ${escapeRegExp(table)} FOR ALL USING \\(current_setting\\('app\\.user_id'\\)::uuid = user_id\\) WITH CHECK \\(current_setting\\('app\\.user_id'\\)::uuid = user_id\\)`,
          "i"
        )
      );
    }
  });

  it("creates the mandatory (user_id, attribution_date_local, is_nap) index on sleep_records per ADR-017@0.1.0 §Decision", () => {
    // schema.sql
    expect(schemaSql).toContain(
      "CREATE INDEX IF NOT EXISTS sleep_records_user_date_nap_idx ON sleep_records (user_id, attribution_date_local, is_nap)"
    );
    // migration SQL
    expect(migrationSql).toContain(
      "CREATE INDEX IF NOT EXISTS sleep_records_user_date_nap_idx ON sleep_records (user_id, attribution_date_local, is_nap)"
    );
  });

  it("creates the (user_id, ts_utc DESC) index on water_events, workout_events, mood_events", () => {
    const tsIdxTables = ["water_events", "workout_events", "mood_events"] as const;
    for (const table of tsIdxTables) {
      const idxName = `${table}_user_ts_idx`;
      const expected = `CREATE INDEX IF NOT EXISTS ${idxName} ON ${table} (user_id, ts_utc DESC)`;
      expect(schemaSql).toContain(expected);
      expect(migrationSql).toContain(expected);
    }
  });

  it("creates the (user_id, ts_utc DESC) index on modality_settings_audit", () => {
    const expected =
      "CREATE INDEX IF NOT EXISTS modality_settings_audit_user_ts_idx ON modality_settings_audit (user_id, ts_utc DESC)";
    expect(schemaSql).toContain(expected);
    expect(migrationSql).toContain(expected);
  });

  it("grants CRUD to kbju_app and SELECT to kbju_audit for all seven tables", () => {
    for (const table of modalityTables) {
      // kbju_app gets SELECT, INSERT, UPDATE, DELETE
      expect(schemaSql).toMatch(
        new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON .*\\b${escapeRegExp(table)}\\b.*TO kbju_app`)
      );
      // kbju_audit gets SELECT
      expect(schemaSql).toMatch(
        new RegExp(`GRANT SELECT ON .*\\b${escapeRegExp(table)}\\b.*TO kbju_audit`)
      );
    }
    // migration SQL also has grants
    for (const table of modalityTables) {
      expect(migrationSql).toMatch(
        new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON .*\\b${escapeRegExp(table)}\\b.*TO kbju_app`)
      );
      expect(migrationSql).toMatch(
        new RegExp(`GRANT SELECT ON .*\\b${escapeRegExp(table)}\\b.*TO kbju_audit`)
      );
    }
  });

  it("enforces CHECK constraints per ARCH-001@0.6.1 §5.3", () => {
    // water_events volume_ml: 0 < volume_ml <= 5000
    expect(tableBlock(schemaSql, "water_events")).toMatch(
      /volume_ml\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*volume_ml\s*>\s*0\s+AND\s+volume_ml\s*<=\s*5000\s*\)/i
    );
    // sleep_records duration_min: 30 <= duration_min <= 1440
    expect(tableBlock(schemaSql, "sleep_records")).toMatch(
      /duration_min\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*duration_min\s*>=\s*30\s+AND\s+duration_min\s*<=\s*1440\s*\)/i
    );
    // mood_events score: 1 <= score <= 10
    expect(tableBlock(schemaSql, "mood_events")).toMatch(
      /score\s+INTEGER\s+NOT\s+NULL\s+CHECK\s*\(\s*score\s*>=\s*1\s+AND\s+score\s*<=\s*10\s*\)/i
    );
    // mood_events comment_text: length <= 280
    expect(tableBlock(schemaSql, "mood_events")).toMatch(
      /comment_text\s+TEXT\s+CHECK\s*\(\s*comment_text\s+IS\s+NULL\s+OR\s+length\s*\(\s*comment_text\s*\)\s*<=\s*280\s*\)/i
    );
  });

  it("defaults all four modality flags to true in modality_settings per PRD-003@0.1.3 §5 US-5", () => {
    const block = tableBlock(schemaSql, "modality_settings");
    expect(block).toMatch(/water_on\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+true/i);
    expect(block).toMatch(/sleep_on\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+true/i);
    expect(block).toMatch(/workout_on\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+true/i);
    expect(block).toMatch(/mood_on\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+true/i);
  });
});

function tableBlock(source: string, tableName: string): string {
  const match = new RegExp(
    `CREATE TABLE IF NOT EXISTS ${escapeRegExp(tableName)} \\(\\n([\\s\\S]*?)\\n\\);`,
    "m"
  ).exec(source);
  const body = match?.[1];
  if (!body) {
    throw new Error(`Missing table block for ${tableName}`);
  }
  return body;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
