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
import type { ChatCompletionResult } from "../../../src/llm/llmClient.js";
import type { Resolved } from "../../../src/llm/registry.js";

// Mock llmClient
vi.mock("../../../src/llm/llmClient.js", () => ({
  chatCompletion: vi.fn(),
  vision: vi.fn(),
  isPromptOrResponseSafeForLogging: vi.fn().mockReturnValue(true),
}));

// Mock registry
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

const mockChatCompletion = vi.mocked(chatCompletion);
const mockVision = vi.mocked(vision);
const mockResolve = vi.mocked(resolve);

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
  call_type: "kbju.workout_extractor",
  systemPromptTemplate: "Extract workout from message. Schema: {{JSON_SCHEMA}}. Respond with ONLY JSON.",
  outputJsonSchema: '{"workout_type":"string","duration_min":"integer|null","distance_km":"number|null","sets":"integer|null","repetitions":"integer|null","confidence":"number"}',
  confidenceThreshold: 0.5,
};

const MOCK_RESOLVED: Resolved = {
  provider_id: "fireworks",
  base_url: "https://api.fireworks.ai/inference/v1",
  api_key_env: "LLM_FIREWORKS_API_KEY",
  model: "accounts/fireworks/models/qwen3-vl-30b-a3b",
};

const MOCK_RESOLVED_WITH_FALLBACK: Resolved = {
  ...MOCK_RESOLVED,
  fallback: {
    provider_id: "fireworks",
    base_url: "https://api.fireworks.ai/inference/v1",
    api_key_env: "LLM_FIREWORKS_API_KEY",
    model: "accounts/fireworks/models/executor",
  },
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

function successResult(rawText: string): ChatCompletionResult {
  return {
    provider_id: "fireworks",
    model: "accounts/fireworks/models/qwen3-vl-30b-a3b",
    rawResponseText: rawText,
    inputUnits: 200,
    outputUnits: 50,
    estimatedCostUsd: 0.002,
    outcome: "success",
  };
}

function failureResult(): ChatCompletionResult {
  return {
    provider_id: "fireworks",
    model: "accounts/fireworks/models/qwen3-vl-30b-a3b",
    rawResponseText: "",
    inputUnits: 0,
    outputUnits: 0,
    estimatedCostUsd: 0,
    outcome: "provider_failure",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

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
    mockResolve.mockReturnValue(MOCK_RESOLVED_WITH_FALLBACK);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("returns workout from default model on success", async () => {
    const config = loader.getConfig()!;
    mockChatCompletion.mockResolvedValueOnce(
      successResult('{"workout_type":"running","duration_min":30,"distance_km":5,"sets":null,"repetitions":null,"confidence":0.9}')
    );

    const result = await extractWorkoutFromText(
      "бежал 5 км 30 минут",
      config,
      "req-1",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
      false,
    );

    expect(result.workoutType).toBe("running");
    expect(result.confidence).toBe(0.9);
    expect(result.modelTier).toBe("default");
  });

  it("falls back to fallback model when default fails", async () => {
    const config = loader.getConfig()!;
    mockChatCompletion
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(
        successResult('{"workout_type":"strength","duration_min":null,"distance_km":null,"sets":5,"repetitions":10,"confidence":0.8}')
      );

    const result = await extractWorkoutFromText(
      "5×10 жим",
      config,
      "req-2",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
      false,
    );

    expect(result.workoutType).toBe("strength");
    expect(result.modelTier).toBe("fallback");
  });

  it("returns failure when both tiers fail", async () => {
    const config = loader.getConfig()!;
    mockChatCompletion
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(failureResult());

    const result = await extractWorkoutFromText(
      "тренировка",
      config,
      "req-3",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
      false,
    );

    expect(result.workoutType).toBeNull();
    expect(result.modelTier).toBe("failure");
  });
});

describe("extractWorkoutFromPhoto", () => {
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
    mockResolve.mockReturnValue(MOCK_RESOLVED_WITH_FALLBACK);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("returns workout from vision model on success", async () => {
    const config = loader.getConfig()!;
    mockVision.mockResolvedValueOnce(
      successResult('{"workout_type":"cycling","duration_min":45,"distance_km":20,"sets":null,"repetitions":null,"confidence":0.85}')
    );

    const result = await extractWorkoutFromPhoto(
      "base64image",
      config,
      "req-4",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.workoutType).toBe("cycling");
    expect(result.modelTier).toBe("default");
  });

  it("resolves call_type via registry", async () => {
    const config = loader.getConfig()!;
    mockVision.mockResolvedValueOnce(
      successResult('{"workout_type":"yoga","duration_min":60,"distance_km":null,"sets":null,"repetitions":null,"confidence":0.75}')
    );

    await extractWorkoutFromPhoto(
      "base64image",
      config,
      "req-5",
      "user-1",
      logger,
      metrics,
      spendTracker as any,
    );

    expect(mockResolve).toHaveBeenCalledWith("kbju.workout_extractor");
  });
});
