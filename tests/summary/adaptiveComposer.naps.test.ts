import { describe, it, expect, vi } from "vitest";
import { composeAdaptiveSummary, type AdaptiveComposerDeps } from "../../src/summary/adaptiveComposer.js";
import type { TenantStore, SleepRecordRow } from "../../src/store/types.js";
import type { ModalitySettings, SettingsDb } from "../../src/modality/settings/service.js";
import { renderNapDecomposition } from "../../src/summary/copy.ru.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const START_UTC = "2026-05-25T00:00:00Z";
const END_UTC = "2026-05-25T23:59:59Z";
const KBJU_TEXT = "КБЖУ: 1800 ккал";

function makeNightSleep(overrides: Partial<SleepRecordRow> = {}): SleepRecordRow {
  return {
    record_id: "sn1",
    user_id: USER_ID,
    start_ts_utc: "2026-05-24T23:30:00Z",
    end_ts_utc: "2026-05-25T07:00:00Z",
    duration_min: 450,
    attribution_date_local: "2026-05-25",
    attribution_tz: "Europe/Moscow",
    is_nap: false,
    is_paired_origin: true,
    created_at: "2026-05-25T07:00:00Z",
    ...overrides,
  };
}

function makeNap(overrides: Partial<SleepRecordRow> = {}): SleepRecordRow {
  return {
    record_id: "np1",
    user_id: USER_ID,
    start_ts_utc: "2026-05-25T14:00:00Z",
    end_ts_utc: "2026-05-25T15:30:00Z",
    duration_min: 90,
    attribution_date_local: "2026-05-25",
    attribution_tz: "Europe/Moscow",
    is_nap: true,
    is_paired_origin: false,
    created_at: "2026-05-25T15:30:00Z",
    ...overrides,
  };
}

function makeMockStore(sleepRecords: SleepRecordRow[]): TenantStore {
  return {
    withTransaction: vi.fn().mockResolvedValue(undefined),
    createUser: vi.fn(), getUser: vi.fn(), updateUserOnboardingStatus: vi.fn(),
    deleteUser: vi.fn(), createUserProfile: vi.fn(), getLatestUserProfile: vi.fn(),
    createUserTarget: vi.fn(), upsertSummarySchedule: vi.fn(), listSummarySchedules: vi.fn(),
    upsertOnboardingState: vi.fn(), updateOnboardingStateWithVersion: vi.fn(),
    createTranscript: vi.fn(), createMealDraft: vi.fn(), updateMealDraftWithVersion: vi.fn(),
    createMealDraftItem: vi.fn(), deleteMealDraftItemsByDraftId: vi.fn(),
    createConfirmedMeal: vi.fn(), listConfirmedMeals: vi.fn(), softDeleteConfirmedMealWithVersion: vi.fn(),
    createMealItem: vi.fn(), createSummaryRecord: vi.fn(), createAuditEvent: vi.fn(),
    createMetricEvent: vi.fn(), createCostEvent: vi.fn(), upsertMonthlySpendCounter: vi.fn(),
    getMonthlySpendCounter: vi.fn(), incrementMonthlySpend: vi.fn(),
    upsertFoodLookupCache: vi.fn(), createKbjuAccuracyLabel: vi.fn(),
    getModalitySettings: vi.fn(), setModalitySetting: vi.fn(),
    insertWaterEvent: vi.fn(), insertMoodEvent: vi.fn(), insertSleepRecord: vi.fn(),
    getSleepPairingState: vi.fn(), upsertSleepPairingState: vi.fn(),
    deleteSleepPairingState: vi.fn(), gcExpiredSleepPairingState: vi.fn(),
    insertWorkoutEvent: vi.fn(),
    getWaterEventsInWindow: vi.fn().mockResolvedValue([]),
    getSleepRecordsInWindow: vi.fn().mockResolvedValue(sleepRecords),
    getWorkoutEventsInWindow: vi.fn().mockResolvedValue([]),
    getMoodEventsInWindow: vi.fn().mockResolvedValue([]),
  } as unknown as TenantStore;
}

function makeMockSettingsDb(settings: ModalitySettings): SettingsDb {
  return {
    fetchSettings: vi.fn().mockResolvedValue(settings),
    upsertAndAudit: vi.fn(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("nap-class decomposition", () => {
  // Pure function tests for renderNapDecomposition
  describe("renderNapDecomposition", () => {
    it("only night sleep: renders '1 ночной сон'", () => {
      expect(renderNapDecomposition(1, 0)).toBe("1 ночной сон");
    });

    it("only nap: renders '1 дневной' (singular)", () => {
      expect(renderNapDecomposition(0, 1)).toBe("1 дневной");
    });

    it("2 naps: renders '2 дневных' (plural)", () => {
      expect(renderNapDecomposition(0, 2)).toBe("2 дневных");
    });

    it("mixed: 1 night + 2 naps renders '1 ночной сон, 2 дневных'", () => {
      expect(renderNapDecomposition(1, 2)).toBe("1 ночной сон, 2 дневных");
    });

    it("both zero returns empty string", () => {
      expect(renderNapDecomposition(0, 0)).toBe("");
    });

    it("4 naps: renders '4 дневных' (plural)", () => {
      expect(renderNapDecomposition(0, 4)).toBe("4 дневных");
    });

    it("5 naps: renders '5 дневных' (plural)", () => {
      expect(renderNapDecomposition(0, 5)).toBe("5 дневных");
    });
  });

  // Integration tests: sleep section within composed summary
  describe("sleep section in composed summary", () => {
    it("only night sleep shows duration without nap decomposition", async () => {
      const records = [makeNightSleep()];
      const store = makeMockStore(records);
      const settingsDb = makeMockSettingsDb({ waterOn: false, sleepOn: true, workoutOn: false, moodOn: false });
      const deps: AdaptiveComposerDeps = { store, settingsDb };

      const result = await composeAdaptiveSummary({
        userId: USER_ID, startUtc: START_UTC, endUtc: END_UTC,
        periodType: "daily", timezone: "Europe/Moscow", kbjuSummaryText: KBJU_TEXT,
      }, deps);

      expect(result.text).toContain("Сон:");
      // Night-only: no parenthetical nap decomposition
      expect(result.text).not.toContain("дневн");
    });

    it("only nap shows nap decomposition", async () => {
      const records = [makeNap()];
      const store = makeMockStore(records);
      const settingsDb = makeMockSettingsDb({ waterOn: false, sleepOn: true, workoutOn: false, moodOn: false });
      const deps: AdaptiveComposerDeps = { store, settingsDb };

      const result = await composeAdaptiveSummary({
        userId: USER_ID, startUtc: START_UTC, endUtc: END_UTC,
        periodType: "daily", timezone: "Europe/Moscow", kbjuSummaryText: KBJU_TEXT,
      }, deps);

      expect(result.text).toContain("Сон:");
      expect(result.text).toContain("1 дневной");
    });

    it("mixed night + nap shows both per ADR-017 wording", async () => {
      const records = [makeNightSleep(), makeNap({ record_id: "np2" })];
      const store = makeMockStore(records);
      const settingsDb = makeMockSettingsDb({ waterOn: false, sleepOn: true, workoutOn: false, moodOn: false });
      const deps: AdaptiveComposerDeps = { store, settingsDb };

      const result = await composeAdaptiveSummary({
        userId: USER_ID, startUtc: START_UTC, endUtc: END_UTC,
        periodType: "daily", timezone: "Europe/Moscow", kbjuSummaryText: KBJU_TEXT,
      }, deps);

      expect(result.text).toContain("Сон:");
      expect(result.text).toContain("1 ночной сон, 1 дневной");
    });
  });
});
