import { describe, it, expect, vi } from "vitest";
import { composeAdaptiveSummary, type AdaptiveComposerDeps } from "../../src/summary/adaptiveComposer.js";
import type { TenantStore, WaterEventRow, SleepRecordRow, WorkoutEventRow, MoodEventRow } from "../../src/store/types.js";
import type { ModalitySettings, SettingsDb } from "../../src/modality/settings/service.js";
import type { OpenClawLogger } from "../../src/shared/types.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const START_UTC = "2026-05-25T00:00:00Z";
const END_UTC = "2026-05-25T23:59:59Z";
const KBJU_TEXT = "КБЖУ: 1800 ккал";

const waterEvents: WaterEventRow[] = [
  { event_id: "w1", user_id: USER_ID, ts_utc: "2026-05-25T08:00:00Z", volume_ml: 500, source: "keyboard", raw_text: null, created_at: "2026-05-25T08:00:00Z" },
];
const sleepRecords: SleepRecordRow[] = [
  { record_id: "s1", user_id: USER_ID, start_ts_utc: "2026-05-24T23:00:00Z", end_ts_utc: "2026-05-25T07:00:00Z", duration_min: 480, attribution_date_local: "2026-05-25", attribution_tz: "Europe/Moscow", is_nap: false, is_paired_origin: true, created_at: "2026-05-25T07:00:00Z" },
];
const workoutEvents: WorkoutEventRow[] = [
  { event_id: "wk1", user_id: USER_ID, ts_utc: "2026-05-25T07:00:00Z", type: "running", duration_min: 32, distance_km: 5, weight_kg: null, reps: null, sets: null, source: "text", raw_workout_text: null, raw_description: null, created_at: "2026-05-25T07:00:00Z" },
];
const moodEvents: MoodEventRow[] = [
  { event_id: "m1", user_id: USER_ID, ts_utc: "2026-05-25T09:00:00Z", score: 7, comment_text: null, source: "keyboard", inferred_from_text: false, raw_text: null, created_at: "2026-05-25T09:00:00Z" },
];

function makeMockLogger(): OpenClawLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
}

function makeMockStore(overrides: Partial<TenantStore> = {}): TenantStore {
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
    getSleepRecordsInWindow: vi.fn().mockResolvedValue([]),
    getWorkoutEventsInWindow: vi.fn().mockResolvedValue([]),
    getMoodEventsInWindow: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TenantStore;
}

function makeMockSettingsDb(settings: ModalitySettings): SettingsDb {
  return {
    fetchSettings: vi.fn().mockResolvedValue(settings),
    upsertAndAudit: vi.fn(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("adaptiveComposer deterministic section ordering", () => {
  const logger = makeMockLogger();

  it("all four sections appear in KBJU → water → sleep → workout → mood order", async () => {
    const store = makeMockStore({
      getWaterEventsInWindow: vi.fn().mockResolvedValue(waterEvents),
      getSleepRecordsInWindow: vi.fn().mockResolvedValue(sleepRecords),
      getWorkoutEventsInWindow: vi.fn().mockResolvedValue(workoutEvents),
      getMoodEventsInWindow: vi.fn().mockResolvedValue(moodEvents),
    });
    const settingsDb = makeMockSettingsDb({ waterOn: true, sleepOn: true, workoutOn: true, moodOn: true });
    const deps: AdaptiveComposerDeps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary({
      userId: USER_ID, startUtc: START_UTC, endUtc: END_UTC,
      periodType: "daily", timezone: "Europe/Moscow", kbjuSummaryText: KBJU_TEXT,
    }, deps);

    // Sections array must be in exact order
    expect(result.sections).toEqual(["water", "sleep", "workout", "mood"]);

    // Text: KBJU comes first, then water, then sleep, then workout, then mood
    const text = result.text;
    const kbjuIdx = text.indexOf("КБЖУ");
    const waterIdx = text.indexOf("Вода:");
    const sleepIdx = text.indexOf("Сон:");
    const workoutIdx = text.indexOf("Тренировка:");
    const moodIdx = text.indexOf("Настроение:");

    expect(kbjuIdx).toBeLessThan(waterIdx);
    expect(waterIdx).toBeLessThan(sleepIdx);
    expect(sleepIdx).toBeLessThan(workoutIdx);
    expect(workoutIdx).toBeLessThan(moodIdx);
  });

  it("water + mood only still follows KBJU → water → mood order (skipping absent sections)", async () => {
    const store = makeMockStore({
      getWaterEventsInWindow: vi.fn().mockResolvedValue(waterEvents),
      getMoodEventsInWindow: vi.fn().mockResolvedValue(moodEvents),
    });
    const settingsDb = makeMockSettingsDb({ waterOn: true, sleepOn: false, workoutOn: false, moodOn: true });
    const deps: AdaptiveComposerDeps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary({
      userId: USER_ID, startUtc: START_UTC, endUtc: END_UTC,
      periodType: "daily", timezone: "Europe/Moscow", kbjuSummaryText: KBJU_TEXT,
    }, deps);

    expect(result.sections).toEqual(["water", "mood"]);

    const text = result.text;
    const kbjuIdx = text.indexOf("КБЖУ");
    const waterIdx = text.indexOf("Вода:");
    const moodIdx = text.indexOf("Настроение:");

    expect(kbjuIdx).toBeLessThan(waterIdx);
    expect(waterIdx).toBeLessThan(moodIdx);
  });

  it("sleep + workout only follows KBJU → sleep → workout order", async () => {
    const store = makeMockStore({
      getSleepRecordsInWindow: vi.fn().mockResolvedValue(sleepRecords),
      getWorkoutEventsInWindow: vi.fn().mockResolvedValue(workoutEvents),
    });
    const settingsDb = makeMockSettingsDb({ waterOn: false, sleepOn: true, workoutOn: true, moodOn: false });
    const deps: AdaptiveComposerDeps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary({
      userId: USER_ID, startUtc: START_UTC, endUtc: END_UTC,
      periodType: "daily", timezone: "Europe/Moscow", kbjuSummaryText: KBJU_TEXT,
    }, deps);

    expect(result.sections).toEqual(["sleep", "workout"]);

    const text = result.text;
    const kbjuIdx = text.indexOf("КБЖУ");
    const sleepIdx = text.indexOf("Сон:");
    const workoutIdx = text.indexOf("Тренировка:");

    expect(kbjuIdx).toBeLessThan(sleepIdx);
    expect(sleepIdx).toBeLessThan(workoutIdx);
  });
});
