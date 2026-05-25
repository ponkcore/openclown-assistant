import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ExtractorConfigLoader,
  extractWorkoutFromText,
  extractWorkoutFromPhoto,
} from "../../../src/modality/workout/extractWorkout.js";
import type { MetricsRegistry } from "../../../src/observability/metricsEndpoint.js";
import type { OpenClawLogger } from "../../../src/shared/types.js";

// Mock callOmniRoute to control LLM call outcomes
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

const EXTRACTOR_CONFIG = {
  systemPromptTemplate: "Extract workout from message. Schema: {{JSON_SCHEMA}}. Respond with ONLY JSON.",
  outputJsonSchema: '{"workout_type":"string","duration_min":"integer|null","distance_km":"number|null","sets":"integer|null","repetitions":"integer|null","confidence":"number"}',
  confidenceThreshold: 0.5,
  defaultModel: { modelAlias: "accounts/fireworks/models/qwen3-vl-30b-a3b", providerHint: "fireworks" },
  fallbackModel: { modelAlias: "accounts/fireworks/models/executor", providerHint: "fireworks" },
  emergencyModel: { modelAlias: "openrouter/nvidia/nemotron-3-super:free", providerHint: "openrouter" },
};

function makeExtractorConfigLoader(
  config = EXTRACTOR_CONFIG,
): { loader: ExtractorConfigLoader; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workout-extractor-test-"));
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

function successfulOmniResult(json: string): import("../../../src/llm/omniRouteClient.js").OmniRouteCallResult {
  return {
    providerAlias: "fireworks",
    modelAlias: "accounts/fireworks/models/qwen3-vl-30b-a3b",
    rawResponseText: json,
    inputUnits: 50,
    outputUnits: 30,
    estimatedCostUsd: 0.0001,
    outcome: "success",
  };
}

function failedOmniResult(): import("../../../src/llm/omniRouteClient.js").OmniRouteCallResult {
  return {
    providerAlias: "fireworks",
    modelAlias: "accounts/fireworks/models/qwen3-vl-30b-a3b",
    rawResponseText: "",
    inputUnits: 0,
    outputUnits: 0,
    estimatedCostUsd: 0,
    outcome: "provider_failure",
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("extractWorkoutFromText", () => {
  let loader: ExtractorConfigLoader;
  let cleanup: () => void;
  let metrics: MetricsRegistry;
  let logger: OpenClawLogger;
  let spendTracker: ReturnType<typeof makeSpendTracker>;

  beforeEach(() => {
    const result = makeExtractorConfigLoader();
    loader = result.loader;
    cleanup = result.cleanup;
    metrics = makeMetrics();
    logger = makeLogger();
    spendTracker = makeSpendTracker();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("extracts running with duration and distance from text", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: 32, distance_km: 5, sets: null, repetitions: null, confidence: 0.9 }),
    ));

    const result = await extractWorkoutFromText(
      "пробежал 5 км за 32 минуты",
      EXTRACTOR_CONFIG,
      "req-1",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBe("running");
    expect(result.durationMin).toBe(32);
    expect(result.distanceKm).toBe(5);
    expect(result.confidence).toBe(0.9);
    expect(result.modelTier).toBe("default");
  });

  it("extracts strength with sets and reps from text", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "strength", duration_min: 45, distance_km: null, sets: 4, repetitions: 12, confidence: 0.85 }),
    ));

    const result = await extractWorkoutFromText(
      "делал жим лёжа 4 подхода по 12 повторений",
      EXTRACTOR_CONFIG,
      "req-2",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBe("strength");
    expect(result.sets).toBe(4);
    expect(result.reps).toBe(12);
  });

  it("falls back to fallback model on default failure", async () => {
    mockCallOmniRoute.mockRejectedValueOnce(new Error("timeout"));
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "yoga", duration_min: 60, distance_km: null, sets: null, repetitions: null, confidence: 0.8 }),
    ));

    const result = await extractWorkoutFromText(
      "йога 60 минут",
      EXTRACTOR_CONFIG,
      "req-3",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBe("yoga");
    expect(result.modelTier).toBe("fallback");
    expect(mockCallOmniRoute).toHaveBeenCalledTimes(2);
  });

  it("falls back to emergency on default + fallback failure", async () => {
    mockCallOmniRoute.mockRejectedValueOnce(new Error("timeout"));
    mockCallOmniRoute.mockResolvedValueOnce(failedOmniResult());
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "swimming", duration_min: 30, distance_km: null, sets: null, repetitions: null, confidence: 0.7 }),
    ));

    const result = await extractWorkoutFromText(
      "плавание 30 минут",
      EXTRACTOR_CONFIG,
      "req-4",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBe("swimming");
    expect(result.modelTier).toBe("emergency");
    expect(mockCallOmniRoute).toHaveBeenCalledTimes(3);
  });

  it("returns failure tier when all three models fail", async () => {
    mockCallOmniRoute.mockRejectedValue(new Error("all down"));

    const result = await extractWorkoutFromText(
      "тренировка",
      EXTRACTOR_CONFIG,
      "req-5",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBeNull();
    expect(result.modelTier).toBe("failure");
  });

  it("rejects out-of-enum workout_type and falls back", async () => {
    // Default returns invalid type
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "jogging", duration_min: 20, distance_km: null, sets: null, repetitions: null, confidence: 0.8 }),
    ));
    // Fallback returns valid type
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: 20, distance_km: null, sets: null, repetitions: null, confidence: 0.8 }),
    ));

    const result = await extractWorkoutFromText(
      "пробежка 20 минут",
      EXTRACTOR_CONFIG,
      "req-6",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBe("running");
    expect(result.modelTier).toBe("fallback");
  });

  it("rejects strict-keys violation and falls back", async () => {
    // Default returns extra key
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: 20, distance_km: null, sets: null, repetitions: null, confidence: 0.8, extra_key: "bad" }),
    ));
    // Fallback returns valid
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: 20, distance_km: null, sets: null, repetitions: null, confidence: 0.8 }),
    ));

    const result = await extractWorkoutFromText(
      "бег 20 мин",
      EXTRACTOR_CONFIG,
      "req-7",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBe("running");
    expect(result.modelTier).toBe("fallback");
  });

  it("rejects negative numeric field and falls back", async () => {
    // Default returns negative duration
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: -5, distance_km: null, sets: null, repetitions: null, confidence: 0.8 }),
    ));
    // Fallback returns valid
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: 5, distance_km: null, sets: null, repetitions: null, confidence: 0.8 }),
    ));

    const result = await extractWorkoutFromText(
      "бег 5 мин",
      EXTRACTOR_CONFIG,
      "req-8",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBe("running");
    expect(result.durationMin).toBe(5);
  });

  it("rejects non-JSON output and falls back", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult("This is not JSON"));
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "walking", duration_min: 30, distance_km: null, sets: null, repetitions: null, confidence: 0.7 }),
    ));

    const result = await extractWorkoutFromText(
      "ходьба 30 минут",
      EXTRACTOR_CONFIG,
      "req-9",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBe("walking");
    expect(result.modelTier).toBe("fallback");
  });
});

describe("extractWorkoutFromPhoto", () => {
  let metrics: MetricsRegistry;
  let logger: OpenClawLogger;
  let spendTracker: ReturnType<typeof makeSpendTracker>;

  beforeEach(() => {
    metrics = makeMetrics();
    logger = makeLogger();
    spendTracker = makeSpendTracker();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts workout type from photo via vision LLM", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "running", duration_min: 25, distance_km: 3.5, sets: null, repetitions: null, confidence: 0.75 }),
    ));

    const result = await extractWorkoutFromPhoto(
      "fake-base64-image-data",
      EXTRACTOR_CONFIG,
      "req-photo-1",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBe("running");
    expect(result.distanceKm).toBe(3.5);
    expect(result.modelTier).toBe("default");
  });

  it("falls back on vision model failure", async () => {
    mockCallOmniRoute.mockRejectedValueOnce(new Error("vision model error"));
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "cycling", duration_min: 45, distance_km: 15, sets: null, repetitions: null, confidence: 0.65 }),
    ));

    const result = await extractWorkoutFromPhoto(
      "fake-base64-image-data",
      EXTRACTOR_CONFIG,
      "req-photo-2",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBe("cycling");
    expect(result.modelTier).toBe("fallback");
  });

  it("returns failure when all models fail for photo", async () => {
    mockCallOmniRoute.mockRejectedValue(new Error("all down"));

    const result = await extractWorkoutFromPhoto(
      "fake-base64-image-data",
      EXTRACTOR_CONFIG,
      "req-photo-3",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBeNull();
    expect(result.modelTier).toBe("failure");
  });

  it("uses vision_llm call type for photo extraction", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(successfulOmniResult(
      JSON.stringify({ workout_type: "strength", duration_min: null, distance_km: null, sets: 3, repetitions: 10, confidence: 0.8 }),
    ));

    await extractWorkoutFromPhoto(
      "fake-base64-image-data",
      EXTRACTOR_CONFIG,
      "req-photo-4",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(mockCallOmniRoute).toHaveBeenCalledOnce();
    const callArgs = mockCallOmniRoute.mock.calls[0];
    // callArgs[1] is the options object
    expect(callArgs[1].callType).toBe("vision_llm");
  });
});
