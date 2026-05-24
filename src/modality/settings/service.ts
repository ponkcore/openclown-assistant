/**
 * C21 Modality Settings Service — per ARCH-001@0.6.1 §3.21 + PRD-003@0.1.3 §5 US-5.
 *
 * Exposes getSettings / setSetting with an in-process cache (TTL ≤30s per
 * PRD-003@0.1.3 §6 K5).  All SQL is parameterised; all reads/writes are
 * tenant-scoped through the TenantStore RLS mechanism via the
 * TenantScopedRepository methods added in TKT-028 iter2.
 */

import type { TenantStore, ModalitySettingsRow, ModalityToggleName } from "../../store/types.js";

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

/** Maps a ModalityName to the ModalitySettings key. */
const MODALITY_KEYS: Record<ModalityName, keyof ModalitySettings> = {
  water: "waterOn",
  sleep: "sleepOn",
  workout: "workoutOn",
  mood: "moodOn",
};

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
 * Converts a ModalitySettingsRow (snake_case DB columns) to a
 * ModalitySettings (camelCase application type).
 */
function rowToSettings(row: ModalitySettingsRow): ModalitySettings {
  return {
    waterOn: row.water_on,
    sleepOn: row.sleep_on,
    workoutOn: row.workout_on,
    moodOn: row.mood_on,
  };
}

/**
 * Maps ModalityName to the corresponding ModalitySettingsRow boolean key.
 */
const ROW_KEY_MAP: Record<ModalityName, keyof ModalitySettingsRow> = {
  water: "water_on",
  sleep: "sleep_on",
  workout: "workout_on",
  mood: "mood_on",
};

/**
 * Creates a SettingsDb that delegates to TenantStore via the
 * TenantScopedRepository methods added in TKT-028 iter2.
 * All SQL is parameterised; RLS is enforced by the transaction boundary.
 */
export function createTenantStoreSettingsDb(tenantStore: TenantStore): SettingsDb {
  return {
    async fetchSettings(userId: string): Promise<ModalitySettings | null> {
      const row = await tenantStore.getModalitySettings(userId);
      return row ? rowToSettings(row) : null;
    },

    async upsertAndAudit(
      userId: string,
      modality: ModalityName,
      value: boolean,
      oldValue: boolean,
    ): Promise<ModalitySettings> {
      // setModalitySetting writes the upsert + audit row atomically
      // in a single transaction.  It returns { oldValue, newValue }.
      await tenantStore.setModalitySetting(
        userId,
        modality as ModalityToggleName,
        value,
      );

      // Re-read to get the full row after the write
      const row = await tenantStore.getModalitySettings(userId);
      if (!row) {
        // Should never happen after a successful write
        const key = ROW_KEY_MAP[modality];
        const settings: ModalitySettings = { ...ALL_ON, [MODALITY_KEYS[modality]]: value };
        return settings;
      }
      return rowToSettings(row);
    },
  };
}
