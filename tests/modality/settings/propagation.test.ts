/**
 * K5 ≤30s propagation test per PRD-003@0.1.3 §6 K5.
 *
 * Scenario: an external writer (not the ModalitySettingsService) writes
 * directly to the underlying "DB".  Then getSettings is called and must
 * reflect the change within ≤30 s without any explicit cache.invalidate().
 *
 * We use vitest fake timers to advance wall-clock time; no real 30-second
 * wall-clock wait is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createModalitySettingsService,
  CACHE_TTL_MS,
  type SettingsDb,
  type ModalitySettings,
} from "../../../src/modality/settings/service.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const ALL_ON: ModalitySettings = {
  waterOn: true,
  sleepOn: true,
  workoutOn: true,
  moodOn: true,
};

/**
 * Creates a mock SettingsDb whose "stored" settings can be mutated externally
 * (simulating a direct DB write from outside the service).
 */
function createExternalWriteableDb() {
  let storedSettings: ModalitySettings | null = null;

  const db: SettingsDb = {
    async fetchSettings(userId: string) {
      void userId;
      return storedSettings;
    },
    async upsertAndAudit(
      userId: string,
      modality: string,
      value: boolean,
      oldValue: boolean,
    ) {
      void userId;
      void oldValue;
      const keyMap: Record<string, keyof ModalitySettings> = {
        water: "waterOn",
        sleep: "sleepOn",
        workout: "workoutOn",
        mood: "moodOn",
      };
      const key = keyMap[modality];
      if (!key) throw new Error(`Unknown modality: ${modality}`);
      const base = storedSettings ?? { ...ALL_ON };
      storedSettings = { ...base, [key]: value };
      return storedSettings;
    },
  };

  return {
    db,
    /** Simulate an external direct DB write (bypassing the service). */
    writeDirectly(settings: ModalitySettings) {
      storedSettings = settings;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("K5 ≤30s propagation (PRD-003@0.1.3 §6 K5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reflects external DB write within 30s without explicit cache invalidation", async () => {
    const { db, writeDirectly } = createExternalWriteableDb();
    const service = createModalitySettingsService(db);

    // Step 1: Initial getSettings — populates cache with all-ON default
    const initial = await service.getSettings(USER_ID);
    expect(initial.waterOn).toBe(true);

    // Step 2: External writer changes water to OFF (directly in "DB")
    writeDirectly({
      waterOn: false,
      sleepOn: true,
      workoutOn: true,
      moodOn: true,
    });

    // Step 3: Immediately after the write, cache is still stale (within TTL)
    const stillCached = await service.getSettings(USER_ID);
    expect(stillCached.waterOn).toBe(true); // stale cache hit

    // Step 4: Advance time past the 30s TTL
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);

    // Step 5: getSettings should now reflect the external write
    const propagated = await service.getSettings(USER_ID);
    expect(propagated.waterOn).toBe(false); // propagated!
  });

  it("propagation happens exactly at TTL boundary (≤30s, not before)", async () => {
    const { db, writeDirectly } = createExternalWriteableDb();
    const service = createModalitySettingsService(db);

    await service.getSettings(USER_ID);

    writeDirectly({
      waterOn: false,
      sleepOn: true,
      workoutOn: true,
      moodOn: true,
    });

    // At 29s — cache should still be valid (stale)
    vi.advanceTimersByTime(29_000);
    const at29s = await service.getSettings(USER_ID);
    expect(at29s.waterOn).toBe(true); // still cached

    // At 31s — cache expired, re-fetch from DB
    vi.advanceTimersByTime(2_000);
    const at31s = await service.getSettings(USER_ID);
    expect(at31s.waterOn).toBe(false); // propagated
  });

  it("setSetting write-through updates cache immediately (no 30s delay)", async () => {
    const { db } = createExternalWriteableDb();
    const service = createModalitySettingsService(db);

    await service.getSettings(USER_ID);

    // setSetting writes through to DB and updates cache immediately
    const afterSet = await service.setSetting(USER_ID, "water", false);

    expect(afterSet.waterOn).toBe(false);

    // Even without advancing time, the next getSettings should show the change
    const immediate = await service.getSettings(USER_ID);
    expect(immediate.waterOn).toBe(false);
  });
});
