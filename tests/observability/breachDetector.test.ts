import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BreachDetector,
  TenantNotAllowedError,
  sha256Half,
  type RedactedBreachEvent,
  type BreachDetectorDeps,
} from "../../src/observability/breachDetector.js";
import {
  BreachDetectingTenantStore,
} from "../../src/store/tenantStore.js";
import type { TenantStore } from "../../src/store/types.js";
import http from "node:http";
import { createServer } from "../../src/main.js";
import type { C1Deps } from "../../src/telegram/types.js";

const AUTHENTICATED_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const FORBIDDEN_JSON_KEYS = [
  "meal_text",
  "username",
  "transcript",
  "prompt",
  "provider_payload",
  "telegram_id",
  "user_id",
  "raw_prompt",
  "raw_transcript",
];

function makeDetectorDeps() {
  const emitted: RedactedBreachEvent[] = [];
  const deps: BreachDetectorDeps = {
    emit: (e) => emitted.push(e),
    now: () => new Date(),
    hashUserId: (id) => sha256Half(id),
  };
  return { deps, emitted };
}

function makeStubStore(): TenantStore {
  return {
    withTransaction: vi.fn().mockResolvedValue(undefined),
    createUser: vi.fn().mockResolvedValue({ id: AUTHENTICATED_USER }),
    getUser: vi.fn().mockResolvedValue({ id: AUTHENTICATED_USER }),
    updateUserOnboardingStatus: vi.fn().mockResolvedValue({ id: AUTHENTICATED_USER }),
    deleteUser: vi.fn().mockResolvedValue(true),
    createUserProfile: vi.fn().mockResolvedValue({ id: "p1", user_id: AUTHENTICATED_USER }),
    getLatestUserProfile: vi.fn().mockResolvedValue({ id: "p1", user_id: AUTHENTICATED_USER }),
    createUserTarget: vi.fn().mockResolvedValue({ id: "t1", user_id: AUTHENTICATED_USER }),
    upsertSummarySchedule: vi.fn().mockResolvedValue({ id: "ss1", user_id: AUTHENTICATED_USER }),
    listSummarySchedules: vi.fn().mockResolvedValue([]),
    upsertOnboardingState: vi.fn().mockResolvedValue({ id: "os1", user_id: AUTHENTICATED_USER }),
    updateOnboardingStateWithVersion: vi.fn().mockResolvedValue({ id: "os1", user_id: AUTHENTICATED_USER }),
    createTranscript: vi.fn().mockResolvedValue({ id: "tr1", user_id: AUTHENTICATED_USER }),
    createMealDraft: vi.fn().mockResolvedValue({ id: "md1", user_id: AUTHENTICATED_USER }),
    updateMealDraftWithVersion: vi.fn().mockResolvedValue({ id: "md1", user_id: AUTHENTICATED_USER }),
    createMealDraftItem: vi.fn().mockResolvedValue({ id: "mdi1", user_id: AUTHENTICATED_USER }),
    deleteMealDraftItemsByDraftId: vi.fn().mockResolvedValue(0),
    createConfirmedMeal: vi.fn().mockResolvedValue({ id: "cm1", user_id: AUTHENTICATED_USER }),
    listConfirmedMeals: vi.fn().mockResolvedValue([]),
    softDeleteConfirmedMealWithVersion: vi.fn().mockResolvedValue({ id: "cm1", user_id: AUTHENTICATED_USER }),
    createMealItem: vi.fn().mockResolvedValue({ id: "mi1", user_id: AUTHENTICATED_USER }),
    createSummaryRecord: vi.fn().mockResolvedValue({ id: "sr1", user_id: AUTHENTICATED_USER }),
    createAuditEvent: vi.fn().mockResolvedValue({ id: "ae1", user_id: AUTHENTICATED_USER }),
    createMetricEvent: vi.fn().mockResolvedValue({ id: "me1", user_id: AUTHENTICATED_USER }),
    createCostEvent: vi.fn().mockResolvedValue({ id: "ce1", user_id: AUTHENTICATED_USER }),
    upsertMonthlySpendCounter: vi.fn().mockResolvedValue({ id: "msc1", user_id: AUTHENTICATED_USER }),
    getMonthlySpendCounter: vi.fn().mockResolvedValue(null),
    incrementMonthlySpend: vi.fn().mockResolvedValue({ id: "msc1", user_id: AUTHENTICATED_USER }),
    upsertFoodLookupCache: vi.fn().mockResolvedValue({ id: "flc1", user_id: AUTHENTICATED_USER }),
    createKbjuAccuracyLabel: vi.fn().mockResolvedValue({ id: "kal1", user_id: AUTHENTICATED_USER }),
    getModalitySettings: vi.fn().mockResolvedValue(null),
    setModalitySetting: vi.fn().mockResolvedValue({ oldValue: true, newValue: false }),
    insertWaterEvent: vi.fn().mockResolvedValue({ event_id: "e1" }),
    insertMoodEvent: vi.fn().mockResolvedValue({ event_id: "me1" }),
    insertSleepRecord: vi.fn().mockResolvedValue({ record_id: "sr1" }),
    getSleepPairingState: vi.fn().mockResolvedValue(null),
    upsertSleepPairingState: vi.fn().mockResolvedValue(undefined),
    deleteSleepPairingState: vi.fn().mockResolvedValue(undefined),
    gcExpiredSleepPairingState: vi.fn().mockResolvedValue({ rows_deleted: 0 }),
    insertWorkoutEvent: vi.fn().mockResolvedValue({ event_id: "we1" }),
    getWaterEventsInWindow: vi.fn().mockResolvedValue([]),    getSleepRecordsInWindow: vi.fn().mockResolvedValue([]),    getWorkoutEventsInWindow: vi.fn().mockResolvedValue([]),    getMoodEventsInWindow: vi.fn().mockResolvedValue([]),
  };
}

describe("BreachDetector", () => {
  it("same-tenant read emits zero breach events", () => {
    const { deps, emitted } = makeDetectorDeps();
    const detector = new BreachDetector(deps);
    detector.checkTenantAccess(AUTHENTICATED_USER, AUTHENTICATED_USER, "read", "users");
    expect(emitted).toHaveLength(0);
  });

  it("same-tenant write emits zero breach events", () => {
    const { deps, emitted } = makeDetectorDeps();
    const detector = new BreachDetector(deps);
    detector.checkTenantAccess(AUTHENTICATED_USER, AUTHENTICATED_USER, "write", "users");
    expect(emitted).toHaveLength(0);
  });

  it("cross-tenant read emits exactly one kbju_tenant_breach_detected event and throws", () => {
    const { deps, emitted } = makeDetectorDeps();
    const detector = new BreachDetector(deps);
    expect(() =>
      detector.checkTenantAccess(AUTHENTICATED_USER, OTHER_USER, "read", "confirmed_meals")
    ).toThrow(TenantNotAllowedError);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event_name).toBe("kbju_tenant_breach_detected");
    expect(emitted[0].operation).toBe("read");
    expect(emitted[0].entity_type).toBe("confirmed_meals");
  });

  it("cross-tenant write emits exactly one kbju_tenant_breach_detected event and throws", () => {
    const { deps, emitted } = makeDetectorDeps();
    const detector = new BreachDetector(deps);
    expect(() =>
      detector.checkTenantAccess(AUTHENTICATED_USER, OTHER_USER, "write", "meal_drafts")
    ).toThrow(TenantNotAllowedError);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event_name).toBe("kbju_tenant_breach_detected");
    expect(emitted[0].operation).toBe("write");
    expect(emitted[0].entity_type).toBe("meal_drafts");
  });

  it("TenantNotAllowedError has code tenant_not_allowed", () => {
    const { deps } = makeDetectorDeps();
    const detector = new BreachDetector(deps);
    try {
      detector.checkTenantAccess(AUTHENTICATED_USER, OTHER_USER, "write", "users");
    } catch (e) {
      expect(e).toBeInstanceOf(TenantNotAllowedError);
      const err = e as TenantNotAllowedError;
      expect(err.code).toBe("tenant_not_allowed");
    }
  });

  it("redacted event JSON contains no forbidden raw payload fields", () => {
    const { deps, emitted } = makeDetectorDeps();
    const detector = new BreachDetector(deps);
    try {
      detector.checkTenantAccess(AUTHENTICATED_USER, OTHER_USER, "read", "users");
    } catch {}
    const json = JSON.stringify(emitted[0]);
    const parsed = JSON.parse(json);
    for (const key of FORBIDDEN_JSON_KEYS) {
      expect(parsed[key]).toBeUndefined();
    }
    expect(typeof parsed.requesting_user_id_hash).toBe("string");
    expect(typeof parsed.data_owner_user_id_hash).toBe("string");
    expect(parsed.requesting_user_id_hash).toHaveLength(16);
    expect(parsed.data_owner_user_id_hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(parsed.requesting_user_id_hash)).toBe(true);
    expect(/^[0-9a-f]{16}$/.test(parsed.data_owner_user_id_hash)).toBe(true);
  });

  it("getBreachCountLastHour returns correct count within rolling hour", () => {
    const { deps } = makeDetectorDeps();
    const detector = new BreachDetector(deps);
    expect(detector.getBreachCountLastHour()).toBe(0);
    try { detector.checkTenantAccess(AUTHENTICATED_USER, OTHER_USER, "read", "users"); } catch {}
    try { detector.checkTenantAccess(AUTHENTICATED_USER, OTHER_USER, "write", "meal_drafts"); } catch {}
    expect(detector.getBreachCountLastHour()).toBe(2);
  });

  it("getBreachCountLastHour prunes entries older than one hour", () => {
    const now = new Date("2026-05-05T12:00:00Z");
    const emitted: RedactedBreachEvent[] = [];
    const deps: BreachDetectorDeps = {
      emit: (e) => emitted.push(e),
      now: () => now,
      hashUserId: (id) => sha256Half(id),
    };
    const detector = new BreachDetector(deps);
    try { detector.checkTenantAccess(AUTHENTICATED_USER, OTHER_USER, "read", "users"); } catch {}
    now.setTime(now.getTime() + 61 * 60 * 1000);
    expect(detector.getBreachCountLastHour()).toBe(0);
  });

  it("breachTimestamps prunes itself even when getBreachCountLastHour is never called", () => {
    const now = new Date("2026-05-05T10:00:00Z");
    const emitted: RedactedBreachEvent[] = [];
    const deps: BreachDetectorDeps = {
      emit: (e) => emitted.push(e),
      now: () => now,
      hashUserId: (id) => sha256Half(id),
    };
    const detector = new BreachDetector(deps);
    for (let i = 0; i < 500; i++) {
      try { detector.checkTenantAccess(AUTHENTICATED_USER, OTHER_USER, "read", "users"); } catch {}
    }
    now.setTime(now.getTime() + 70 * 60 * 1000);
    for (let i = 0; i < 500; i++) {
      try { detector.checkTenantAccess(AUTHENTICATED_USER, OTHER_USER, "read", "users"); } catch {}
    }
    expect(detector.getBreachCountLastHour()).toBe(500);
  });
});

describe("BreachDetectingTenantStore", () => {
  it("same-tenant read passes with zero breach events", async () => {
    const { deps, emitted } = makeDetectorDeps();
    const detector = new BreachDetector(deps);
    const stub = makeStubStore();
    const wrapped = new BreachDetectingTenantStore(stub, AUTHENTICATED_USER, detector);
    await wrapped.getUser(AUTHENTICATED_USER);
    expect(emitted).toHaveLength(0);
  });

  it("same-tenant write passes with zero breach events", async () => {
    const { deps, emitted } = makeDetectorDeps();
    const detector = new BreachDetector(deps);
    const stub = makeStubStore();
    const wrapped = new BreachDetectingTenantStore(stub, AUTHENTICATED_USER, detector);
    await wrapped.createUser(AUTHENTICATED_USER, {
      telegramUserId: "123",
      telegramChatId: "456",
      timezone: "UTC",
    } as any);
    expect(emitted).toHaveLength(0);
  });

  it("cross-tenant read fires a breach and throws TenantNotAllowedError", async () => {
    const { deps, emitted } = makeDetectorDeps();
    const detector = new BreachDetector(deps);
    const stub = makeStubStore();
    const wrapped = new BreachDetectingTenantStore(stub, AUTHENTICATED_USER, detector);
    await expect(wrapped.getUser(OTHER_USER)).rejects.toThrow(TenantNotAllowedError);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event_name).toBe("kbju_tenant_breach_detected");
    expect(emitted[0].operation).toBe("read");
  });

  it("cross-tenant write fires a breach and throws TenantNotAllowedError", async () => {
    const { deps, emitted } = makeDetectorDeps();
    const detector = new BreachDetector(deps);
    const stub = makeStubStore();
    const wrapped = new BreachDetectingTenantStore(stub, AUTHENTICATED_USER, detector);
    await expect(
      wrapped.createUser(OTHER_USER, {
        telegramUserId: "123",
        telegramChatId: "456",
        timezone: "UTC",
      } as any)
    ).rejects.toThrow(TenantNotAllowedError);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event_name).toBe("kbju_tenant_breach_detected");
    expect(emitted[0].operation).toBe("write");
  });

  it("transaction-internal cross-tenant repository call is RLS-denied without firing a breach event", async () => {
    const { deps, emitted } = makeDetectorDeps();
    const detector = new BreachDetector(deps);

    const innerStore: TenantStore = {
      ...makeStubStore(),
      withTransaction: vi.fn(async (userId, action) => {
        const repo = {
          createUser: vi.fn().mockRejectedValue(new Error("permission denied for table users (RLS)")),
        } as unknown as Parameters<typeof action>[0];
        return action(repo);
      }),
    };

    const wrapped = new BreachDetectingTenantStore(innerStore, AUTHENTICATED_USER, detector);

    await expect(
      wrapped.withTransaction(AUTHENTICATED_USER, async (repo) => {
        await repo.createUser(OTHER_USER, { telegramUserId: "x", telegramChatId: "y", timezone: "UTC" } as any);
      })
    ).rejects.toThrow(/permission denied|RLS/);

    expect(emitted).toHaveLength(0);
  });
});

describe("/kbju/health breach_count_last_hour", () => {
  const PORT = 32103;
  let server: http.Server;
  let detector: BreachDetector;

  beforeEach(() => {
    const { deps } = makeDetectorDeps();
    detector = new BreachDetector(deps);
  });

  afterEach(() => {
    server?.close();
  });

  it("includes numeric breach_count_last_hour reflecting cross-tenant attempts", async () => {
    try { detector.checkTenantAccess(AUTHENTICATED_USER, OTHER_USER, "read", "users"); } catch {}
    const deps: C1Deps = {
      handlers: {
        start: async () => ({ chatId: 1, text: "hi", typingRenewalRequired: false }),
        forgetMe: async () => ({ chatId: 1, text: "bye", typingRenewalRequired: false }),
        textMeal: async () => ({ chatId: 1, text: "ok", typingRenewalRequired: false }),
        voiceMeal: async () => ({ chatId: 1, text: "ok", typingRenewalRequired: false }),
        photoMeal: async () => ({ chatId: 1, text: "ok", typingRenewalRequired: false }),
        history: async () => ({ chatId: 1, text: "ok", typingRenewalRequired: false }),
        callback: async () => ({ chatId: 1, text: "ok", typingRenewalRequired: false }),
        summaryDelivery: async () => ({ chatId: 1, text: "ok", typingRenewalRequired: false }),
      },
      sendMessage: async () => {},
      sendChatAction: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {}, critical: () => {} },
      pilotUserIds: [AUTHENTICATED_USER],
      metricsRegistry: { increment: () => {}, set: () => {}, observe: () => {}, getSamples: () => [], render: () => "" },
      breachDetector: detector,
    };
    server = createServer({ pilotUserIds: [AUTHENTICATED_USER], deps });
    await new Promise<void>((resolve) => server.listen(PORT, () => resolve()));

    const res = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: PORT, path: "/kbju/health", method: "GET" },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c.toString()));
          res.on("end", () => resolve(JSON.parse(data)));
        }
      );
      req.on("error", reject);
      req.end();
    });

    expect(typeof res.breach_count_last_hour).toBe("number");
    expect(res.breach_count_last_hour).toBe(1);
  });
});
