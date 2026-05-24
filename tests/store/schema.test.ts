import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const schemaSql = readFileSync(resolve(process.cwd(), "src/store/schema.sql"), "utf8");

const archTables = [
  "users",
  "user_profiles",
  "user_targets",
  "summary_schedules",
  "onboarding_states",
  "transcripts",
  "meal_drafts",
  "meal_draft_items",
  "confirmed_meals",
  "meal_items",
  "summary_records",
  "audit_events",
  "metric_events",
  "cost_events",
  "monthly_spend_counters",
  "food_lookup_cache",
  "tenant_audit_runs",
  "kbju_accuracy_labels",
  // PRD-003@0.1.3 modality tables (TKT-021)
  "water_events",
  "sleep_records",
  "sleep_pairing_state",
  "workout_events",
  "mood_events",
  "modality_settings",
  "modality_settings_audit",
] as const;

const userOwnedTables = [
  "user_profiles",
  "user_targets",
  "summary_schedules",
  "onboarding_states",
  "transcripts",
  "meal_drafts",
  "meal_draft_items",
  "confirmed_meals",
  "meal_items",
  "summary_records",
  "audit_events",
  "metric_events",
  "cost_events",
  "monthly_spend_counters",
  "food_lookup_cache",
  "kbju_accuracy_labels",
  // PRD-003@0.1.3 modality tables (TKT-021)
  "water_events",
  "sleep_records",
  "sleep_pairing_state",
  "workout_events",
  "mood_events",
  "modality_settings",
  "modality_settings_audit",
] as const;

describe("tenant schema invariants", () => {
  it("declares every ARCH-001@0.2.0 section 5 table", () => {
    for (const table of archTables) {
      expect(schemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(tableBlock(table)).not.toHaveLength(0);
    }
  });

  it("requires user_id and cascading user deletes on every user-owned table except explicit exemptions", () => {
    for (const table of userOwnedTables) {
      const block = tableBlock(table);
      // Most tables: user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
      // PK-as-user_id tables (modality_settings, sleep_pairing_state): user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
      const hasUserFkCascade =
        /\buser_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE\b/i.test(block) ||
        /\buser_id\s+UUID\s+PRIMARY\s+KEY\s+REFERENCES\s+users\(id\)\s+ON\s+DELETE\s+CASCADE\b/i.test(block);
      expect(hasUserFkCascade).toBe(true);
    }

    expect(columnNames("users")).not.toContain("user_id");
    expect(columnNames("tenant_audit_runs")).not.toContain("user_id");
  });

  it("enables RLS and app.user_id policies on user-owned tables", () => {
    for (const table of userOwnedTables) {
      expect(schemaSql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(schemaSql).toMatch(
        new RegExp(
          `CREATE POLICY ${escapeRegExp(table)}_user_id_isolation ON ${escapeRegExp(table)} FOR ALL USING \\(current_setting\\('app\\.user_id'\\)::uuid = user_id\\) WITH CHECK \\(current_setting\\('app\\.user_id'\\)::uuid = user_id\\)`,
          "i"
        )
      );
    }

    expect(schemaSql).toContain("ALTER TABLE users ENABLE ROW LEVEL SECURITY");
    expect(schemaSql).toMatch(
      /CREATE POLICY users_id_isolation ON users FOR ALL USING \(current_setting\('app\.user_id'\)::uuid = id\) WITH CHECK \(current_setting\('app\.user_id'\)::uuid = id\)/i
    );
    expect(schemaSql).toContain("FROM pg_policies");
  });

  it("validates composite ownership for child rows", () => {
    const childConstraints = [
      "FOREIGN KEY (user_id, profile_id) REFERENCES user_profiles(user_id, id)",
      "FOREIGN KEY (user_id, transcript_id) REFERENCES transcripts(user_id, id)",
      "FOREIGN KEY (user_id, draft_id) REFERENCES meal_drafts(user_id, id)",
      "FOREIGN KEY (user_id, meal_id) REFERENCES confirmed_meals(user_id, id)",
    ];

    for (const constraint of childConstraints) {
      expect(schemaSql).toContain(constraint);
    }
  });

  it("does not persist raw voice or photo inputs", () => {
    const forbiddenExactColumns = [
      "raw_audio_deleted_at",
      "raw_photo_deleted_at",
      "voice_file_id",
      "photo_file_id",
      "audio_bytes",
      "photo_bytes",
      "telegram_file_id",
    ];

    // PRD-003@0.1.3 modality tables legitimately store raw text input
    // (raw_text, raw_workout_text, raw_description) per ARCH-001@0.6.1 §5.3.
    // These are normalised text, not raw binary media; redaction is at the
    // C10 emit boundary (TKT-026), not at storage time.
    const modalityTablesWithRawText = new Set([
      "water_events",
      "workout_events",
      "mood_events",
    ]);

    for (const table of archTables) {
      const names = columnNames(table);
      for (const column of forbiddenExactColumns) {
        expect(names).not.toContain(column);
      }
      // Raw binary media columns (audio, photo) are forbidden;
      // raw_text / raw_workout_text / raw_description are allowed for modality tables.
      const rawBinaryColumns = names.filter((name) =>
        /^raw_audio|^raw_photo|_bytes$/.test(name)
      );
      expect(rawBinaryColumns).toEqual([]);
      if (!modalityTablesWithRawText.has(table)) {
        // Pre-PRD-003 tables must not have any raw_ columns
        const rawColumns = names.filter((name) => /^raw_/.test(name));
        expect(rawColumns).toEqual([]);
      }
    }
  });

  it("keeps right-to-delete hard-delete semantics for users", () => {
    const usersColumns = columnNames("users");
    expect(usersColumns).not.toContain("deleted_at");
    expect(onboardingStatusEnum()).not.toContain("deleted");
  });

  it("provisions kbju_audit with BYPASSRLS without granting that path to the app role", () => {
    expect(schemaSql).toContain("CREATE ROLE kbju_audit LOGIN BYPASSRLS");
    expect(schemaSql).toContain("ALTER ROLE kbju_audit BYPASSRLS");
    expect(schemaSql).toContain("ALTER ROLE kbju_app NOBYPASSRLS");
    expect(schemaSql).toContain("REVOKE kbju_audit FROM kbju_app");
    expect(schemaSql).toMatch(/application role \(kbju_app\).*must not have BYPASSRLS/i);
    expect(schemaSql).toMatch(/kbju_audit role is the only BYPASSRLS role.*C11 K4 audit job/i);
  });
});

function tableBlock(tableName: string): string {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${escapeRegExp(tableName)} \\(\\n([\\s\\S]*?)\\n\\);`, "m").exec(
    schemaSql
  );
  const body = match?.[1];
  if (!body) {
    throw new Error(`Missing table block for ${tableName}`);
  }
  return body;
}

function columnNames(tableName: string): string[] {
  return tableBlock(tableName)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z][a-z0-9_]+\s/i.test(line))
    .filter((line) => !line.startsWith("CONSTRAINT"))
    .filter((line) => !line.startsWith("UNIQUE"))
    .map((line) => line.split(/\s+/, 1)[0])
    .filter((columnName): columnName is string => columnName !== undefined);
}

function onboardingStatusEnum(): string[] {
  const match = /CREATE TYPE onboarding_status AS ENUM \(([^)]*)\)/.exec(schemaSql);
  const body = match?.[1];
  if (!body) {
    throw new Error("Missing onboarding_status enum");
  }
  return body.split(",").map((value) => value.trim().replaceAll("'", ""));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
