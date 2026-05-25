import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  MoodExtractorConfigLoader,
  extractMoodFromText,
} from "../../../src/modality/mood/extractScore.js";
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

import { chatCompletion } from "../../../src/llm/llmClient.js";
import { resolve } from "../../../src/llm/registry.js";

const mockChatCompletion = vi.mocked(chatCompletion);
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
  call_type: "kbju.mood_inferrer",
  systemPromptTemplate: "Extract mood score from message. Schema: {{JSON_SCHEMA}}. Respond with ONLY JSON.",
  outputJsonSchema: '{"score":"integer","confidence":"number","inferred_comment":"string?"}',
  confidenceThreshold: 0.6,
};

const MOCK_RESOLVED: Resolved = {
  provider_id: "fireworks",
  base_url: "https://api.fireworks.ai/inference/v1",
  api_key_env: "LLM_FIREWORKS_API_KEY",
  model: "accounts/fireworks/models/executor",
};

const MOCK_RESOLVED_WITH_FALLBACK: Resolved = {
  ...MOCK_RESOLVED,
  fallback: {
    provider_id: "fireworks",
    base_url: "https://api.fireworks.ai/inference/v1",
    api_key_env: "LLM_FIREWORKS_API_KEY",
    model: "accounts/fireworks/models/reviewer",
  },
};

function makeExtractorConfigLoader(
  config = EXTRACTOR_CONFIG,
): { loader: MoodExtractorConfigLoader; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mood-extractor-test-"));
  const filePath = path.join(tmpDir, "mood-extractor.json");
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(config), "utf-8");
  fs.renameSync(tmpPath, filePath);
  const logger = makeLogger();
  const loader = new MoodExtractorConfigLoader(filePath, logger);
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
    model: "accounts/fireworks/models/executor",
    rawResponseText: rawText,
    inputUnits: 100,
    outputUnits: 20,
    estimatedCostUsd: 0.001,
    outcome: "success",
  };
}

function failureResult(): ChatCompletionResult {
  return {
    provider_id: "fireworks",
    model: "accounts/fireworks/models/executor",
    rawResponseText: "",
    inputUnits: 0,
    outputUnits: 0,
    estimatedCostUsd: 0,
    outcome: "provider_failure",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("extractMoodFromText", () => {
  let loader: MoodExtractorConfigLoader;
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

  it("returns mood score from default model on success", async () => {
    mockChatCompletion.mockResolvedValueOnce(
      successResult('{"score": 8, "confidence": 0.95}')
    );

    const result = await extractMoodFromText(
      "отличное настроение",
      "req-1",
      "user-1",
      loader,
      logger,
      metrics,
      spendTracker as any,
      false,
    );

    expect(result.score).toBe(8);
    expect(result.confidence).toBe(0.95);
    expect(result.modelTier).toBe("default");
  });

  it("falls back to fallback model when default fails", async () => {
    mockChatCompletion
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(
        successResult('{"score": 5, "confidence": 0.7}')
      );

    const result = await extractMoodFromText(
      "нормально",
      "req-2",
      "user-1",
      loader,
      logger,
      metrics,
      spendTracker as any,
      false,
    );

    expect(result.score).toBe(5);
    expect(result.modelTier).toBe("fallback");
  });

  it("returns failure when both tiers fail", async () => {
    mockChatCompletion
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(failureResult());

    const result = await extractMoodFromText(
      "хз",
      "req-3",
      "user-1",
      loader,
      logger,
      metrics,
      spendTracker as any,
      false,
    );

    expect(result.score).toBe(0);
    expect(result.modelTier).toBe("failure");
  });

  it("resolves call_type via registry", async () => {
    mockChatCompletion.mockResolvedValueOnce(
      successResult('{"score": 7, "confidence": 0.8}')
    );

    await extractMoodFromText(
      "хорошо",
      "req-4",
      "user-1",
      loader,
      logger,
      metrics,
      spendTracker as any,
    );

    expect(mockResolve).toHaveBeenCalledWith("kbju.mood_inferrer");
  });
});
