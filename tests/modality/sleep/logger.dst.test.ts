/**
 * DST transition tests for C18 Sleep Logger.
 *
 * Covers three diverse zones per ADR-017@0.1.0 §Decision:
 * - Europe/Moscow (no DST since 2014)
 * - Europe/Belgrade (EU DST 2026-03-29 spring-forward)
 * - America/Los_Angeles (US DST 2026-03-08 spring-forward + 2026-11-01 fall-back)
 *
 * For each: at least one sleep crossing the DST boundary;
 * assert duration_min is computed UTC-anchored (so DST does NOT affect duration),
 * AND attribution_date_local is the user-tz calendar day of end_ts_utc
 * (so it CAN look weird around DST but is deterministic).
 */

import { describe, it, expect, vi } from "vitest";
import {
  handleSleepEvent,
  computeAttributionDateLocal,
  type SleepEventInput,
  type Clock,
} from "../../../src/modality/sleep/logger.js";
import type { TenantStore, SleepPairingStateRow } from "../../../src/store/types.js";
import type { ModalitySettings } from "../../../src/modality/settings/service.js";
import type { MetricsRegistry } from "../../../src/observability/metricsEndpoint.js";
import type { OpenClawLogger } from "../../../src/shared/types.js";
import { DateTime } from "luxon";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST_ID = "req-dst-001";

function makeMockStore(pairingState: SleepPairingStateRow | null = null): TenantStore {
  return {
    withTransaction: vi.fn().mockImplementation(async (_userId, action) => action({
      insertSleepRecord: vi.fn().mockResolvedValue({ record_id: "sr-dst-001" }),
      getSleepPairingState: vi.fn().mockResolvedValue(pairingState),
      upsertSleepPairingState: vi.fn().mockResolvedValue(undefined),
      deleteSleepPairingState: vi.fn().mockResolvedValue(undefined),
      gcExpiredSleepPairingState: vi.fn().mockResolvedValue({ rows_deleted: 0 }),
    })),
    insertSleepRecord: vi.fn().mockResolvedValue({ record_id: "sr-dst-001" }),
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

/**
 * Helper: given a local time string and timezone, compute the UTC Unix seconds.
 */
function localToUnixSec(localStr: string, tz: string): number {
  const dt = DateTime.fromISO(localStr, { zone: tz });
  return Math.floor(dt.toUTC().toSeconds());
}

describe("C18 Sleep Logger — DST transitions", () => {
  // ── Europe/Moscow — no DST since 2014 ─────────────────────────────────
  describe("Europe/Moscow (no DST)", () => {
    const TZ = "Europe/Moscow";

    it("duration is correct for sleep crossing midnight (no DST effect)", async () => {
      // Sleep: 2026-05-24 23:30 MSK → 2026-05-25 06:30 MSK (7h)
      const legUnix = localToUnixSec("2026-05-24T23:30:00", TZ);
      const vstalUnix = localToUnixSec("2026-05-25T06:30:00", TZ);

      const legTsUtc = new Date(legUnix * 1000).toISOString();
      const pairingRow: SleepPairingStateRow = {
        user_id: USER_ID,
        leg_event_ts_utc: legTsUtc,
        expires_at_utc: new Date((legUnix + 24 * 3600) * 1000).toISOString(),
      };

      const deps = makeDefaultDeps(pairingRow);
      const input: SleepEventInput = {
        userId: USER_ID, userTz: TZ, kind: "morning_vstal",
        telegramTimestampSec: vstalUnix, requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(true);
      expect(result.durationMin).toBe(420);
      expect(result.sourceLabel).toBe("paired");
    });

    it("attribution_date_local is the calendar day of end timestamp", async () => {
      const endTsUtc = "2026-05-25T06:30:00Z"; // 09:30 MSK
      const attributionDate = computeAttributionDateLocal(endTsUtc, TZ);
      // 06:30 UTC = 09:30 MSK → 2026-05-25
      expect(attributionDate).toBe("2026-05-25");
    });
  });

  // ── Europe/Belgrade — EU DST spring-forward 2026-03-29 ────────────────
  describe("Europe/Belgrade (EU DST)", () => {
    const TZ = "Europe/Belgrade";

    it("duration is UTC-anchored — unaffected by spring-forward", async () => {
      // EU DST: 2026-03-29 02:00 CET → 03:00 CEST (clocks spring forward 1h)
      // Sleep: 2026-03-28 23:00 CET → 2026-03-29 07:00 CEST
      // Wall-clock: 23:00 → 07:00 = appears 8h but real duration = 7h
      // Because at 02:00 CET the clock jumps to 03:00 CEST
      const legUnix = localToUnixSec("2026-03-28T23:00:00", TZ);
      const vstalUnix = localToUnixSec("2026-03-29T07:00:00", TZ);

      const legTsUtc = new Date(legUnix * 1000).toISOString();
      const pairingRow: SleepPairingStateRow = {
        user_id: USER_ID,
        leg_event_ts_utc: legTsUtc,
        expires_at_utc: new Date((legUnix + 24 * 3600) * 1000).toISOString(),
      };

      const deps = makeDefaultDeps(pairingRow);
      const input: SleepEventInput = {
        userId: USER_ID, userTz: TZ, kind: "morning_vstal",
        telegramTimestampSec: vstalUnix, requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(true);
      // Duration computed from UTC timestamps: 7h wall-clock minus 1h DST = 7h UTC difference
      // Actually: 23:00 CET = 22:00 UTC, 07:00 CEST = 05:00 UTC → diff = 7h = 420 min
      expect(result.durationMin).toBe(420);
    });

    it("attribution_date_local is calendar day of end_ts in user tz", async () => {
      // 05:00 UTC on 2026-03-29 = 07:00 CEST on 2026-03-29 → attribution = 2026-03-29
      const endTsUtc = "2026-03-29T05:00:00Z";
      const attributionDate = computeAttributionDateLocal(endTsUtc, TZ);
      expect(attributionDate).toBe("2026-03-29");
    });
  });

  // ── America/Los_Angeles — US DST ─────────────────────────────────────
  describe("America/Los_Angeles (US DST)", () => {
    const TZ = "America/Los_Angeles";

    it("duration is UTC-anchored — unaffected by spring-forward 2026-03-08", async () => {
      // US DST: 2026-03-08 02:00 PST → 03:00 PDT (clocks spring forward 1h)
      // Sleep: 2026-03-07 23:00 PST → 2026-03-08 07:00 PDT
      // Wall-clock: 23:00 → 07:00 = appears 8h but real duration = 7h
      const legUnix = localToUnixSec("2026-03-07T23:00:00", TZ);
      const vstalUnix = localToUnixSec("2026-03-08T07:00:00", TZ);

      const legTsUtc = new Date(legUnix * 1000).toISOString();
      const pairingRow: SleepPairingStateRow = {
        user_id: USER_ID,
        leg_event_ts_utc: legTsUtc,
        expires_at_utc: new Date((legUnix + 24 * 3600) * 1000).toISOString(),
      };

      const deps = makeDefaultDeps(pairingRow);
      const input: SleepEventInput = {
        userId: USER_ID, userTz: TZ, kind: "morning_vstal",
        telegramTimestampSec: vstalUnix, requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(true);
      // 23:00 PST = 07:00 UTC, 07:00 PDT = 14:00 UTC → diff = 7h = 420 min
      expect(result.durationMin).toBe(420);
    });

    it("attribution_date_local correct at spring-forward boundary", async () => {
      // 14:00 UTC on 2026-03-08 = 07:00 PDT on 2026-03-08 → attribution = 2026-03-08
      const endTsUtc = "2026-03-08T14:00:00Z";
      const attributionDate = computeAttributionDateLocal(endTsUtc, TZ);
      expect(attributionDate).toBe("2026-03-08");
    });

    it("duration is UTC-anchored — unaffected by fall-back 2026-11-01", async () => {
      // US fall-back: 2026-11-01 02:00 PDT → 01:00 PST (clocks fall back 1h)
      // Sleep: 2026-10-31 23:00 PDT → 2026-11-01 07:00 PST
      // Wall-clock: 23:00 → 07:00 = appears 8h but real duration = 9h
      const legUnix = localToUnixSec("2026-10-31T23:00:00", TZ);
      const vstalUnix = localToUnixSec("2026-11-01T07:00:00", TZ);

      const legTsUtc = new Date(legUnix * 1000).toISOString();
      const pairingRow: SleepPairingStateRow = {
        user_id: USER_ID,
        leg_event_ts_utc: legTsUtc,
        expires_at_utc: new Date((legUnix + 24 * 3600) * 1000).toISOString(),
      };

      const deps = makeDefaultDeps(pairingRow);
      const input: SleepEventInput = {
        userId: USER_ID, userTz: TZ, kind: "morning_vstal",
        telegramTimestampSec: vstalUnix, requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(true);
      // 23:00 PDT = 06:00 UTC, 07:00 PST = 15:00 UTC → diff = 9h = 540 min
      expect(result.durationMin).toBe(540);
    });

    it("attribution_date_local correct at fall-back boundary", async () => {
      // 15:00 UTC on 2026-11-01 = 07:00 PST on 2026-11-01 → attribution = 2026-11-01
      const endTsUtc = "2026-11-01T15:00:00Z";
      const attributionDate = computeAttributionDateLocal(endTsUtc, TZ);
      expect(attributionDate).toBe("2026-11-01");
    });

    it("DST smoke: sleep starting 2026-03-08 02:30 PST (DST spring-forward) ending 09:30 PDT", async () => {
      // This is the exact AC smoke test from TKT-023 §6
      // 2026-03-08 02:30 PST doesn't exist on the wall (clocks jump from 02:00 to 03:00)
      // But as a UTC timestamp it's valid. Let's use 02:30 UTC-8 (PST) = 10:30 UTC
      // Actually: per the AC, start = 02:30 America/Los_Angeles on DST day
      // This local time doesn't exist (skipped), but we can construct it as a UTC time
      // Use the UTC equivalent: 2026-03-08T02:30:00-08:00 = 2026-03-08T10:30:00Z
      const startDt = DateTime.fromISO("2026-03-08T02:30:00", { zone: TZ });
      // 09:30 PDT on the same day = 2026-03-08T09:30:00-07:00 = 2026-03-08T16:30:00Z
      const endDt = DateTime.fromISO("2026-03-08T09:30:00", { zone: TZ });

      const legUnix = Math.floor(startDt.toUTC().toSeconds());
      const vstalUnix = Math.floor(endDt.toUTC().toSeconds());

      const legTsUtc = new Date(legUnix * 1000).toISOString();
      const pairingRow: SleepPairingStateRow = {
        user_id: USER_ID,
        leg_event_ts_utc: legTsUtc,
        expires_at_utc: new Date((legUnix + 24 * 3600) * 1000).toISOString(),
      };

      const deps = makeDefaultDeps(pairingRow);
      const input: SleepEventInput = {
        userId: USER_ID, userTz: TZ, kind: "morning_vstal",
        telegramTimestampSec: vstalUnix, requestId: REQUEST_ID, source: "text",
      };

      const result = await handleSleepEvent(input, deps);
      expect(result.persisted).toBe(true);
      // Duration = UTC-anchored: 16:30 UTC - 10:30 UTC = 6h = 360 min
      expect(result.durationMin).toBe(360);
      // attribution_date_local = calendar day of end_ts in LA tz = 2026-03-08
      const endTsUtc = new Date(vstalUnix * 1000).toISOString();
      expect(computeAttributionDateLocal(endTsUtc, TZ)).toBe("2026-03-08");
    });
  });
});
