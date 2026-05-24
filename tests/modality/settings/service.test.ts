import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createModalitySettingsService,
  CACHE_TTL_MS,
  type SettingsDb,
  type ModalityName,
  type ModalitySettings,
} from "../../../src/modality/settings/service.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** All-ON default for a new user. */
const ALL_ON: ModalitySettings = {
  waterOn: true,
  sleepOn: true,
  workoutOn: true,
  moodOn: true,
};

/** Create a mock SettingsDb that tracks calls for audit assertions. */
function createMockDb(initialSettings: ModalitySettings | null = null) {
  let currentSettings: ModalitySettings | null = initialSettings;
  const auditRows: Array<{
    userId: string;
    modality: ModalityName;
    oldValue: boolean;
    newValue: boolean;
  }> = [];

  const db: SettingsDb = {
    async fetchSettings(userId: string) {
      void userId; // used for tracking if needed
      return currentSettings;
    },

    async upsertAndAudit(
      userId: string,
      modality: ModalityName,
      value: boolean,
      oldValue: boolean,
    ) {
      // Simulate the DB upsert: build the new settings object
      const base = currentSettings ?? { ...ALL_ON };
      const keyMap: Record<ModalityName, keyof ModalitySettings> = {
        water: "waterOn",
        sleep: "sleepOn",
        workout: "workoutOn",
        mood: "moodOn",
      };
      const key = keyMap[modality];
      const newSettings: ModalitySettings = { ...base, [key]: value };
      currentSettings = newSettings;

      // Simulate audit row insert
      auditRows.push({ userId, modality, oldValue, newValue: value });

      return newSettings;
    },
  };

  return { db, getAuditRows: () => auditRows, getCurrentSettings: () => currentSettings, setCurrentSettings: (s: ModalitySettings | null) => { currentSettings = s; } };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("ModalitySettingsService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── getSettings ───────────────────────────────────────────────────────

  describe("getSettings", () => {
    it("returns all four ON for a new user (no DB row)", async () => {
      const { db } = createMockDb(null); // null = no row in DB
      const service = createModalitySettingsService(db);

      const settings = await service.getSettings(USER_ID);

      expect(settings).toEqual(ALL_ON);
    });

    it("returns stored settings when DB row exists", async () => {
      const stored: ModalitySettings = {
        waterOn: false,
        sleepOn: true,
        workoutOn: false,
        moodOn: true,
      };
      const { db } = createMockDb(stored);
      const service = createModalitySettingsService(db);

      const settings = await service.getSettings(USER_ID);

      expect(settings).toEqual(stored);
    });

    it("serves from cache on second call within TTL", async () => {
      const { db } = createMockDb(null);
      const fetchSpy = vi.spyOn(db, "fetchSettings");
      const service = createModalitySettingsService(db);

      await service.getSettings(USER_ID);
      await service.getSettings(USER_ID);

      // Only one DB fetch; second hit came from cache
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── setSetting ────────────────────────────────────────────────────────

  describe("setSetting", () => {
    it("toggles water ON → OFF", async () => {
      const { db, getAuditRows } = createMockDb(null);
      const service = createModalitySettingsService(db);

      const result = await service.setSetting(USER_ID, "water", false);

      expect(result.waterOn).toBe(false);
      // Other modalities unchanged
      expect(result.sleepOn).toBe(true);
      expect(result.workoutOn).toBe(true);
      expect(result.moodOn).toBe(true);

      // Audit row written
      const audits = getAuditRows();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toEqual({
        userId: USER_ID,
        modality: "water",
        oldValue: true,
        newValue: false,
      });
    });

    it("toggles sleep OFF → ON", async () => {
      const initial: ModalitySettings = {
        waterOn: true,
        sleepOn: false,
        workoutOn: true,
        moodOn: true,
      };
      const { db, getAuditRows } = createMockDb(initial);
      const service = createModalitySettingsService(db);

      const result = await service.setSetting(USER_ID, "sleep", true);

      expect(result.sleepOn).toBe(true);

      const audits = getAuditRows();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toEqual({
        userId: USER_ID,
        modality: "sleep",
        oldValue: false,
        newValue: true,
      });
    });

    it("is no-op when value matches current", async () => {
      const { db, getAuditRows } = createMockDb(null);
      const service = createModalitySettingsService(db);

      const result = await service.setSetting(USER_ID, "water", true);

      // water is already ON → no DB write, no audit row
      expect(result.waterOn).toBe(true);
      expect(getAuditRows()).toHaveLength(0);
    });

    it("writes audit row for each toggle change", async () => {
      const { db, getAuditRows } = createMockDb(null);
      const service = createModalitySettingsService(db);

      await service.setSetting(USER_ID, "water", false);
      await service.setSetting(USER_ID, "sleep", false);
      await service.setSetting(USER_ID, "workout", false);

      const audits = getAuditRows();
      expect(audits).toHaveLength(3);
      expect(audits.map((a) => a.modality)).toEqual(["water", "sleep", "workout"]);
    });
  });

  // ── Cache TTL ─────────────────────────────────────────────────────────

  describe("cache TTL", () => {
    it("re-fetches from DB after TTL expires", async () => {
      const { db, setCurrentSettings } = createMockDb(null);
      const fetchSpy = vi.spyOn(db, "fetchSettings");
      const service = createModalitySettingsService(db);

      // First call populates cache
      await service.getSettings(USER_ID);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Advance past TTL
      vi.advanceTimersByTime(CACHE_TTL_MS + 1);

      // Simulate an external DB write that changed the settings
      setCurrentSettings({ waterOn: false, sleepOn: true, workoutOn: true, moodOn: true });

      // Next call should re-fetch
      const settings = await service.getSettings(USER_ID);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(settings.waterOn).toBe(false);
    });

    it("serves stale cache within TTL window", async () => {
      const { db, setCurrentSettings } = createMockDb(null);
      const service = createModalitySettingsService(db);

      // First call → all ON
      await service.getSettings(USER_ID);

      // Simulate external DB write
      setCurrentSettings({ waterOn: false, sleepOn: true, workoutOn: true, moodOn: true });

      // Within TTL — cache should NOT reflect external change yet
      vi.advanceTimersByTime(CACHE_TTL_MS - 1000);
      const cached = await service.getSettings(USER_ID);
      expect(cached.waterOn).toBe(true); // still cached (all-ON)
    });
  });
});
