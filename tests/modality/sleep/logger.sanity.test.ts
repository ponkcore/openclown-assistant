/**
 * Sanity-floor / ceiling soft-warn flow tests for C18 Sleep Logger.
 *
 * Per PRD-003@0.1.3 §5 US-2:
 * - duration < 30 min → sanity-floor soft-warn
 * - duration > 24h → sanity-ceiling soft-warn
 * Two confirm-paths each:
 *   - user types "да" → persist
 *   - user types "опечатка, 7 часов" → re-parse and persist new value
 */

import { describe, it, expect, vi } from "vitest";
import {
  handleSleepEvent,
  confirmSanityWarnedSleep,
  correctSanityWarnedSleep,
  type SleepEventInput,
  type Clock,
} from "../../../src/modality/sleep/logger.js";
import {
  SANITY_FLOOR_WARN,
  SANITY_CEILING_WARN,
  SINGLE_EVENT_SUCCESS_REPLY,
  PAIRED_SUCCESS_REPLY,
} from "../../../src/modality/sleep/copy.ru.js";
import type { TenantStore, SleepPairingStateRow } from "../../../src/store/types.js";
import type { ModalitySettings } from "../../../src/modality/settings/service.js";
import type { MetricsRegistry } from "../../../src/observability/metricsEndpoint.js";
import type { OpenClawLogger } from "../../../src/shared/types.js";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_TZ = "Europe/Moscow";
const REQUEST_ID = "req-sanity-001";
const MORNING_TS_SEC = 1748163600; // 2026-05-25 09:00:00 UTC

function makeMockStore(pairingState: SleepPairingStateRow | null = null): TenantStore {
  return {
    withTransaction: vi.fn().mockImplementation(async (_userId, action) => action({
      insertSleepRecord: vi.fn().mockResolvedValue({ record_id: "sr-sanity-001" }),
      getSleepPairingState: vi.fn().mockResolvedValue(pairingState),
      upsertSleepPairingState: vi.fn().mockResolvedValue(undefined),
      deleteSleepPairingState: vi.fn().mockResolvedValue(undefined),
      gcExpiredSleepPairingState: vi.fn().mockResolvedValue({ rows_deleted: 0 }),
    })),
    insertSleepRecord: vi.fn().mockResolvedValue({ record_id: "sr-sanity-001" }),
    getSleepPairingState: vi.fn().mockResolvedValue(pairingState),
    upsertSleepPairingState: vi.fn().mockResolvedValue(undefined),
    deleteSleepPairingState: vi.fn().mockResolvedValue(undefined),
    gcExpiredSleepPairingState: vi.fn().mockResolvedValue({ rows_deleted: 0 }),
    createUser: vi.fn(), getUser: vi.fn(), updateUserOnboardingStatus: vi.fn(),
    deleteUser: vi.fn(), createUserProfile: vi.fn(), getLatestUserProfile: vi.fn(),
    createUserTarget: vi.fn(), upsertSummarySchedule: vi.fn(), listSummarySchedules: vi.fn(),
    upsertOnboardingState: vi.fn(), updateOnboardingStateWithVersion: vi.fn(),
    createTranscript: vi.fn(), createMealDraft: vi.fn(), updateMealDraftWithVersion: vi.fn(),
    createMealDraftItem: vi.fn(), deleteMealDraftItemsByDraftId: vi.fn(),
    createConfirmedMeal: vi.fn(), listConfirmedMeals: vi.fn(),
    softDeleteConfirmedMealWithVersion: vi.fn(), createMealItem: vi.fn(),
    createSummaryRecord: vi.fn(), createAuditEvent: vi.fn(), createMetricEvent: vi.fn(),
    createCostEvent: vi.fn(), upsertMonthlySpendCounter: vi.fn(),
    getMonthlySpendCounter: vi.fn(), incrementMonthlySpend: vi.fn(),
    upsertFoodLookupCache: vi.fn(), createKbjuAccuracyLabel: vi.fn(),
    getModalitySettings: vi.fn().mockResolvedValue({ sleepOn: true, waterOn: true, workoutOn: true, moodOn: true }),
    setModalitySetting: vi.fn(), insertWaterEvent: vi.fn(), insertMoodEvent: vi.fn(),
  } as unknown as TenantStore;
}

function makeDefaultDeps(pairingState?: SleepPairingStateRow | null) {
  return {
    store: makeMockStore(pairingState ?? null),
    settingsService: {
      getSettings: vi.fn().mockResolvedValue({ sleepOn: true } as ModalitySettings),
    },
    metrics: { inc: vi.fn(), observe: vi.fn(), set: vi.fn() } as unknown as MetricsRegistry,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), critical: vi.fn() } as unknown as OpenClawLogger,
    clock: (() => Date.now()) as Clock,
  };
}

describe("C18 Sleep Logger — sanity-floor / ceiling soft-warn", () => {
  // ── Sanity floor (< 30 min) ──────────────────────────────────────────
  describe("sanity-floor (< 30 min)", () => {
    it("single-event: 10 min duration → floor warn, no persist", async () => {
      const deps = makeDefaultDeps();
      const input: SleepEventInput = {
        userId: USER_ID, userTz: USER_TZ, kind: "single_duration",
        rawText: "спал 10 минут", telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe(SANITY_FLOOR_WARN);
      expect(result.persisted).toBe(false);
      expect(result.sanityWarn).toBe("floor");
      expect(result.sanityPending).toBeDefined();
      expect(result.sanityPending!.durationMin).toBe(10);
    });

    it("paired: 10 min duration → floor warn, no persist", async () => {
      const legTsUtc = new Date((MORNING_TS_SEC - 10 * 60) * 1000).toISOString();
      const pairingRow: SleepPairingStateRow = {
        user_id: USER_ID,
        leg_event_ts_utc: legTsUtc,
        expires_at_utc: new Date((MORNING_TS_SEC - 10 * 60 + 24 * 3600) * 1000).toISOString(),
      };

      const deps = makeDefaultDeps(pairingRow);
      const input: SleepEventInput = {
        userId: USER_ID, userTz: USER_TZ, kind: "morning_vstal",
        telegramTimestampSec: MORNING_TS_SEC, requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe(SANITY_FLOOR_WARN);
      expect(result.persisted).toBe(false);
      expect(result.sanityWarn).toBe("floor");
    });

    it("confirm path: user says 'да' → record persists", async () => {
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
      expect(deps.store.insertSleepRecord).toHaveBeenCalledWith(
        USER_ID,
        "2026-05-25T08:50:00.000Z",
        "2026-05-25T09:00:00.000Z",
        10,
        expect.any(String),
        USER_TZ,
        true,  // is_nap (10 ≤ 240)
        false, // isPairedOrigin
      );
    });

    it("correct path: user types 'опечатка, 7 часов' → re-parse + persist 420 min", async () => {
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

  // ── Sanity ceiling (> 24h) ───────────────────────────────────────────
  describe("sanity-ceiling (> 24h)", () => {
    it("single-event: 25h duration → ceiling warn, no persist", async () => {
      const deps = makeDefaultDeps();
      const input: SleepEventInput = {
        userId: USER_ID, userTz: USER_TZ, kind: "single_duration",
        rawText: "спал 25 часов", telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe(SANITY_CEILING_WARN);
      expect(result.persisted).toBe(false);
      expect(result.sanityWarn).toBe("ceiling");
      expect(result.sanityPending).toBeDefined();
      expect(result.sanityPending!.durationMin).toBe(1500);
    });

    it("paired: 25h duration → ceiling warn, no persist", async () => {
      const legTsUtc = new Date((MORNING_TS_SEC - 25 * 3600) * 1000).toISOString();
      const pairingRow: SleepPairingStateRow = {
        user_id: USER_ID,
        leg_event_ts_utc: legTsUtc,
        expires_at_utc: new Date((MORNING_TS_SEC - 25 * 3600 + 24 * 3600) * 1000).toISOString(),
      };

      const deps = makeDefaultDeps(pairingRow);
      const input: SleepEventInput = {
        userId: USER_ID, userTz: USER_TZ, kind: "morning_vstal",
        telegramTimestampSec: MORNING_TS_SEC, requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.text).toBe(SANITY_CEILING_WARN);
      expect(result.persisted).toBe(false);
      expect(result.sanityWarn).toBe("ceiling");
    });

    it("confirm path: user says 'да' → record persists with 1500 min", async () => {
      const deps = makeDefaultDeps();

      const result = await confirmSanityWarnedSleep(USER_ID, USER_TZ, {
        kind: "ceiling",
        durationMin: 1500,
        startTsUtc: "2026-05-24T08:00:00.000Z",
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
      expect(result.durationMin).toBe(1500);
      expect(deps.store.deleteSleepPairingState).toHaveBeenCalledWith(USER_ID);
    });

    it("correct path: user types 'опечатка, 7 часов' → re-parse + persist 420 min", async () => {
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
      expect(deps.store.insertSleepRecord).toHaveBeenCalledWith(
        USER_ID,
        expect.any(String),
        expect.any(String),
        420,
        expect.any(String),
        USER_TZ,
        false, // is_nap (420 > 240)
        true,  // is_paired_origin — inherited from paired sanity-warn
      );
      expect(deps.store.deleteSleepPairingState).toHaveBeenCalledWith(USER_ID);
    });
  });

  // ── Boundary values ──────────────────────────────────────────────────
  describe("boundary values", () => {
    it("exactly 30 min → no sanity warn, persists directly", async () => {
      const deps = makeDefaultDeps();
      const input: SleepEventInput = {
        userId: USER_ID, userTz: USER_TZ, kind: "single_duration",
        rawText: "спал 30 минут", telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(true);
      expect(result.durationMin).toBe(30);
      expect(result.sanityWarn).toBeUndefined();
    });

    it("exactly 1440 min (24h) → no sanity warn, persists directly", async () => {
      const deps = makeDefaultDeps();
      const input: SleepEventInput = {
        userId: USER_ID, userTz: USER_TZ, kind: "single_duration",
        rawText: "спал 24 часа", telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(true);
      expect(result.durationMin).toBe(1440);
      expect(result.sanityWarn).toBeUndefined();
    });

    it("29 min → floor warn", async () => {
      const deps = makeDefaultDeps();
      const input: SleepEventInput = {
        userId: USER_ID, userTz: USER_TZ, kind: "single_duration",
        rawText: "спал 29 минут", telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.sanityWarn).toBe("floor");
      expect(result.persisted).toBe(false);
    });

    it("1441 min → ceiling warn", async () => {
      const deps = makeDefaultDeps();
      // 1441 min = 24h 1min — use LLM mock to return this
      const depsWithLlm = { ...deps, llmDurationExtractor: vi.fn().mockResolvedValue(1441) };
      const input: SleepEventInput = {
        userId: USER_ID, userTz: USER_TZ, kind: "single_duration",
        rawText: "очень долго спал", telegramTimestampSec: MORNING_TS_SEC,
        requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, depsWithLlm);
      expect(result.sanityWarn).toBe("ceiling");
      expect(result.persisted).toBe(false);
    });
  });
});
