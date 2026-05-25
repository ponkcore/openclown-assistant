/**
 * Unit tests for C18 Sleep Logger — all six state-machine paths.
 * Mirrors the mood-logger test pattern with Date-injectable clock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleSleepEvent,
  confirmSanityWarnedSleep,
  correctSanityWarnedSleep,
  extractDurationFromText,
  formatDurationHm,
  computeAttributionDateLocal,
  type SleepEventInput,
  type SleepReply,
  type Clock,
} from "../../../src/modality/sleep/logger.js";
import {
  EVENING_ACK_REPLY,
  EVENING_REPLACE_PAIR_REPLY,
  PAIRED_SUCCESS_REPLY,
  MORNING_NO_PAIR_REPLY,
  SINGLE_EVENT_SUCCESS_REPLY,
  SANITY_FLOOR_WARN,
  SANITY_CEILING_WARN,
} from "../../../src/modality/sleep/copy.ru.js";
import type { TenantStore } from "../../../src/store/types.js";
import type { ModalitySettings } from "../../../src/modality/settings/service.js";
import type { MetricsRegistry } from "../../../src/observability/metricsEndpoint.js";
import type { OpenClawLogger } from "../../../src/shared/types.js";

// ── Test fixtures ──────────────────────────────────────────────────────

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_TZ = "Europe/Moscow";
const REQUEST_ID = "req-test-001";

function makeMockStore(overrides: Partial<TenantStore> = {}): TenantStore {
  return {
    withTransaction: vi.fn().mockImplementation(async (_userId, action) => {
      return action(mockRepo);
    }),
    insertSleepRecord: vi.fn().mockResolvedValue({ record_id: "sr-001" }),
    getSleepPairingState: vi.fn().mockResolvedValue(null),
    upsertSleepPairingState: vi.fn().mockResolvedValue(undefined),
    deleteSleepPairingState: vi.fn().mockResolvedValue(undefined),
    gcExpiredSleepPairingState: vi.fn().mockResolvedValue({ rows_deleted: 0 }),
    // Stub all other required methods
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
    getModalitySettings: vi.fn().mockResolvedValue({ sleepOn: true, waterOn: true, workoutOn: true, moodOn: true }),
    setModalitySetting: vi.fn(),
    insertWaterEvent: vi.fn(),
    insertMoodEvent: vi.fn(),
    ...overrides,
  } as unknown as TenantStore;
}

// Minimal repo mock that the withTransaction stub delegates to
const mockRepo = {
  insertSleepRecord: vi.fn().mockResolvedValue({ record_id: "sr-001" }),
  getSleepPairingState: vi.fn().mockResolvedValue(null),
  upsertSleepPairingState: vi.fn().mockResolvedValue(undefined),
  deleteSleepPairingState: vi.fn().mockResolvedValue(undefined),
  gcExpiredSleepPairingState: vi.fn().mockResolvedValue({ rows_deleted: 0 }),
};

function makeMockMetrics(): MetricsRegistry {
  return {
    inc: vi.fn(),
    observe: vi.fn(),
    set: vi.fn(),
  } as unknown as MetricsRegistry;
}

function makeMockLogger(): OpenClawLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
}

function makeDefaultDeps(store?: Partial<TenantStore>) {
  return {
    store: makeMockStore(store),
    settingsService: {
      getSettings: vi.fn().mockResolvedValue({ sleepOn: true, waterOn: true, workoutOn: true, moodOn: true } as ModalitySettings),
    },
    metrics: makeMockMetrics(),
    logger: makeMockLogger(),
    clock: (() => Date.now()) as Clock,
  };
}

// Telegram timestamp: 2026-05-25 02:00:00 UTC = 1748138400
const EVENING_TS_SEC = 1748138400;
// 7 hours later: 2026-05-25 09:00:00 UTC = 1748163600
const MORNING_TS_SEC = EVENING_TS_SEC + 7 * 3600;

// ── Tests ──────────────────────────────────────────────────────────────

describe("extractDurationFromText", () => {
  it("extracts '7 часов' → 420 min", () => {
    expect(extractDurationFromText("спал 7 часов")).toBe(420);
  });

  it("extracts '7ч' → 420 min", () => {
    expect(extractDurationFromText("спал 7ч")).toBe(420);
  });

  it("extracts 'семь часов' → 420 min", () => {
    expect(extractDurationFromText("спал семь часов")).toBe(420);
  });

  it("extracts 'полчаса' → 30 min", () => {
    expect(extractDurationFromText("полчаса")).toBe(30);
  });

  it("extracts 'пол-часа' → 30 min", () => {
    expect(extractDurationFromText("пол-часа")).toBe(30);
  });

  it("extracts '7.5 ч' → 450 min", () => {
    expect(extractDurationFromText("спал 7.5 ч")).toBe(450);
  });

  it("extracts '7,5 часов' → 450 min", () => {
    expect(extractDurationFromText("спал 7,5 часов")).toBe(450);
  });

  it("extracts '30 минут' → 30 min", () => {
    expect(extractDurationFromText("спал 30 минут")).toBe(30);
  });

  it("extracts 'пять минут' → 5 min", () => {
    expect(extractDurationFromText("пять минут")).toBe(5);
  });

  it("returns null when no pattern matches", () => {
    expect(extractDurationFromText("хорошо выспался")).toBeNull();
  });
});

describe("formatDurationHm", () => {
  it("420 min → 7h 0m", () => {
    expect(formatDurationHm(420)).toEqual({ h: "7", m: "0" });
  });

  it("435 min → 7h 15m", () => {
    expect(formatDurationHm(435)).toEqual({ h: "7", m: "15" });
  });

  it("60 min → 1h 0m", () => {
    expect(formatDurationHm(60)).toEqual({ h: "1", m: "0" });
  });
});

describe("computeAttributionDateLocal", () => {
  it("UTC midnight in Moscow → same date (no DST)", () => {
    expect(computeAttributionDateLocal("2026-05-25T00:00:00Z", "Europe/Moscow")).toBe("2026-05-25");
  });
});

describe("handleSleepEvent", () => {
  // ── Path 1: evening-no-pair ──────────────────────────────────────────
  describe("path 1: evening-no-pair", () => {
    it("creates pairing state and replies with evening ack", async () => {
      const deps = makeDefaultDeps();
      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "evening_leg",
        telegramTimestampSec: EVENING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe(EVENING_ACK_REPLY);
      expect(result.persisted).toBe(false);
      expect(result.sourceLabel).toBe("paired");
      expect(deps.store.upsertSleepPairingState).toHaveBeenCalledWith(
        USER_ID,
        expect.any(String), // legEventTsUtc
        expect.any(String), // expiresAtUtc
      );
    });
  });

  // ── Path 2: evening-replace-pair ─────────────────────────────────────
  describe("path 2: evening-replace-pair", () => {
    it("replaces existing pairing and replies with clarifying message", async () => {
      const deps = makeDefaultDeps({
        getSleepPairingState: vi.fn().mockResolvedValue({
          user_id: USER_ID,
          leg_event_ts_utc: new Date(EVENING_TS_SEC * 1000 - 3600_000).toISOString(),
          expires_at_utc: new Date((EVENING_TS_SEC + 24 * 3600) * 1000).toISOString(),
        }),
      });

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "evening_leg",
        telegramTimestampSec: EVENING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe(EVENING_REPLACE_PAIR_REPLY);
      expect(result.persisted).toBe(false);
      expect(result.sourceLabel).toBe("paired");
    });
  });

  // ── Path 3: morning-with-pair ───────────────────────────────────────
  describe("path 3: morning-with-pair", () => {
    it("computes duration, inserts record, deletes pairing, replies with confirmation", async () => {
      const legEventTsUtc = new Date(EVENING_TS_SEC * 1000).toISOString();
      const deps = makeDefaultDeps({
        getSleepPairingState: vi.fn().mockResolvedValue({
          user_id: USER_ID,
          leg_event_ts_utc: legEventTsUtc,
          expires_at_utc: new Date((EVENING_TS_SEC + 24 * 3600) * 1000).toISOString(),
        }),
      });

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "morning_vstal",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(true);
      expect(result.durationMin).toBe(420);
      expect(result.sourceLabel).toBe("paired");
      expect(result.text).toContain("7 ч");
      expect(deps.store.insertSleepRecord).toHaveBeenCalledWith(
        USER_ID,
        legEventTsUtc,
        expect.any(String),
        420,
        expect.any(String), // attribution_date_local
        USER_TZ,
        false, // is_nap (420 > 240)
        true,  // is_paired_origin
      );
      expect(deps.store.deleteSleepPairingState).toHaveBeenCalledWith(USER_ID);
    });
  });

  // ── Path 4: morning-no-pair ─────────────────────────────────────────
  describe("path 4: morning-no-pair", () => {
    it("replies with clarifying message, no record persisted", async () => {
      const deps = makeDefaultDeps();

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "morning_vstal",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe(MORNING_NO_PAIR_REPLY);
      expect(result.persisted).toBe(false);
      expect(deps.store.insertSleepRecord).not.toHaveBeenCalled();
    });
  });

  // ── Path 5: single-event-morning-duration ───────────────────────────
  describe("path 5: single-event-morning-duration", () => {
    it("extracts duration from text, inserts record, replies with confirmation", async () => {
      const deps = makeDefaultDeps();

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "single_duration",
        rawText: "спал 7 часов",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(true);
      expect(result.durationMin).toBe(420);
      expect(result.sourceLabel).toBe("single");
      expect(result.text).toContain("7 ч");
      expect(deps.store.insertSleepRecord).toHaveBeenCalledWith(
        USER_ID,
        expect.any(String), // startTsUtc
        expect.any(String), // endTsUtc
        420,
        expect.any(String), // attribution_date_local
        USER_TZ,
        false, // is_nap (420 > 240)
        false, // is_paired_origin
      );
    });

    it("classifies ≤240 min as nap", async () => {
      const deps = makeDefaultDeps();

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "single_duration",
        rawText: "спал 3 часа",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(true);
      expect(result.durationMin).toBe(180);
      expect(deps.store.insertSleepRecord).toHaveBeenCalledWith(
        USER_ID,
        expect.any(String),
        expect.any(String),
        180,
        expect.any(String),
        USER_TZ,
        true, // is_nap (180 ≤ 240)
        false,
      );
    });

    it("falls back to LLM extractor when regex fails", async () => {
      const llmExtractor = vi.fn().mockResolvedValue(480);
      const deps = { ...makeDefaultDeps(), llmDurationExtractor: llmExtractor };

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "single_duration",
        rawText: "slept like a baby all night long",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(true);
      expect(result.durationMin).toBe(480);
      expect(llmExtractor).toHaveBeenCalledWith("slept like a baby all night long", USER_ID);
    });

    it("returns no-duration reply when both regex and LLM fail", async () => {
      const deps = { ...makeDefaultDeps(), llmDurationExtractor: vi.fn().mockResolvedValue(null) };

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "single_duration",
        rawText: "zzz",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(false);
      expect(result.text).toBe(MORNING_NO_PAIR_REPLY);
    });
  });

  // ── OFF-state ────────────────────────────────────────────────────────
  describe("OFF-state", () => {
    it("returns OFF reply when sleep_on is false", async () => {
      const deps = makeDefaultDeps();
      deps.settingsService.getSettings = vi.fn().mockResolvedValue({
        sleepOn: false, waterOn: true, workoutOn: true, moodOn: true,
      } as ModalitySettings);

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "evening_leg",
        telegramTimestampSec: EVENING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe("");
      expect(result.persisted).toBe(false);
    });
  });

  // ── Sanity floor/ceiling ─────────────────────────────────────────────
  describe("sanity floor/ceiling", () => {
    it("path 3: paired morning with < 30 min → floor warn", async () => {
      // 10 min sleep
      const legTsUtc = new Date((MORNING_TS_SEC - 10 * 60) * 1000).toISOString();
      const deps = makeDefaultDeps({
        getSleepPairingState: vi.fn().mockResolvedValue({
          user_id: USER_ID,
          leg_event_ts_utc: legTsUtc,
          expires_at_utc: new Date((MORNING_TS_SEC + 24 * 3600) * 1000).toISOString(),
        }),
      });

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "morning_vstal",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe(SANITY_FLOOR_WARN);
      expect(result.persisted).toBe(false);
      expect(result.sanityWarn).toBe("floor");
      expect(result.sanityPending).toBeDefined();
      expect(result.sanityPending?.durationMin).toBe(10);
      expect(deps.store.insertSleepRecord).not.toHaveBeenCalled();
    });

    it("path 5: single duration < 30 min → floor warn", async () => {
      const deps = makeDefaultDeps();

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "single_duration",
        rawText: "спал 10 минут",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe(SANITY_FLOOR_WARN);
      expect(result.persisted).toBe(false);
      expect(result.sanityWarn).toBe("floor");
      expect(result.sanityPending?.durationMin).toBe(10);
    });

    it("path 3: paired morning with > 24h → ceiling warn", async () => {
      // 25h sleep
      const legTsUtc = new Date((MORNING_TS_SEC - 25 * 3600) * 1000).toISOString();
      const deps = makeDefaultDeps({
        getSleepPairingState: vi.fn().mockResolvedValue({
          user_id: USER_ID,
          leg_event_ts_utc: legTsUtc,
          expires_at_utc: new Date((MORNING_TS_SEC + 24 * 3600) * 1000).toISOString(),
        }),
      });

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "morning_vstal",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe(SANITY_CEILING_WARN);
      expect(result.persisted).toBe(false);
      expect(result.sanityWarn).toBe("ceiling");
    });

    it("path 5: single duration > 24h → ceiling warn", async () => {
      const deps = makeDefaultDeps();

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "single_duration",
        rawText: "спал 25 часов",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe(SANITY_CEILING_WARN);
      expect(result.persisted).toBe(false);
      expect(result.sanityWarn).toBe("ceiling");
    });
  });

  // ── confirmSanityWarnedSleep ─────────────────────────────────────────
  describe("confirmSanityWarnedSleep", () => {
    it("persists when user confirms (says 'да')", async () => {
      const deps = makeDefaultDeps();

      const result = await confirmSanityWarnedSleep(USER_ID, USER_TZ, {
        kind: "floor",
        durationMin: 10,
        startTsUtc: "2026-05-25T08:50:00.000Z",
        endTsUtc: "2026-05-25T09:00:00.000Z",
        isPairedOrigin: false,
      }, {
        store: deps.store,
        settingsService: deps.settingsService,
        metrics: deps.metrics,
        logger: deps.logger,
        requestId: REQUEST_ID,
      });

      expect(result.persisted).toBe(true);
      expect(result.durationMin).toBe(10);
      expect(deps.store.insertSleepRecord).toHaveBeenCalled();
    });

    it("deletes pairing state for paired confirmation", async () => {
      const deps = makeDefaultDeps();

      const result = await confirmSanityWarnedSleep(USER_ID, USER_TZ, {
        kind: "floor",
        durationMin: 10,
        startTsUtc: "2026-05-25T08:50:00.000Z",
        endTsUtc: "2026-05-25T09:00:00.000Z",
        isPairedOrigin: true,
      }, {
        store: deps.store,
        settingsService: deps.settingsService,
        metrics: deps.metrics,
        logger: deps.logger,
        requestId: REQUEST_ID,
      });

      expect(result.persisted).toBe(true);
      expect(deps.store.deleteSleepPairingState).toHaveBeenCalledWith(USER_ID);
    });
  });

  // ── correctSanityWarnedSleep ─────────────────────────────────────────
  describe("correctSanityWarnedSleep", () => {
    it("re-parses correction text and persists new duration", async () => {
      const deps = makeDefaultDeps();

      const result = await correctSanityWarnedSleep(
        USER_ID, USER_TZ, "опечатка, 7 часов", MORNING_TS_SEC, false,
        {
          store: deps.store,
          settingsService: deps.settingsService,
          metrics: deps.metrics,
          logger: deps.logger,
          requestId: REQUEST_ID,
        },
      );

      expect(result.persisted).toBe(true);
      expect(result.durationMin).toBe(420);
    });
  });
});

  // ── correctSanityWarnedSleep — paired origin ──────────────────────────
  describe("correctSanityWarnedSleep — paired origin (F-M3)", () => {
    it("preserves is_paired_origin=true and deletes pairing state on correction", async () => {
      const deps = makeDefaultDeps();

      const result = await correctSanityWarnedSleep(
        USER_ID, USER_TZ, "опечатка, 7 часов", MORNING_TS_SEC, true,
        {
          store: deps.store,
          settingsService: deps.settingsService,
          metrics: deps.metrics,
          logger: deps.logger,
          requestId: REQUEST_ID,
        },
      );

      expect(result.persisted).toBe(true);
      expect(result.durationMin).toBe(420);
      expect(result.sourceLabel).toBe("paired");
      expect(deps.store.insertSleepRecord).toHaveBeenCalledWith(
        USER_ID,
        expect.any(String),
        expect.any(String),
        420,
        expect.any(String),
        USER_TZ,
        false, // is_nap (420 > 240)
        true,  // is_paired_origin — preserved from paired sanity-warn
      );
      expect(deps.store.deleteSleepPairingState).toHaveBeenCalledWith(USER_ID);
    });
  });

  // ── OFF-state — paths 3 and 5 (F-L1) ──────────────────────────────────
  describe("OFF-state — all paths silent", () => {
    it("OFF-state on morning_vstal: silent + no record persisted", async () => {
      const deps = makeDefaultDeps();
      deps.settingsService.getSettings = vi.fn().mockResolvedValue({
        sleepOn: false, waterOn: true, workoutOn: true, moodOn: true,
      } as ModalitySettings);

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "morning_vstal",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe("");
      expect(result.persisted).toBe(false);
      expect(deps.store.insertSleepRecord).not.toHaveBeenCalled();
    });

    it("OFF-state on single_duration: silent + no record persisted", async () => {
      const deps = makeDefaultDeps();
      deps.settingsService.getSettings = vi.fn().mockResolvedValue({
        sleepOn: false, waterOn: true, workoutOn: true, moodOn: true,
      } as ModalitySettings);

      const input: SleepEventInput = {
        userId: USER_ID,
        userTz: USER_TZ,
        kind: "single_duration",
        rawText: "спал 7 часов",
        telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID,
        source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe("");
      expect(result.persisted).toBe(false);
      expect(deps.store.insertSleepRecord).not.toHaveBeenCalled();
    });
  });
