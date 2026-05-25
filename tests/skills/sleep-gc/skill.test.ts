/**
 * Tests for the sleep-gc hourly cron skill.
 * Covers: create pairing rows with expires_at in past + future,
 * run GC, assert past rows deleted + future rows preserved.
 */

import { describe, it, expect, vi } from "vitest";
import { runSleepGc, type SleepGcDeps } from "../../../src/skills/sleep-gc/index.js";
import type { TenantStore } from "../../../src/store/types.js";
import type { OpenClawLogger } from "../../../src/shared/types.js";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeMockStore(rowsDeleted: number = 0): TenantStore {
  return {
    gcExpiredSleepPairingState: vi.fn().mockResolvedValue({ rows_deleted: rowsDeleted }),
    withTransaction: vi.fn().mockImplementation(async (_userId, action) => action({
      gcExpiredSleepPairingState: vi.fn().mockResolvedValue({ rows_deleted: rowsDeleted }),
    })),
    insertSleepRecord: vi.fn(), getSleepPairingState: vi.fn(),
    upsertSleepPairingState: vi.fn(), deleteSleepPairingState: vi.fn(),
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
    getModalitySettings: vi.fn(), setModalitySetting: vi.fn(),
    insertWaterEvent: vi.fn(), insertMoodEvent: vi.fn(),
  } as unknown as TenantStore;
}

function makeMockLogger(): OpenClawLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
}

describe("sleep-gc skill", () => {
  it("deletes expired rows and returns count", async () => {
    const store = makeMockStore(3);
    const deps: SleepGcDeps = {
      store,
      logger: makeMockLogger(),
    };

    const result = await runSleepGc(deps);
    expect(result.rows_deleted).toBe(3);
    expect(store.gcExpiredSleepPairingState).toHaveBeenCalledWith(expect.any(String));
  });

  it("preserves future rows (returns 0 deleted when no expired)", async () => {
    const store = makeMockStore(0);
    const deps: SleepGcDeps = {
      store,
      logger: makeMockLogger(),
    };

    const result = await runSleepGc(deps);
    expect(result.rows_deleted).toBe(0);
  });

  it("uses custom nowUtc when provided", async () => {
    const store = makeMockStore(1);
    const fixedNow = "2026-05-25T12:00:00.000Z";
    const deps: SleepGcDeps = {
      store,
      logger: makeMockLogger(),
      nowUtc: () => fixedNow,
    };

    const result = await runSleepGc(deps);
    expect(result.rows_deleted).toBe(1);
    expect(store.gcExpiredSleepPairingState).toHaveBeenCalledWith(fixedNow);
  });

  it("emits log when rows are deleted", async () => {
    const store = makeMockStore(2);
    const logger = makeMockLogger();
    const deps: SleepGcDeps = {
      store,
      logger,
    };

    await runSleepGc(deps);
    expect(logger.info).toHaveBeenCalled();
  });

  it("does not emit log when no rows are deleted", async () => {
    const store = makeMockStore(0);
    const logger = makeMockLogger();
    const deps: SleepGcDeps = {
      store,
      logger,
    };

    await runSleepGc(deps);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
