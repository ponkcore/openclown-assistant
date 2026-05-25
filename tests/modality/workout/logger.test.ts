import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleWorkoutEvent } from "../../../src/modality/workout/logger.js";
import { ExtractorConfigLoader } from "../../../src/modality/workout/extractWorkout.js";
import type { MetricsRegistry } from "../../../src/observability/metricsEndpoint.js";
import type { OpenClawLogger } from "../../../src/shared/types.js";
import type { TenantStore } from "../../../src/store/types.js";
import type { ModalitySettings } from "../../../src/modality/settings/service.js";
import { WORKOUT_TYPE_ENUM } from "../../../src/modality/workout/validator.js";
import {
  AMBIGUOUS_REPLY,
  PHOTO_AMBIGUOUS_REPLY,
  MISSING_FIELDS_REPLY,
  OFF_STATE_REPLY,
} from "../../../src/modality/workout/copy.ru.js";
import { PROMETHEUS_METRIC_NAMES } from "../../../src/observability/kpiEvents.js";

// Mock llmClient + registry
vi.mock("../../../src/llm/llmClient.js", () => ({
  chatCompletion: vi.fn(),
  vision: vi.fn(),
  isPromptOrResponseSafeForLogging: vi.fn().mockReturnValue(true),
}));

vi.mock("../../../src/llm/registry.js", () => ({
  resolve: vi.fn(),
  getApiKey: vi.fn().mockReturnValue("test-api-key"),
  initRegistry: vi.fn(),
  closeRegistry: vi.fn(),
  reload: vi.fn(),
  _resetLegacyWarned: vi.fn(),
  adaptMetricsSink: vi.fn(),
  RegistryError: class RegistryError extends Error { code = ""; },
}));

import { chatCompletion, vision } from "../../../src/llm/llmClient.js";
import { resolve } from "../../../src/llm/registry.js";
import type { Resolved } from "../../../src/llm/registry.js";
import type { ChatCompletionResult } from "../../../src/llm/llmClient.js";

const mockChatCompletion = vi.mocked(chatCompletion);
const mockVision = vi.mocked(vision);
const mockResolve = vi.mocked(resolve);

const MOCK_RESOLVED: Resolved = {
  provider_id: "fireworks",
  base_url: "https://api.fireworks.ai/inference/v1",
  api_key_env: "LLM_FIREWORKS_API_KEY",
  model: "accounts/fireworks/models/qwen3-vl-30b-a3b",
  fallback: {
    provider_id: "fireworks",
    base_url: "https://api.fireworks.ai/inference/v1",
    api_key_env: "LLM_FIREWORKS_API_KEY",
    model: "accounts/fireworks/models/executor",
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMetrics(): MetricsRegistry {
  return {
    increment: vi.fn(),
    set: vi.fn(),
    observe: vi.fn(),
    getSamples: vi.fn().mockReturnValue([]),
    render: vi.fn().mockReturnValue(""),
  };
}

function makeLogger(): OpenClawLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
}

function makeStubStore(): TenantStore {
  return {
    withTransaction: vi.fn(),
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
    insertWorkoutEvent: vi.fn().mockResolvedValue({ event_id: "evt-123" }),
  } as unknown as TenantStore;
}

const SETTINGS_ON: ModalitySettings = {
  waterOn: true,
  sleepOn: true,
  workoutOn: true,
  moodOn: true,
};

const SETTINGS_OFF: ModalitySettings = {
  waterOn: true,
  sleepOn: true,
  workoutOn: false,
  moodOn: true,
};

const EXTRACTOR_CONFIG = {
  systemPromptTemplate: "Extract workout from message. Schema: {{JSON_SCHEMA}}. Respond with ONLY JSON.",
  outputJsonSchema: '{"workout_type":"string","duration_min":"integer|null","distance_km":"number|null","sets":"integer|null","repetitions":"integer|null","confidence":"number"}',
  confidenceThreshold: 0.5,
  call_type: "kbju.workout_extractor",
};

function makeExtractorConfigLoader(
  config = EXTRACTOR_CONFIG,
): { loader: ExtractorConfigLoader; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workout-logger-test-"));
  const filePath = path.join(tmpDir, "workout-extractor.json");
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(config), "utf-8");
  fs.renameSync(tmpPath, filePath);
  const logger = makeLogger();
  const loader = new ExtractorConfigLoader(filePath, logger);
  return { loader, cleanup: () => { loader.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } };
}

function makeSpendTracker() {
  return {
    preflightCheck: async () => ({ allowed: true, projectedSpendUsd: 0, estimatedCallCostUsd: 0 }),
    recordCostAndCheckBudget: async () => {},
    getState: async () => ({
      estimatedSpendUsd: 0,
      degradeModeEnabled: false,
      poAlertSentAt: null,
      monthUtc: new Date().toISOString().slice(0, 7),
    }),
  };
}

function successfulOmniResult(json: string): ChatCompletionResult {
  return {
    provider_id: "fireworks",
    model: "accounts/fireworks/models/qwen3-vl-30b-a3b",
    rawResponseText: json,
    inputUnits: 50,
    outputUnits: 30,
    estimatedCostUsd: 0.0001,
    outcome: "success",
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("handleWorkoutEvent", () => {
  let loader: ExtractorConfigLoader;
  let cleanup: () => void;
  let metrics: MetricsRegistry;
  let logger: OpenClawLogger;
  let store: TenantStore;
  let spendTracker: ReturnType<typeof makeSpendTracker>;

  beforeEach(() => {
    mockResolve.mockReturnValue(MOCK_RESOLVED);
    const result = makeExtractorConfigLoader();
    loader = result.loader;
    cleanup = result.cleanup;
    metrics = makeMetrics();
    logger = makeLogger();
    store = makeStubStore();
    spendTracker = makeSpendTracker();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ── Text extraction with each enum value ────────────────────────────────

  describe("text source — each enum value", () => {
    for (const type of WORKOUT_TYPE_ENUM) {
      it(`persists workout_type="${type}" from text`, async () => {
        mockChatCompletion.mockResolvedValueOnce(successfulOmniResult(
          JSON.stringify({ workout_type: type, duration_min: 30, distance_km: null, sets: null, repetitions: null, confidence: 0.9 }),
        ));

        const result = await handleWorkoutEvent(
          { userId: "user-1", source: "text", rawText: `тренировка ${type}`, requestId: "req-1" },
          store,
          SETTINGS_ON,
          loader,
          metrics,
          logger,
          spendTracker as any,
        );

        expect(result.persisted).toBe(true);
        expect(store.insertWorkoutEvent).toHaveBeenCalledOnce();
        const callArgs = vi.mocked(store.insertWorkoutEvent).mock.calls[0];
        expect(callArgs[2]).toBe(type); // workoutType
        expect(callArgs[1]).toBe("text"); // source
      });
    }
  });

  // ── Voice extraction ─────────────────────────────────────────────────────

  it("persists workout from voice source with source='voice'", async () => {
    mockChatCompletion.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: 45, distance_km: 5, sets: null, repetitions: null, confidence: 0.85 }),
    ));

    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "voice", rawText: "пробежал 5 км", requestId: "req-v1" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(true);
    expect(store.insertWorkoutEvent).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(store.insertWorkoutEvent).mock.calls[0];
    expect(callArgs[1]).toBe("voice");
    expect(callArgs[2]).toBe("running");
  });

  // ── Photo extraction ────────────────────────────────────────────────────

  it("persists workout from photo source with source='photo'", async () => {
    mockVision.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "cycling", duration_min: 60, distance_km: 20, sets: null, repetitions: null, confidence: 0.8 }),
    ));

    const photoDownloader = vi.fn().mockResolvedValue("fake-base64-image");

    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "photo", photoFileId: "file-123", requestId: "req-p1" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
      false,
      photoDownloader,
    );

    expect(result.persisted).toBe(true);
    expect(photoDownloader).toHaveBeenCalledWith("file-123");
    expect(store.insertWorkoutEvent).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(store.insertWorkoutEvent).mock.calls[0];
    expect(callArgs[1]).toBe("photo");
    expect(callArgs[2]).toBe("cycling");
  });

  it("returns PHOTO_AMBIGUOUS_REPLY when photo download fails", async () => {
    const photoDownloader = vi.fn().mockRejectedValue(new Error("download failed"));

    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "photo", photoFileId: "file-123", requestId: "req-p2" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
      false,
      photoDownloader,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(PHOTO_AMBIGUOUS_REPLY);
  });

  // ── Out-of-enum rejection ──────────────────────────────────────────────

  it("returns AMBIGUOUS_REPLY when LLM returns out-of-enum type", async () => {
    mockChatCompletion.mockResolvedValue(successfulOmniResult(
      JSON.stringify({ workout_type: "jogging", duration_min: 20, distance_km: null, sets: null, repetitions: null, confidence: 0.8 }),
    ));

    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "text", rawText: "пробежка", requestId: "req-oe1" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(AMBIGUOUS_REPLY);
  });

  // ── Negative numeric rejection ──────────────────────────────────────────

  it("returns AMBIGUOUS_REPLY when LLM returns negative duration", async () => {
    mockChatCompletion.mockResolvedValue(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: -5, distance_km: null, sets: null, repetitions: null, confidence: 0.9 }),
    ));

    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "text", rawText: "бег", requestId: "req-neg1" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(AMBIGUOUS_REPLY);
  });

  // ── Ambiguous → clarifying reply ────────────────────────────────────────

  it("returns AMBIGUOUS_REPLY when all LLM tiers fail", async () => {
    mockChatCompletion.mockRejectedValue(new Error("all down"));

    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "text", rawText: "что-то", requestId: "req-amb1" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(AMBIGUOUS_REPLY);
  });

  it("returns AMBIGUOUS_REPLY when confidence is below threshold", async () => {
    mockChatCompletion.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: 30, distance_km: null, sets: null, repetitions: null, confidence: 0.3 }),
    ));

    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "text", rawText: "может бег", requestId: "req-low-conf" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(AMBIGUOUS_REPLY);
  });

  // ── OFF-state skip ──────────────────────────────────────────────────────

  it("skips silently when workout_on=false (text source)", async () => {
    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "text", rawText: "бег 30 мин", requestId: "req-off1" },
      store,
      SETTINGS_OFF,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(OFF_STATE_REPLY);
    expect(store.insertWorkoutEvent).not.toHaveBeenCalled();
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it("skips silently when workout_on=false (voice source)", async () => {
    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "voice", rawText: "пробежал", requestId: "req-off2" },
      store,
      SETTINGS_OFF,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(OFF_STATE_REPLY);
  });

  it("skips silently when workout_on=false (photo source)", async () => {
    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "photo", photoFileId: "file-123", requestId: "req-off3" },
      store,
      SETTINGS_OFF,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(OFF_STATE_REPLY);
  });

  // ── Telemetry counter shape ─────────────────────────────────────────────

  it("emits kbju_modality_event_persisted counter with {modality, source} labels", async () => {
    mockChatCompletion.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: 30, distance_km: null, sets: null, repetitions: null, confidence: 0.9 }),
    ));

    await handleWorkoutEvent(
      { userId: "user-1", source: "text", rawText: "бег 30 мин", requestId: "req-tel1" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(metrics.increment).toHaveBeenCalledWith(
      PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
      { modality: "workout", source: "text" },
    );
  });

  it("emits counter with source='voice' for voice input", async () => {
    mockChatCompletion.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "swimming", duration_min: 45, distance_km: null, sets: null, repetitions: null, confidence: 0.85 }),
    ));

    await handleWorkoutEvent(
      { userId: "user-1", source: "voice", rawText: "плавание", requestId: "req-tel2" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(metrics.increment).toHaveBeenCalledWith(
      PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
      { modality: "workout", source: "voice" },
    );
  });

  it("emits counter with source='photo' for photo input", async () => {
    mockVision.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "yoga", duration_min: 60, distance_km: null, sets: null, repetitions: null, confidence: 0.8 }),
    ));

    const photoDownloader = vi.fn().mockResolvedValue("fake-base64");

    await handleWorkoutEvent(
      { userId: "user-1", source: "photo", photoFileId: "file-123", requestId: "req-tel3" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
      false,
      photoDownloader,
    );

    expect(metrics.increment).toHaveBeenCalledWith(
      PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
      { modality: "workout", source: "photo" },
    );
  });

  // ── raw_workout_text NOT in any emit ────────────────────────────────────

  it("never includes raw_workout_text in telemetry emit", async () => {
    mockChatCompletion.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: 30, distance_km: null, sets: null, repetitions: null, confidence: 0.9 }),
    ));

    await handleWorkoutEvent(
      { userId: "user-1", source: "text", rawText: "секретная тренировка", requestId: "req-sec1" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    // Check that logger.info was called without raw_workout_text
    const infoCalls = vi.mocked(logger.info).mock.calls;
    for (const call of infoCalls) {
      const eventObj = call[1] as Record<string, unknown> | undefined;
      if (eventObj && typeof eventObj === "object") {
        expect(eventObj).not.toHaveProperty("raw_workout_text");
        expect(eventObj).not.toHaveProperty("workout_text");
      }
    }

    // Also check the metrics increment doesn't include raw text
    const incrementCalls = vi.mocked(metrics.increment).mock.calls;
    for (const call of incrementCalls) {
      expect(JSON.stringify(call)).not.toContain("raw_workout_text");
    }
  });

  // ── Empty text ──────────────────────────────────────────────────────────

  it("returns MISSING_FIELDS_REPLY for empty text input", async () => {
    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "text", rawText: "", requestId: "req-empty" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(MISSING_FIELDS_REPLY);
  });

  // ── Reply format verification ────────────────────────────────────────────

  it("returns correct Russian reply for running with distance", async () => {
    mockChatCompletion.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: 32, distance_km: 5, sets: null, repetitions: null, confidence: 0.9 }),
    ));

    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "text", rawText: "пробежал 5 км за 32 мин", requestId: "req-rp1" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(true);
    expect(result.text).toContain("Записала тренировку");
    expect(result.text).toContain("бег");
    expect(result.text).toContain("5");
    expect(result.text).toContain("32");
  });

  it("returns correct Russian reply for strength with sets×reps", async () => {
    mockChatCompletion.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "strength", duration_min: null, distance_km: null, sets: 5, repetitions: 10, confidence: 0.85 }),
    ));

    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "text", rawText: "жим 5×10", requestId: "req-rp2" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(true);
    expect(result.text).toContain("силовая");
    expect(result.text).toContain("5×10");
  });

  it("returns correct Russian reply for yoga with duration only", async () => {
    mockChatCompletion.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "yoga", duration_min: 60, distance_km: null, sets: null, repetitions: null, confidence: 0.8 }),
    ));

    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "text", rawText: "йога 60 мин", requestId: "req-rp3" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(true);
    expect(result.text).toContain("йога");
    expect(result.text).toContain("60 мин");
  });

  // ── No photo file_id ────────────────────────────────────────────────────

  it("returns PHOTO_AMBIGUOUS_REPLY when photo source has no file_id", async () => {
    const result = await handleWorkoutEvent(
      { userId: "user-1", source: "photo", requestId: "req-nofid" },
      store,
      SETTINGS_ON,
      loader,
      metrics,
      logger,
      spendTracker as any,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(PHOTO_AMBIGUOUS_REPLY);
  });
});
