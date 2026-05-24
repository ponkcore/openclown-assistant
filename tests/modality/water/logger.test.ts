import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleWaterEvent } from "../../../src/modality/water/logger.js";
import { ExtractorConfigLoader } from "../../../src/modality/water/extractVolume.js";
import type { MetricsRegistry } from "../../../src/observability/metricsEndpoint.js";
import type { OpenClawLogger } from "../../../src/shared/types.js";
import type { TenantStore } from "../../../src/store/types.js";
import type { ModalitySettings } from "../../../src/modality/settings/service.js";
import { OUT_OF_RANGE_REPLY, OFF_STATE_REPLY, LOW_CONFIDENCE_REPLY } from "../../../src/modality/water/copy.ru.js";
import { buildWaterKeyboard, WATER_PRESETS } from "../../../src/modality/water/keyboard.js";
import { PROMETHEUS_METRIC_NAMES } from "../../../src/observability/kpiEvents.js";

// Mock callOmniRoute
vi.mock("../../../src/llm/omniRouteClient.js", () => ({
  callOmniRoute: vi.fn(),
}));

import { callOmniRoute } from "../../../src/llm/omniRouteClient.js";
const mockCallOmniRoute = vi.mocked(callOmniRoute);

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
    insertWaterEvent: vi.fn().mockResolvedValue({ event_id: "e-001" }),
  } as unknown as TenantStore;
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

const EXTRACTOR_CONFIG = {
  systemPromptTemplate: "Extract volume. Schema: {{JSON_SCHEMA}}. Respond with ONLY JSON.",
  outputJsonSchema: '{"volume_ml":"integer","confidence":"number"}',
  confidenceThreshold: 0.6,
  defaultModel: { modelAlias: "accounts/fireworks/models/gpt-oss-20b", providerHint: "fireworks" },
  fallbackModel: { modelAlias: "accounts/fireworks/models/minimax-m2p7", providerHint: "fireworks" },
  emergencyModel: { modelAlias: "openrouter/nvidia/nemotron-3-super:free", providerHint: "openrouter" },
};

function makeConfigLoader(): { loader: ExtractorConfigLoader; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "water-logger-test-"));
  const filePath = path.join(tmpDir, "water-extractor.json");
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(EXTRACTOR_CONFIG), "utf-8");
  fs.renameSync(tmpPath, filePath);
  const logger = makeLogger();
  const loader = new ExtractorConfigLoader(filePath, logger);
  return { loader, cleanup: () => { loader.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } };
}

function successLLMResponse(volumeMl: number, confidence: number) {
  return {
    providerAlias: "fireworks" as const,
    modelAlias: "accounts/fireworks/models/gpt-oss-20b",
    rawResponseText: JSON.stringify({ volume_ml: volumeMl, confidence }),
    inputUnits: 10,
    outputUnits: 5,
    estimatedCostUsd: 0.0001,
    outcome: "success" as const,
  };
}

function failureLLMResponse() {
  return {
    providerAlias: "fireworks" as const,
    modelAlias: "accounts/fireworks/models/gpt-oss-20b",
    rawResponseText: "",
    inputUnits: 0,
    outputUnits: 0,
    estimatedCostUsd: 0,
    outcome: "provider_failure" as const,
  };
}

function makeDeps(overrides?: Record<string, unknown>) {
  const store = makeStubStore();
  const { loader, cleanup } = makeConfigLoader();
  const metrics = makeMetrics();
  const logger = makeLogger();
  const spendTracker = makeSpendTracker();
  const settingsService = {
    getSettings: vi.fn<() => Promise<ModalitySettings | null>>().mockResolvedValue({
      waterOn: true,
      sleepOn: true,
      workoutOn: true,
      moodOn: true,
    }),
  };

  return {
    deps: {
      store,
      settingsService,
      configLoader: loader,
      metrics,
      logger,
      omniRouteBaseUrl: "http://localhost:11434",
      omniRouteApiKey: "test-key",
      spendTracker: spendTracker as any,
      degradeModeEnabled: false,
      ...overrides,
    },
    cleanup,
    store,
    metrics,
    logger,
    settingsService,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("handleWaterEvent", () => {
  let cleanup: () => void;

  afterEach(() => {
    if (cleanup) cleanup();
    vi.restoreAllMocks();
  });

  it("persists keyboard preset directly", async () => {
    const { deps, cleanup: cl, store, metrics } = makeDeps();
    cleanup = cl;

    const result = await handleWaterEvent(
      { userId: "user-1", source: "keyboard", presetMl: 500, requestId: "req-1" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.volumeMl).toBe(500);
    expect(result.text).toBe("Записал 500 мл воды 💧");
    expect(store.insertWaterEvent).toHaveBeenCalledWith(
      "user-1",
      "keyboard",
      500,
      null,
    );
    expect(metrics.increment).toHaveBeenCalledWith(
      PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
      { modality: "water", source: "keyboard" },
    );
  });

  it("persists text-extracted volume", async () => {
    const { deps, cleanup: cl, store } = makeDeps();
    cleanup = cl;

    mockCallOmniRoute.mockResolvedValueOnce(
      successLLMResponse(250, 0.9)
    );

    const result = await handleWaterEvent(
      { userId: "user-1", source: "text", rawText: "выпил стакан воды", requestId: "req-2" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.volumeMl).toBe(250);
    expect(result.text).toBe("Записал 250 мл воды 💧");
    expect(store.insertWaterEvent).toHaveBeenCalledWith(
      "user-1",
      "text",
      250,
      "выпил стакан воды",
    );
  });

  it("persists voice-transcribed volume extraction", async () => {
    const { deps, cleanup: cl, store } = makeDeps();
    cleanup = cl;

    mockCallOmniRoute.mockResolvedValueOnce(
      successLLMResponse(750, 0.85)
    );

    const result = await handleWaterEvent(
      { userId: "user-1", source: "voice", rawText: "выпил три стакана", requestId: "req-3" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.volumeMl).toBe(750);
    expect(store.insertWaterEvent).toHaveBeenCalledWith(
      "user-1",
      "voice",
      750,
      "выпил три стакана",
    );
  });

  it("rejects out-of-range volume (too high)", async () => {
    const { deps, cleanup: cl, store } = makeDeps();
    cleanup = cl;

    const result = await handleWaterEvent(
      { userId: "user-1", source: "keyboard", presetMl: 6000, requestId: "req-4" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(OUT_OF_RANGE_REPLY);
    expect(result.keyboard).toEqual(buildWaterKeyboard());
    expect(store.insertWaterEvent).not.toHaveBeenCalled();
  });

  it("rejects out-of-range volume (zero)", async () => {
    const { deps, cleanup: cl, store } = makeDeps();
    cleanup = cl;

    const result = await handleWaterEvent(
      { userId: "user-1", source: "keyboard", presetMl: 0, requestId: "req-5" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(OUT_OF_RANGE_REPLY);
    expect(store.insertWaterEvent).not.toHaveBeenCalled();
  });

  it("rejects out-of-range volume from LLM", async () => {
    const { deps, cleanup: cl, store } = makeDeps();
    cleanup = cl;

    mockCallOmniRoute.mockResolvedValueOnce(
      successLLMResponse(9999, 0.95)
    );

    const result = await handleWaterEvent(
      { userId: "user-1", source: "text", rawText: "100 литров воды", requestId: "req-6" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(OUT_OF_RANGE_REPLY);
    expect(store.insertWaterEvent).not.toHaveBeenCalled();
  });

  it("returns OFF-state reply without persisting when water modality is off", async () => {
    const settingsService = {
      getSettings: vi.fn<() => Promise<ModalitySettings | null>>().mockResolvedValue({
        waterOn: false,
        sleepOn: true,
        workoutOn: true,
        moodOn: true,
      }),
    };
    const { deps, cleanup: cl, store } = makeDeps({ settingsService });
    cleanup = cl;

    const result = await handleWaterEvent(
      { userId: "user-1", source: "text", rawText: "стакан воды", requestId: "req-7" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(OFF_STATE_REPLY);
    expect(store.insertWaterEvent).not.toHaveBeenCalled();
  });

  it("returns low-confidence retry when LLM confidence is below threshold", async () => {
    const { deps, cleanup: cl, store } = makeDeps();
    cleanup = cl;

    mockCallOmniRoute.mockResolvedValueOnce(
      successLLMResponse(300, 0.3)
    );

    const result = await handleWaterEvent(
      { userId: "user-1", source: "text", rawText: "что-то непонятное", requestId: "req-8" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(LOW_CONFIDENCE_REPLY);
    expect(result.keyboard).toEqual(buildWaterKeyboard());
    expect(store.insertWaterEvent).not.toHaveBeenCalled();
  });

  it("emits telemetry counter with correct labels on successful persist", async () => {
    const { deps, cleanup: cl, metrics } = makeDeps();
    cleanup = cl;

    await handleWaterEvent(
      { userId: "user-1", source: "keyboard", presetMl: 250, requestId: "req-9" },
      deps,
    );

    expect(metrics.increment).toHaveBeenCalledWith(
      PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
      { modality: "water", source: "keyboard" },
    );
  });

  it("emits telemetry counter with voice source label", async () => {
    const { deps, cleanup: cl, metrics } = makeDeps();
    cleanup = cl;

    mockCallOmniRoute.mockResolvedValueOnce(
      successLLMResponse(500, 0.9)
    );

    await handleWaterEvent(
      { userId: "user-1", source: "voice", rawText: "пол-литра", requestId: "req-10" },
      deps,
    );

    expect(metrics.increment).toHaveBeenCalledWith(
      PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
      { modality: "water", source: "voice" },
    );
  });

  it("raw_text is NOT in any emitted structured log", async () => {
    const { deps, cleanup: cl, logger } = makeDeps();
    cleanup = cl;

    mockCallOmniRoute.mockResolvedValueOnce(
      successLLMResponse(250, 0.9)
    );

    await handleWaterEvent(
      { userId: "user-1", source: "text", rawText: "выпил стакан", requestId: "req-11" },
      deps,
    );

    const calls = (logger.info as any).mock.calls as [string, Record<string, unknown> | undefined][];
    for (const [, meta] of calls) {
      if (meta) {
        expect(meta).not.toHaveProperty("raw_text");
      }
    }
  });

  it("raw_text is NOT in any emitted metric label", async () => {
    const { deps, cleanup: cl, metrics } = makeDeps();
    cleanup = cl;

    mockCallOmniRoute.mockResolvedValueOnce(
      successLLMResponse(250, 0.9)
    );

    await handleWaterEvent(
      { userId: "user-1", source: "text", rawText: "выпил стакан", requestId: "req-12" },
      deps,
    );

    const calls = (metrics.increment as any).mock.calls as [string, Record<string, unknown> | undefined][];
    for (const [, labels] of calls) {
      if (labels) {
        expect(labels).not.toHaveProperty("raw_text");
      }
    }
  });

  it("handles all three preset values correctly", async () => {
    for (const ml of WATER_PRESETS) {
      const { deps, cleanup: cl, store } = makeDeps();
      cleanup = cl;

      const result = await handleWaterEvent(
        { userId: "user-1", source: "keyboard", presetMl: ml, requestId: `req-preset-${ml}` },
        deps,
      );

      expect(result.persisted).toBe(true);
      expect(result.volumeMl).toBe(ml);
      expect(store.insertWaterEvent).toHaveBeenCalledWith("user-1", "keyboard", ml, null);
      cl();
    }
  });

  it("returns low-confidence reply when no text and no preset", async () => {
    const { deps, cleanup: cl, store } = makeDeps();
    cleanup = cl;

    const result = await handleWaterEvent(
      { userId: "user-1", source: "text", requestId: "req-13" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(LOW_CONFIDENCE_REPLY);
    expect(store.insertWaterEvent).not.toHaveBeenCalled();
  });

  it("returns low-confidence reply when LLM extraction fully fails", async () => {
    const { deps, cleanup: cl, store } = makeDeps();
    cleanup = cl;

    mockCallOmniRoute
      .mockResolvedValueOnce(failureLLMResponse())
      .mockResolvedValueOnce(failureLLMResponse())
      .mockResolvedValueOnce(failureLLMResponse());

    const result = await handleWaterEvent(
      { userId: "user-1", source: "text", rawText: "абракадабра", requestId: "req-14" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(LOW_CONFIDENCE_REPLY);
    expect(store.insertWaterEvent).not.toHaveBeenCalled();
  });
});
