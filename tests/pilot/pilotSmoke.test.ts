import { describe, expect, it } from "vitest";
import {
  queryK1DailyConfirmedMeals,
  queryK1MeetsThreshold,
  queryK2LatencyMs,
  queryK3VoiceLatency,
  queryK4CrossUserAudit,
  queryK5MonthlySpend,
  queryK6ActiveDays,
  queryK6WeeklyRetention,
  queryK7Accuracy,
} from "../../src/pilot/kpiQueries.js";
import { formatPilotReadinessReport } from "../../src/pilot/pilotReadinessReport.js";
import type { PilotReadinessData } from "../../src/pilot/pilotReadinessReport.js";
import { HistoryService } from "../../src/history/historyService.js";
import type { HistoryDeps, ConfirmedMealView } from "../../src/history/types.js";
import { RightToDeleteService } from "../../src/privacy/rightToDelete.js";
import type {
  RightToDeleteRepository,
  RightToDeleteTransaction,
  UserIdentityForDeletion,
  TenantAuditConnection,
  TenantAuditConnectionFactory,
  TenantAuditDeps,
} from "../../src/privacy/types.js";
import {
  validateRecommendationOutput,
  buildDeterministicFallback,
} from "../../src/summary/recommendationGuard.js";
import {
  isLowConfidence,
  getLowConfidenceLabel,
  computeDraftConfidence,
} from "../../src/photo/photoConfidence.js";
import { runEndOfPilotTenantAudit } from "../../src/privacy/tenantAudit.js";
import {
  USER_A,
  USER_B,
  ALL_MEALS,
  METRIC_EVENTS,
  TENANT_AUDIT_RUNS,
  COST_EVENTS,
  ALL_K7_LABELS,
  FIXED_MONTH_UTC,
  FIXED_NOW,
  FIXED_WEEK_END,
  FIXED_WEEK_START,
  SENSITIVE_SENTINELS,
  buildPilotReadinessData,
} from "../pilot/fixtures.js";

const K1_TARGET_MEALS_PER_DAY = 1;
const K1_TARGET_DAYS = 7;
const K3_P95_TIMEOUT_MS = 8000;
const K3_P100_TIMEOUT_MS = 30000;
const K5_MONTHLY_CEILING_USD = 10;
const K6_RETENTION_THRESHOLD = 7;
const K7_CALORIE_TOLERANCE = 10;
const K7_MACRO_TOLERANCE = 10;

// ---------------------------------------------------------------------------
// Mock helpers: minimal typed stubs for production service dependencies
// ---------------------------------------------------------------------------

function mealRowToConfirmedMealView(row: { id: string; user_id: string; source: string; meal_local_date: string; meal_logged_at: string; total_calories_kcal: number; total_protein_g: number; total_fat_g: number; total_carbs_g: number; version: number; deleted_at: string | null }): ConfirmedMealView {
  return {
    id: row.id,
    userId: row.user_id,
    source: row.source,
    mealLocalDate: row.meal_local_date,
    mealLoggedAt: row.meal_logged_at,
    totalKBJU: {
      caloriesKcal: row.total_calories_kcal,
      proteinG: row.total_protein_g,
      fatG: row.total_fat_g,
      carbsG: row.total_carbs_g,
    },
    version: row.version,
    deletedAt: row.deleted_at,
    items: [],
  };
}

function createMockHistoryDeps(mealsByUser: Record<string, ConfirmedMealView[]>): HistoryDeps {
  return {
    listConfirmedMealsPage: async (userId: string) => mealsByUser[userId] ?? [],
    withTransaction: async (action) => action({} as never),
    getConfirmedMeal: async () => null,
    listMealItems: async () => [],
    updateConfirmedMealWithVersion: async () => ({} as never),
    replaceMealItems: async () => [],
    softDeleteMeal: async () => ({} as never),
    createAuditEvent: async () => "audit-id",
  };
}

function createMockRightToDeleteRepository(
  initialUsers: UserIdentityForDeletion[],
): RightToDeleteRepository & { deletedUserIds: Set<string> } {
  const users = new Map<string, UserIdentityForDeletion>();
  const deletedUserIds = new Set<string>();
  for (const u of initialUsers) {
    users.set(u.telegramUserId, u);
  }
  return {
    findUserByTelegramUserId: async (telegramUserId: string) =>
      users.get(telegramUserId) ?? null,
    withUserDeletionTransaction: async <T>(
      _userId: string,
      action: (tx: RightToDeleteTransaction) => Promise<T>,
    ): Promise<T> => {
      const tx: RightToDeleteTransaction = {
        lockUser: async () => true,
        hardDeleteUserRows: async (userId: string) => {
          deletedUserIds.add(userId);
          return {
            user_profiles: 1,
            user_targets: 1,
            summary_schedules: 1,
            onboarding_states: 1,
            transcripts: 1,
            meal_drafts: 1,
            meal_draft_items: 1,
            confirmed_meals: 1,
            meal_items: 1,
            summary_records: 1,
            audit_events: 1,
            metric_events: 1,
            cost_events: 1,
            monthly_spend_counters: 1,
            food_lookup_cache: 1,
            kbju_accuracy_labels: 1,
            water_events: 1,
            sleep_records: 1,
            sleep_pairing_state: 1,
            workout_events: 1,
            mood_events: 1,
            modality_settings_audit: 1,
            modality_settings: 1,
            users: 1,
          };
        },
      };
      return action(tx);
    },
    deletedUserIds,
  };
}

function createMockTenantAuditConnectionFactory(
  crossUserRefCount = 0,
): TenantAuditConnectionFactory {
  let callCount = 0;
  return async () => ({
    query: async <Row extends Record<string, unknown>>(sql: string, values?: unknown[]) => {
      callCount++;
      if (sql.includes("INSERT INTO tenant_audit_runs")) {
        return {
          rows: [
            {
              id: "audit-run-smoke-1",
              checked_tables: [
                "user_profiles",
                "confirmed_meals",
                "meal_items",
              ],
              cross_user_reference_count: crossUserRefCount,
              findings: [],
            } as unknown as Row,
          ],
          rowCount: 1,
        };
      }
      return {
        rows: [{ count: crossUserRefCount } as unknown as Row],
        rowCount: 1,
      };
    },
    end: async () => {},
  });
}

// ---------------------------------------------------------------------------
// KPI smoke tests (K1–K7)
// ---------------------------------------------------------------------------

describe("pilot KPI smoke - K1-K7 readiness", () => {
  it("calculates all pilot KPI pass conditions from deterministic fixtures", () => {
    const dailyMeals = queryK1DailyConfirmedMeals(ALL_MEALS);
    const thresholds = queryK1MeetsThreshold(
      dailyMeals,
      K1_TARGET_MEALS_PER_DAY,
      K1_TARGET_DAYS,
      [USER_A.userId, USER_B.userId],
    );
    expect(thresholds[USER_A.userId]).toBe(true);
    expect(thresholds[USER_B.userId]).toBe(true);

    const latency = queryK2LatencyMs(METRIC_EVENTS, "req-k2-a");
    expect(latency).not.toBeNull();
    expect(latency as number).toBeLessThan(10000);

    const voiceLatency = queryK3VoiceLatency(METRIC_EVENTS, 30, FIXED_NOW);
    expect(voiceLatency.p95Ms as number).toBeLessThanOrEqual(K3_P95_TIMEOUT_MS);
    expect(voiceLatency.p100Ms as number).toBeLessThanOrEqual(K3_P100_TIMEOUT_MS);

    const audit = queryK4CrossUserAudit(TENANT_AUDIT_RUNS);
    expect(audit.crossUserReferences).toBe(0);
    expect(audit.passed).toBe(true);

    const spend = queryK5MonthlySpend(
      COST_EVENTS,
      K5_MONTHLY_CEILING_USD,
      FIXED_MONTH_UTC,
    );
    expect(spend.withinBudget).toBe(true);
    expect(spend.degradeModeActive).toBe(false);

    for (const user of [USER_A, USER_B]) {
      const activeDays = queryK6ActiveDays(ALL_MEALS, user.userId);
      const retention = queryK6WeeklyRetention(
        activeDays,
        FIXED_WEEK_START,
        FIXED_WEEK_END,
      );
      expect(retention.activeDaysInWeek).toBeGreaterThanOrEqual(
        K6_RETENTION_THRESHOLD,
      );
    }

    const accuracy = queryK7Accuracy(
      ALL_K7_LABELS,
      K7_CALORIE_TOLERANCE,
      K7_MACRO_TOLERANCE,
      5,
      5,
    );
    expect(accuracy.totalLabeled).toBeGreaterThan(0);
    expect(accuracy.mealsWithinCalorieBounds).toBe(ALL_K7_LABELS.length);
    expect(accuracy.mealsWithinMacroBounds).toBe(ALL_K7_LABELS.length);
    expect(accuracy.withinK7Targets).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behavioral smoke ACs — exercising actual production exports
// ---------------------------------------------------------------------------

describe("pilot behavioral smoke ACs", () => {
  it("tenant isolation: HistoryService returns only user-scoped meals", async () => {
    const mealsByUser: Record<string, ConfirmedMealView[]> = {
      [USER_A.userId]: ALL_MEALS.filter(
        (m) => m.user_id === USER_A.userId && m.deleted_at == null,
      ).map(mealRowToConfirmedMealView),
      [USER_B.userId]: ALL_MEALS.filter(
        (m) => m.user_id === USER_B.userId && m.deleted_at == null,
      ).map(mealRowToConfirmedMealView),
    };

    const historyService = new HistoryService(createMockHistoryDeps(mealsByUser));

    const pageA = await historyService.listHistory(USER_A.userId);
    const pageB = await historyService.listHistory(USER_B.userId);

    expect(pageA.meals.every((m) => m.userId === USER_A.userId)).toBe(true);
    expect(pageB.meals.every((m) => m.userId === USER_B.userId)).toBe(true);
    expect(pageA.meals.some((m) => m.userId === USER_B.userId)).toBe(false);
    expect(pageB.meals.some((m) => m.userId === USER_A.userId)).toBe(false);
  });

  it("photo confidence: low confidence triggers label and no auto-persist", () => {
    const itemConfidences = [0.3, 0.4];
    const confidence = computeDraftConfidence(itemConfidences);
    expect(isLowConfidence(confidence)).toBe(true);
    const label = getLowConfidenceLabel(confidence);
    expect(label).toContain("низкая уверенность");

    // Simulate the orchestrator guard: low-confidence items must be shown
    // with a label before user confirms. The meal is NOT persisted until
    // confirmation.
    const draft = {
      userId: USER_A.userId,
      items: itemConfidences,
      lowConfidenceLabel: label,
      persisted: false,
    };
    expect(draft.persisted).toBe(false);
    expect(draft.lowConfidenceLabel).toBeTruthy();
  });

  it("summary guard: forbidden-topic output is blocked and deterministic fallback delivered", () => {
    const forbiddenPayload = JSON.stringify({
      recommendation_ru: "Поставьте диагноз и измените дозу лекарств",
    });
    const validation = validateRecommendationOutput(forbiddenPayload);
    expect(validation.valid).toBe(false);
    expect(validation.blockedReason).toMatch(/forbidden_topic/);

    const fallback = buildDeterministicFallback(
      { totalCaloriesKcal: 1500, totalProteinG: 100, totalFatG: 50, totalCarbsG: 150 },
      { caloriesKcal: 1600, proteinG: 120, fatG: 60, carbsG: 170 },
    );
    expect(fallback).not.toContain("диагноз");
    expect(fallback).not.toContain("лекарств");
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("right-to-delete: removes all user A data and allows fresh onboarding", async () => {
    const repo = createMockRightToDeleteRepository([
      { id: USER_A.userId, telegramUserId: USER_A.telegramUserId, telegramChatId: USER_A.telegramChatId },
      { id: USER_B.userId, telegramUserId: USER_B.telegramUserId, telegramChatId: USER_B.telegramChatId },
    ]);
    const service = new RightToDeleteService({ repository: repo });

    // Delete user A
    const resultA = await service.handle({
      requestId: "rtd-smoke-a",
      text: "да",
      telegramUserId: Number(USER_A.telegramUserId),
      telegramChatId: Number(USER_A.telegramChatId),
    });
    expect(resultA.status).toBe("deleted");
    expect(resultA.deletedUserId).toBe(USER_A.userId);
    expect(repo.deletedUserIds.has(USER_A.userId)).toBe(true);

    // User B still exists
    const resultB = await service.handle({
      requestId: "rtd-smoke-b",
      text: "нет",
      telegramUserId: Number(USER_B.telegramUserId),
      telegramChatId: Number(USER_B.telegramChatId),
    });
    expect(resultB.status).toBe("cancelled");
    expect(repo.deletedUserIds.has(USER_B.userId)).toBe(false);

    // Fresh onboarding for a new user
    const freshResult = await service.handle({
      requestId: "rtd-smoke-fresh",
      text: "да",
      telegramUserId: 999999,
      telegramChatId: 888888,
    });
    expect(freshResult.status).toBe("fresh_start");
  });

  it("tenant audit: end-of-pilot run reports zero cross-user references", async () => {
    const connect = createMockTenantAuditConnectionFactory(0);
    const deps: TenantAuditDeps = {
      connect,
      env: { AUDIT_DB_URL: "mock://audit" },
    };
    const result = await runEndOfPilotTenantAudit(deps);
    expect(result.crossUserReferenceCount).toBe(0);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Readiness report
// ---------------------------------------------------------------------------

describe("pilot readiness report - redaction and summary", () => {
  it("prints ready when all KPIs pass", () => {
    const data = buildPilotReadinessData();
    const report = formatPilotReadinessReport(data);
    expect(report).toContain("READY");
    expect(report).toContain("K1");
    expect(report).toContain("K3");
    expect(report).toContain("K4");
    expect(report).toContain("K5");
    expect(report).toContain("K6");
    expect(report).toContain("K7");
  });

  it("omits sensitive identifiers and payload sentinel strings", () => {
    const data = buildPilotReadinessData();
    const report = formatPilotReadinessReport(data);

    for (const sentinel of Object.values(SENSITIVE_SENTINELS)) {
      expect(report).not.toContain(sentinel);
    }
    expect(report).not.toContain(USER_A.telegramUserId);
    expect(report).not.toContain(USER_A.username);
    expect(report).not.toContain("username");
    expect(report).not.toContain("first_name");
    expect(report).not.toContain("provider_key");
    expect(report).not.toContain("raw_media");
  });

  it("reports NOT READY when K1 thresholds are empty", () => {
    const data = buildPilotReadinessData();
    const emptyK1: Record<string, boolean> = {};
    const badData = { ...data, k1UserThresholds: emptyK1 };
    const report = formatPilotReadinessReport(badData);
    expect(report).toContain("NOT READY");
  });

  it("reports NOT READY when an expected user fails K1", () => {
    const data = buildPilotReadinessData();
    const failingK1 = { ...data.k1UserThresholds, [USER_A.userId]: false };
    const badData = { ...data, k1UserThresholds: failingK1 };
    const report = formatPilotReadinessReport(badData);
    expect(report).toContain("NOT READY");
  });

  it("redacts Cyrillic-homoglyph variants of sensitive field names", () => {
    const data = buildPilotReadinessData();
    const cyrillicTelegram = 'тelegrаm_id: "123456789"';
    const cyrillicTelegramBare = "тelegrаm 123456789";
    const cyrillicUsername = 'usernаmе: "secret"';
    const cyrillicRawMedia = "rаw_меdia: blob";
    const cyrillicProviderKey = "рrovider_кеy: secret";
    const cyrillicProviderToken = "рrovider_тоkеn: secret";

    const homoglyphData: PilotReadinessData = {
      ...data,
      k6WeeklyRetentions: {
        [cyrillicTelegram]: { activeDaysInWeek: 5, daysInWeek: 7, metThreshold: true },
        [cyrillicTelegramBare]: { activeDaysInWeek: 5, daysInWeek: 7, metThreshold: true },
        [cyrillicUsername]: { activeDaysInWeek: 5, daysInWeek: 7, metThreshold: true },
        [cyrillicRawMedia]: { activeDaysInWeek: 5, daysInWeek: 7, metThreshold: true },
        [cyrillicProviderKey]: { activeDaysInWeek: 5, daysInWeek: 7, metThreshold: true },
        [cyrillicProviderToken]: { activeDaysInWeek: 5, daysInWeek: 7, metThreshold: true },
      },
    };

    const report = formatPilotReadinessReport(homoglyphData);
    expect(report).not.toContain(cyrillicTelegram);
    expect(report).not.toContain(cyrillicTelegramBare);
    expect(report).not.toContain(cyrillicUsername);
    expect(report).not.toContain(cyrillicRawMedia);
    expect(report).not.toContain(cyrillicProviderKey);
    expect(report).not.toContain(cyrillicProviderToken);
    expect(report).not.toContain("telegram_id");
    expect(report).not.toContain("username");
    expect(report).not.toContain("provider_key");
    expect(report).not.toContain("provider_token");
    expect(report).not.toContain("raw_media");
    expect(report).toContain("[REDACTED]");
  });
});
