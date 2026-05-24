/**
 * C21 Modality Settings Service — per ARCH-001@0.6.1 §3.21 + PRD-003@0.1.3 §5 US-5.
 *
 * Exposes getSettings / setSetting with an in-process cache (TTL ≤30s per
 * PRD-003@0.1.3 §6 K5).  All SQL is parameterised; all reads/writes are
 * tenant-scoped through the TenantStore RLS mechanism.
 */

import type { TenantStore, TenantScopedRepository } from "../../store/types.js";
import type { TenantQueryable } from "../../store/tenantStore.js";
import type { QueryResultRow } from "pg";

// ── Public types ──────────────────────────────────────────────────────────

/** The four toggleable modalities (KBJU is NOT toggleable per PRD-003@0.1.3 §3 NG6). */
export type ModalityName = "water" | "sleep" | "workout" | "mood";

/** Per-user modality on/off flags. */
export interface ModalitySettings {
  waterOn: boolean;
  sleepOn: boolean;
  workoutOn: boolean;
  moodOn: boolean;
}

// ── Internal types ────────────────────────────────────────────────────────

/** Maps a ModalityName to the snake_case DB column suffix. */
const MODALITY_DB_COLUMNS: Record<ModalityName, string> = {
  water: "water_on",
  sleep: "sleep_on",
  workout: "workout_on",
  mood: "mood_on",
};

/** Maps a ModalityName to the ModalitySettings key. */
const MODALITY_KEYS: Record<ModalityName, keyof ModalitySettings> = {
  water: "waterOn",
  sleep: "sleepOn",
  workout: "workoutOn",
  mood: "moodOn",
};

/** DB row shape returned from modality_settings. */
interface ModalitySettingsRow extends QueryResultRow {
  water_on: boolean;
  sleep_on: boolean;
  workout_on: boolean;
  mood_on: boolean;
}

// ── DB abstraction (for testability) ──────────────────────────────────────

/**
 * Minimal DB interface the service depends on.
 * Production impl wraps TenantStore; tests supply a mock.
 */
export interface SettingsDb {
  fetchSettings(userId: string): Promise<ModalitySettings | null>;
  upsertAndAudit(
    userId: string,
    modality: ModalityName,
    value: boolean,
    oldValue: boolean,
  ): Promise<ModalitySettings>;
}

// ── Cache ─────────────────────────────────────────────────────────────────

/** Cache TTL in ms — ≤30 s per PRD-003@0.1.3 §6 K5. */
export const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  settings: ModalitySettings;
  expiresAt: number;
}

const ALL_ON: ModalitySettings = Object.freeze({
  waterOn: true,
  sleepOn: true,
  workoutOn: true,
  moodOn: true,
});

// ── Service factory ───────────────────────────────────────────────────────

/**
 * Creates a ModalitySettingsService backed by the supplied SettingsDb.
 *
 * The cache is a Map<user_id, { settings, expiresAt }>.
 * On getSettings: if not in cache or expired → fetch from DB, store with
 *   expiresAt = Date.now() + CACHE_TTL_MS.
 * On setSetting: write through to DB, then update cache.
 * This ensures external writes propagate within ≤30 s without manual
 * cache invalidation (the propagation test asserts this).
 */
export function createModalitySettingsService(db: SettingsDb) {
  const cache = new Map<string, CacheEntry>();

  async function getSettings(userId: string): Promise<ModalitySettings> {
    const cached = cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.settings;
    }

    const row = await db.fetchSettings(userId);
    const effective: ModalitySettings = row ?? { ...ALL_ON };

    cache.set(userId, {
      settings: effective,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return effective;
  }

  async function setSetting(
    userId: string,
    modality: ModalityName,
    value: boolean,
  ): Promise<ModalitySettings> {
    const current = await getSettings(userId);
    const key = MODALITY_KEYS[modality];
    const oldValue = current[key];

    if (oldValue === value) {
      return current; // no-op, skip DB write
    }

    const newSettings = await db.upsertAndAudit(userId, modality, value, oldValue);

    cache.set(userId, {
      settings: newSettings,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return newSettings;
  }

  return { getSettings, setSetting, cache };
}

export type ModalitySettingsService = ReturnType<typeof createModalitySettingsService>;

// ── Production DB adapter ─────────────────────────────────────────────────

/**
 * Runtime helper: the TenantScopedRepositoryImpl stores its queryable as a
 * private `db` field.  We access it here to execute modality_settings SQL
 * within an already-open RLS-scoped transaction.  This is the only point
 * that reaches into the impl; the service layer itself is clean.
 */
function extractQueryable(repo: unknown): TenantQueryable {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return (repo as unknown as { db: TenantQueryable }).db;
}

/**
 * Creates a SettingsDb that delegates to TenantStore.withTransaction for
 * RLS-scoped, parameterised SQL.  Suitable for production wiring.
 */
export function createTenantStoreSettingsDb(tenantStore: TenantStore): SettingsDb {
  return {
    async fetchSettings(userId: string): Promise<ModalitySettings | null> {
      return tenantStore.withTransaction(userId, async (repo: TenantScopedRepository) => {
        const q = extractQueryable(repo);
        const result = await q.query<ModalitySettingsRow>(
          "SELECT water_on, sleep_on, workout_on, mood_on FROM modality_settings WHERE user_id = $1",
          [userId],
        );
        if (result.rows.length === 0) return null;
        const r = result.rows[0];
        return {
          waterOn: r.water_on,
          sleepOn: r.sleep_on,
          workoutOn: r.workout_on,
          moodOn: r.mood_on,
        };
      });
    },

    async upsertAndAudit(
      userId: string,
      modality: ModalityName,
      value: boolean,
      oldValue: boolean,
    ): Promise<ModalitySettings> {
      const column = MODALITY_DB_COLUMNS[modality];
      return tenantStore.withTransaction(userId, async (repo: TenantScopedRepository) => {
        const q = extractQueryable(repo);

        // Upsert the modality_settings row
        await q.query(
          `INSERT INTO modality_settings (user_id, ${column}, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (user_id) DO UPDATE SET ${column} = $2, updated_at = now()`,
          [userId, value],
        );

        // Audit row per ARCH-001@0.6.1 §3.21 + TKT-021@0.1.0 schema
        await q.query(
          "INSERT INTO modality_settings_audit (user_id, modality, old_value, new_value, ts_utc) VALUES ($1, $2, $3, $4, now())",
          [userId, modality, oldValue, value],
        );

        // Return the full settings row after the write
        const result = await q.query<ModalitySettingsRow>(
          "SELECT water_on, sleep_on, workout_on, mood_on FROM modality_settings WHERE user_id = $1",
          [userId],
        );
        const r = result.rows[0];
        return {
          waterOn: r.water_on,
          sleepOn: r.sleep_on,
          workoutOn: r.workout_on,
          moodOn: r.mood_on,
        };
      });
    },
  };
}
