import { describe, it, expect, vi, beforeEach } from "vitest";
import { composeAdaptiveSummary, type AdaptiveComposerDeps, type AdaptiveComposerInput } from "../../src/summary/adaptiveComposer.js";
import type { TenantStore, WaterEventRow, SleepRecordRow, WorkoutEventRow, MoodEventRow } from "../../src/store/types.js";
import type { ModalitySettings, SettingsDb } from "../../src/modality/settings/service.js";
import type { OpenClawLogger } from "../../src/shared/types.js";

// ── Test fixtures ─────────────────────────────────────────────────────────

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const START_UTC = "2026-05-25T00:00:00Z";
const END_UTC = "2026-05-25T23:59:59Z";
const KBJU_TEXT = "КБЖУ: 1800 ккал, белки 120 г, жиры 60 г, углеводы 180 г";

const waterEvents: WaterEventRow[] = [
  { event_id: "w1", user_id: USER_ID, ts_utc: "2026-05-25T08:00:00Z", volume_ml: 500, source: "keyboard", raw_text: null, created_at: "2026-05-25T08:00:00Z" },
  { event_id: "w2", user_id: USER_ID, ts_utc: "2026-05-25T12:00:00Z", volume_ml: 300, source: "text", raw_text: null, created_at: "2026-05-25T12:00:00Z" },
];

const sleepRecords: SleepRecordRow[] = [
  { record_id: "s1", user_id: USER_ID, start_ts_utc: "2026-05-24T23:30:00Z", end_ts_utc: "2026-05-25T06:45:00Z", duration_min: 435, attribution_date_local: "2026-05-25", attribution_tz: "Europe/Moscow", is_nap: false, is_paired_origin: true, created_at: "2026-05-25T06:45:00Z" },
];

const napRecord: SleepRecordRow[] = [
  { record_id: "sn1", user_id: USER_ID, start_ts_utc: "2026-05-25T14:00:00Z", end_ts_utc: "2026-05-25T15:30:00Z", duration_min: 90, attribution_date_local: "2026-05-25", attribution_tz: "Europe/Moscow", is_nap: true, is_paired_origin: false, created_at: "2026-05-25T15:30:00Z" },
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
    createUser: vi.fn(),
    getUser: vi.fn(),
    updateUserOnboardingStatus: vi.fn(),
    deleteUser: vi.fn(),
    createUserProfile: vi.fn(),
    getLatestUserProfile: vi.fn(),
    createUserTarget: vi.fn(),
    upsertSummarySchedule: vi.fn(),
    listSummarySchedules: vi.fn(),
    upsertOnboardingState: vi.fn(),
    updateOnboardingStateWithVersion: vi.fn(),
    createTranscript: vi.fn(),
    createMealDraft: vi.fn(),
    updateMealDraftWithVersion: vi.fn(),
    createMealDraftItem: vi.fn(),
    deleteMealDraftItemsByDraftId: vi.fn(),
    createConfirmedMeal: vi.fn(),
    listConfirmedMeals: vi.fn(),
    softDeleteConfirmedMealWithVersion: vi.fn(),
    createMealItem: vi.fn(),
    createSummaryRecord: vi.fn(),
    createAuditEvent: vi.fn(),
    createMetricEvent: vi.fn(),
    createCostEvent: vi.fn(),
    upsertMonthlySpendCounter: vi.fn(),
    getMonthlySpendCounter: vi.fn(),
    incrementMonthlySpend: vi.fn(),
    upsertFoodLookupCache: vi.fn(),
    createKbjuAccuracyLabel: vi.fn(),
    getModalitySettings: vi.fn(),
    setModalitySetting: vi.fn(),
    insertWaterEvent: vi.fn(),
    insertMoodEvent: vi.fn(),
    insertSleepRecord: vi.fn(),
    getSleepPairingState: vi.fn(),
    upsertSleepPairingState: vi.fn(),
    deleteSleepPairingState: vi.fn(),
    gcExpiredSleepPairingState: vi.fn(),
    insertWorkoutEvent: vi.fn(),
    getWaterEventsInWindow: vi.fn().mockResolvedValue([]),
    getSleepRecordsInWindow: vi.fn().mockResolvedValue([]),
    getWorkoutEventsInWindow: vi.fn().mockResolvedValue([]),
    getMoodEventsInWindow: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TenantStore;
}

function makeMockSettingsDb(settings: ModalitySettings | null): SettingsDb {
  return {
    fetchSettings: vi.fn().mockResolvedValue(settings),
    upsertAndAudit: vi.fn(),
  };
}

function makeInput(overrides: Partial<AdaptiveComposerInput> = {}): AdaptiveComposerInput {
  return {
    userId: USER_ID,
    startUtc: START_UTC,
    endUtc: END_UTC,
    periodType: "daily",
    timezone: "Europe/Moscow",
    kbjuSummaryText: KBJU_TEXT,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("composeAdaptiveSummary", () => {
  let store: TenantStore;
  let settingsDb: SettingsDb;
  let logger: OpenClawLogger;
  let deps: AdaptiveComposerDeps;

  beforeEach(() => {
    store = makeMockStore();
    settingsDb = makeMockSettingsDb({ waterOn: true, sleepOn: true, workoutOn: true, moodOn: true });
    logger = makeMockLogger();
    deps = { store, settingsDb, logger };
  });

  // 1. KBJU-only (all modalities OFF)
  it("returns KBJU-only when all modalities are OFF", async () => {
    settingsDb = makeMockSettingsDb({ waterOn: false, sleepOn: false, workoutOn: false, moodOn: false });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.text).toBe(KBJU_TEXT);
    expect(result.sections).toEqual([]);
  });

  // 2. KBJU-only (all ON but zero events — zero-event suppression)
  it("returns KBJU-only when all modalities ON but zero events", async () => {
    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.text).toBe(KBJU_TEXT);
    expect(result.sections).toEqual([]);
  });

  // 3. KBJU + water
  it("includes water section when water ON and events exist", async () => {
    store = makeMockStore({ getWaterEventsInWindow: vi.fn().mockResolvedValue(waterEvents) });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.sections).toEqual(["water"]);
    expect(result.text).toContain("Вода:");
    expect(result.text).toContain("800 мл");
    expect(result.text).toContain("2 приёма");
    expect(result.text).toContain(KBJU_TEXT);
  });

  // 4. KBJU + water + sleep
  it("includes water and sleep sections when both ON and have events", async () => {
    store = makeMockStore({
      getWaterEventsInWindow: vi.fn().mockResolvedValue(waterEvents),
      getSleepRecordsInWindow: vi.fn().mockResolvedValue(sleepRecords),
    });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.sections).toEqual(["water", "sleep"]);
    expect(result.text).toContain("Вода:");
    expect(result.text).toContain("Сон:");
  });

  // 5. KBJU + all four modalities
  it("includes all four modality sections when all ON and have events", async () => {
    store = makeMockStore({
      getWaterEventsInWindow: vi.fn().mockResolvedValue(waterEvents),
      getSleepRecordsInWindow: vi.fn().mockResolvedValue(sleepRecords),
      getWorkoutEventsInWindow: vi.fn().mockResolvedValue(workoutEvents),
      getMoodEventsInWindow: vi.fn().mockResolvedValue(moodEvents),
    });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.sections).toEqual(["water", "sleep", "workout", "mood"]);
    expect(result.text).toContain("Вода:");
    expect(result.text).toContain("Сон:");
    expect(result.text).toContain("Тренировка:");
    expect(result.text).toContain("Настроение:");
  });

  // 6. Mixed: water OFF + sleep ON + workout ON (no events) + mood ON
  it("mixed: water OFF, sleep ON with events, workout ON zero events, mood ON with events", async () => {
    settingsDb = makeMockSettingsDb({ waterOn: false, sleepOn: true, workoutOn: true, moodOn: true });
    store = makeMockStore({
      getSleepRecordsInWindow: vi.fn().mockResolvedValue(sleepRecords),
      getWorkoutEventsInWindow: vi.fn().mockResolvedValue([]),
      getMoodEventsInWindow: vi.fn().mockResolvedValue(moodEvents),
    });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.sections).toEqual(["sleep", "mood"]);
    expect(result.text).toContain("Сон:");
    expect(result.text).toContain("Настроение:");
    expect(result.text).not.toContain("Вода:");
    expect(result.text).not.toContain("Тренировка:");
  });

  // 7. Water ON but zero events → suppressed (zero-event suppression)
  it("suppresses water section when ON but zero events", async () => {
    store = makeMockStore({ getWaterEventsInWindow: vi.fn().mockResolvedValue([]) });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.sections).toEqual([]);
    expect(result.text).not.toContain("Вода:");
  });

  // 8. Water OFF but events exist → suppressed (OFF suppression)
  it("suppresses water section when OFF even if events exist", async () => {
    settingsDb = makeMockSettingsDb({ waterOn: false, sleepOn: false, workoutOn: false, moodOn: false });
    store = makeMockStore({ getWaterEventsInWindow: vi.fn().mockResolvedValue(waterEvents) });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.sections).toEqual([]);
    expect(result.text).not.toContain("Вода:");
  });

  // 9. Settings read failure → falls back to all-ON
  it("falls back to all-ON when settings read returns null", async () => {
    settingsDb = makeMockSettingsDb(null);
    store = makeMockStore({
      getWaterEventsInWindow: vi.fn().mockResolvedValue(waterEvents),
    });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.sections).toEqual(["water"]);
    expect(result.text).toContain("Вода:");
  });

  // 10. Mood section with multiple events shows average
  it("mood section shows average when multiple events", async () => {
    const multiMood: MoodEventRow[] = [
      { event_id: "m1", user_id: USER_ID, ts_utc: "2026-05-25T09:00:00Z", score: 7, comment_text: null, source: "keyboard", inferred_from_text: false, raw_text: null, created_at: "2026-05-25T09:00:00Z" },
      { event_id: "m2", user_id: USER_ID, ts_utc: "2026-05-25T18:00:00Z", score: 5, comment_text: null, source: "keyboard", inferred_from_text: false, raw_text: null, created_at: "2026-05-25T18:00:00Z" },
      { event_id: "m3", user_id: USER_ID, ts_utc: "2026-05-25T22:00:00Z", score: 8, comment_text: null, source: "text", inferred_from_text: false, raw_text: null, created_at: "2026-05-25T22:00:00Z" },
    ];
    settingsDb = makeMockSettingsDb({ waterOn: false, sleepOn: false, workoutOn: false, moodOn: true });
    store = makeMockStore({ getMoodEventsInWindow: vi.fn().mockResolvedValue(multiMood) });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.sections).toEqual(["mood"]);
    expect(result.text).toContain("6.7/10");
    expect(result.text).toContain("3 записи");
  });

  // 11. Workout section renders Russian type names
  it("workout section renders Russian type names", async () => {
    const strengthEvent: WorkoutEventRow[] = [
      { event_id: "wk1", user_id: USER_ID, ts_utc: "2026-05-25T07:00:00Z", type: "strength", duration_min: 45, distance_km: null, weight_kg: null, reps: 10, sets: 4, source: "text", raw_workout_text: null, raw_description: null, created_at: "2026-05-25T07:00:00Z" },
    ];
    settingsDb = makeMockSettingsDb({ waterOn: false, sleepOn: false, workoutOn: true, moodOn: false });
    store = makeMockStore({ getWorkoutEventsInWindow: vi.fn().mockResolvedValue(strengthEvent) });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.text).toContain("Силовая");
    expect(result.text).toContain("4×10");
  });

  // 12. Only mood ON, single event
  it("mood section with single event shows simple score", async () => {
    settingsDb = makeMockSettingsDb({ waterOn: false, sleepOn: false, workoutOn: false, moodOn: true });
    store = makeMockStore({ getMoodEventsInWindow: vi.fn().mockResolvedValue(moodEvents) });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);
    expect(result.text).toContain("Настроение: 7/10");
  });

  // 13. F-M1: transient water-table failure does not block KBJU delivery
  //     (ARCH-001@0.6.2 §3.22 failure mode (a))
  it("transient water query failure suppresses water section but delivers KBJU and other sections", async () => {
    const waterError = new Error("water_events table unavailable");
    store = makeMockStore({
      getWaterEventsInWindow: vi.fn().mockRejectedValue(waterError),
      getSleepRecordsInWindow: vi.fn().mockResolvedValue(sleepRecords),
      getWorkoutEventsInWindow: vi.fn().mockResolvedValue(workoutEvents),
      getMoodEventsInWindow: vi.fn().mockResolvedValue(moodEvents),
    });
    deps = { store, settingsDb, logger };

    const result = await composeAdaptiveSummary(makeInput(), deps);

    // KBJU is still present (unconditional)
    expect(result.text).toContain(KBJU_TEXT);
    // Water section is suppressed (query failed → fell back to [] → zero-event suppression)
    expect(result.sections).not.toContain("water");
    expect(result.text).not.toContain("Вода:");
    // Other sections are still present
    expect(result.sections).toEqual(["sleep", "workout", "mood"]);
    expect(result.text).toContain("Сон:");
    expect(result.text).toContain("Тренировка:");
    expect(result.text).toContain("Настроение:");
    // Structured-log observability event emitted
    expect(logger.warn).toHaveBeenCalledWith("c22_modality_query_failed", expect.objectContaining({
      modality: "water",
      error_name: "Error",
      error_message: "water_events table unavailable",
    }));
  });
});
