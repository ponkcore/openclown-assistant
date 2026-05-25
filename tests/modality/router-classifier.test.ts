import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ClassifierConfigLoader,
  classifyViaLLM,
} from "../../src/modality/router-classifier.js";
import type { MetricsRegistry } from "../../src/observability/metricsEndpoint.js";
import type { OpenClawLogger } from "../../src/shared/types.js";
import type { ChatCompletionResult } from "../../src/llm/llmClient.js";
import type { Resolved } from "../../src/llm/registry.js";

// Mock llmClient
vi.mock("../../src/llm/llmClient.js", () => ({
  chatCompletion: vi.fn(),
  vision: vi.fn(),
  isPromptOrResponseSafeForLogging: vi.fn().mockReturnValue(true),
}));

// Mock registry
vi.mock("../../src/llm/registry.js", () => ({
  resolve: vi.fn(),
  getApiKey: vi.fn().mockReturnValue("test-api-key"),
  initRegistry: vi.fn(),
  closeRegistry: vi.fn(),
  reload: vi.fn(),
  _resetLegacyWarned: vi.fn(),
  adaptMetricsSink: vi.fn(),
  RegistryError: class RegistryError extends Error { code = ""; },
}));

import { chatCompletion } from "../../src/llm/llmClient.js";
import { resolve } from "../../src/llm/registry.js";

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

const CLASSIFIER_CONFIG = {
  call_type: "kbju.modality_router_classifier",
  systemPromptTemplate: "You are a modality classifier. Candidates: {{CANDIDATE_SET}}. Schema: {{JSON_SCHEMA}}. Respond with ONLY JSON.",
  outputJsonSchema: '{"label":"string","confidence":"number"}',
  confidenceThreshold: 0.6,
};

const MOCK_RESOLVED: Resolved = {
  provider_id: "fireworks",
  base_url: "https://api.fireworks.ai/inference/v1",
  api_key_env: "LLM_FIREWORKS_API_KEY",
  model: "accounts/fireworks/models/gpt-oss-20b",
  fallback: {
    provider_id: "fireworks",
    base_url: "https://api.fireworks.ai/inference/v1",
    api_key_env: "LLM_FIREWORKS_API_KEY",
    model: "accounts/fireworks/models/qwen3-vl-30b-a3b",
  },
};

function makeClassifierConfigLoader(
  config = CLASSIFIER_CONFIG,
  threshold?: number
): { loader: ClassifierConfigLoader; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "classifier-test-"));
  const filePath = path.join(tmpDir, "modality-router-classifier.json");
  const cfg = threshold ? { ...config, confidenceThreshold: threshold } : config;
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(cfg), "utf-8");
  fs.renameSync(tmpPath, filePath);
  const logger = makeLogger();
  const loader = new ClassifierConfigLoader(filePath, logger);
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
    model: "accounts/fireworks/models/gpt-oss-20b",
    rawResponseText: rawText,
    inputUnits: 50,
    outputUnits: 10,
    estimatedCostUsd: 0.0005,
    outcome: "success",
  };
}

function failureResult(): ChatCompletionResult {
  return {
    provider_id: "fireworks",
    model: "accounts/fireworks/models/gpt-oss-20b",
    rawResponseText: "",
    inputUnits: 0,
    outputUnits: 0,
    estimatedCostUsd: 0,
    outcome: "provider_failure",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("classifyViaLLM", () => {
  let loader: ClassifierConfigLoader;
  let cleanup: () => void;
  let metrics: MetricsRegistry;
  let logger: OpenClawLogger;
  let spendTracker: ReturnType<typeof makeSpendTracker>;

  const candidateSet = ["WATER", "WORKOUT", "AMBIGUOUS"] as const;

  beforeEach(() => {
    const result = makeClassifierConfigLoader();
    loader = result.loader;
    cleanup = result.cleanup;
    metrics = makeMetrics();
    logger = makeLogger();
    spendTracker = makeSpendTracker();
    mockResolve.mockReturnValue(MOCK_RESOLVED);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("returns classification from default model on success", async () => {
    mockChatCompletion.mockResolvedValueOnce(
      successResult('{"label": "WATER", "confidence": 0.9}')
    );

    const result = await classifyViaLLM(
      "выпил стакан воды",
      candidateSet,
      "req-1",
      "user-1",
      loader,
      logger,
      metrics,
    );

    expect(result.modality).toBe("WATER");
    expect(result.confidence).toBe(0.9);
    expect(result.modelTier).toBe("default");
  });

  it("falls back to fallback model when default fails", async () => {
    mockChatCompletion
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(
        successResult('{"label": "WORKOUT", "confidence": 0.8}')
      );

    const result = await classifyViaLLM(
      "бежал 5 км",
      candidateSet,
      "req-2",
      "user-1",
      loader,
      logger,
      metrics,
    );

    expect(result.modality).toBe("WORKOUT");
    expect(result.modelTier).toBe("fallback");
  });

  it("returns AMBIGUOUS failure when both tiers fail", async () => {
    mockChatCompletion
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(failureResult());

    const result = await classifyViaLLM(
      "не понятно",
      candidateSet,
      "req-3",
      "user-1",
      loader,
      logger,
      metrics,
    );

    expect(result.modality).toBe("AMBIGUOUS");
    expect(result.modelTier).toBe("failure");
  });

  it("resolves call_type via registry", async () => {
    mockChatCompletion.mockResolvedValueOnce(
      successResult('{"label": "WATER", "confidence": 0.85}')
    );

    await classifyViaLLM(
      "вода",
      candidateSet,
      "req-4",
      "user-1",
      loader,
      logger,
      metrics,
    );

    expect(mockResolve).toHaveBeenCalledWith("kbju.modality_router_classifier");
  });
});
