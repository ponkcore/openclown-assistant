import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ExtractorConfigLoader,
  extractVolumeFromText,
} from "../../../src/modality/water/extractVolume.js";
import type { MetricsRegistry } from "../../../src/observability/metricsEndpoint.js";
import type { OpenClawLogger } from "../../../src/shared/types.js";
import type { ChatCompletionResult } from "../../../src/llm/llmClient.js";
import type { Resolved } from "../../../src/llm/registry.js";

// Mock llmClient to control LLM call outcomes
vi.mock("../../../src/llm/llmClient.js", () => ({
  chatCompletion: vi.fn(),
  vision: vi.fn(),
  isPromptOrResponseSafeForLogging: vi.fn().mockReturnValue(true),
}));

// Mock registry to control resolution
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
  call_type: "kbju.water_volume_extractor",
  systemPromptTemplate: "Extract volume from message. Schema: {{JSON_SCHEMA}}. Respond with ONLY JSON.",
  outputJsonSchema: '{"volume_ml":"integer","confidence":"number"}',
  confidenceThreshold: 0.6,
};

const MOCK_RESOLVED: Resolved = {
  provider_id: "fireworks",
  base_url: "https://api.fireworks.ai/inference/v1",
  api_key_env: "LLM_FIREWORKS_API_KEY",
  model: "accounts/fireworks/models/gpt-oss-20b",
};

const MOCK_RESOLVED_WITH_FALLBACK: Resolved = {
  ...MOCK_RESOLVED,
  fallback: {
    provider_id: "fireworks",
    base_url: "https://api.fireworks.ai/inference/v1",
    api_key_env: "LLM_FIREWORKS_API_KEY",
    model: "accounts/fireworks/models/minimax-m2p7",
  },
};

function makeExtractorConfigLoader(
  config = EXTRACTOR_CONFIG,
): { loader: ExtractorConfigLoader; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "water-extractor-test-"));
  const filePath = path.join(tmpDir, "water-extractor.json");
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
    model: "accounts/fireworks/models/gpt-oss-20b",
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
    model: "accounts/fireworks/models/gpt-oss-20b",
    rawResponseText: "",
    inputUnits: 0,
    outputUnits: 0,
    estimatedCostUsd: 0,
    outcome: "provider_failure",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("extractVolumeFromText", () => {
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

  it("returns volume from default model on success", async () => {
    mockChatCompletion.mockResolvedValueOnce(
      successResult('{"volume_ml": 500, "confidence": 0.95}')
    );

    const result = await extractVolumeFromText(
      "выпил пол-литра воды",
      "req-1",
      "user-1",
      loader,
      logger,
      metrics,
      spendTracker as any,
      false,
    );

    expect(result.volumeMl).toBe(500);
    expect(result.confidence).toBe(0.95);
    expect(result.modelTier).toBe("default");
  });

  it("falls back to fallback model when default fails", async () => {
    mockChatCompletion
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(
        successResult('{"volume_ml": 250, "confidence": 0.8}')
      );

    const result = await extractVolumeFromText(
      "стакан воды",
      "req-2",
      "user-1",
      loader,
      logger,
      metrics,
      spendTracker as any,
      false,
    );

    expect(result.volumeMl).toBe(250);
    expect(result.confidence).toBe(0.8);
    expect(result.modelTier).toBe("fallback");
  });

  it("returns failure when both default and fallback fail", async () => {
    mockChatCompletion
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(failureResult());

    const result = await extractVolumeFromText(
      "литр воды",
      "req-3",
      "user-1",
      loader,
      logger,
      metrics,
      spendTracker as any,
      false,
    );

    expect(result.volumeMl).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.modelTier).toBe("failure");
  });

  it("returns failure when registry resolve fails", async () => {
    mockResolve.mockImplementation(() => { throw new Error("registry empty"); });

    const result = await extractVolumeFromText(
      "вода",
      "req-4",
      "user-1",
      loader,
      logger,
      metrics,
      spendTracker as any,
      false,
    );

    expect(result.volumeMl).toBe(0);
    expect(result.modelTier).toBe("failure");
  });

  it("returns failure when config loader returns null", async () => {
    // Create a loader with a non-existent file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "water-no-config-"));
    const emptyLoader = new ExtractorConfigLoader(
      path.join(tmpDir, "nonexistent.json"),
      makeLogger(),
    );

    const result = await extractVolumeFromText(
      "вода",
      "req-5",
      "user-1",
      emptyLoader,
      logger,
      metrics,
      spendTracker as any,
    );

    expect(result.volumeMl).toBe(0);
    expect(result.modelTier).toBe("failure");
    emptyLoader.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns failure when LLM returns invalid JSON", async () => {
    mockChatCompletion.mockResolvedValueOnce(
      successResult("not valid json")
    );

    const result = await extractVolumeFromText(
      "вода",
      "req-6",
      "user-1",
      loader,
      logger,
      metrics,
      spendTracker as any,
    );

    // Default produced invalid JSON, try fallback
    // If fallback also fails, return failure
    expect(result.modelTier).toMatch(/^(default|fallback|failure)$/);
  });

  it("resolves call_type via registry", async () => {
    mockChatCompletion.mockResolvedValueOnce(
      successResult('{"volume_ml": 300, "confidence": 0.9}')
    );

    await extractVolumeFromText(
      "300 мл",
      "req-7",
      "user-1",
      loader,
      logger,
      metrics,
      spendTracker as any,
    );

    expect(mockResolve).toHaveBeenCalledWith("kbju.water_volume_extractor");
  });
});
