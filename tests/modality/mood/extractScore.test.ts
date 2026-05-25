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
  systemPromptTemplate: "Extract mood score from message. Schema: {{JSON_SCHEMA}}. Respond with ONLY JSON.",
  outputJsonSchema: '{"score":"integer","confidence":"number","inferred_comment":"string?"}',
  confidenceThreshold: 0.6,
  defaultModel: { modelAlias: "accounts/fireworks/models/executor", providerHint: "fireworks" },
  fallbackModel: { modelAlias: "accounts/fireworks/models/reviewer", providerHint: "fireworks" },
  emergencyModel: { modelAlias: "openrouter/nvidia/nemotron-3-super:free", providerHint: "openrouter" },
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

function successLLMResponse(score: number, confidence: number, inferredComment?: string) {
  const output: Record<string, unknown> = { score, confidence };
  if (inferredComment !== undefined) {
    output.inferred_comment = inferredComment;
  }
  return {
    providerAlias: "fireworks" as const,
    modelAlias: "accounts/fireworks/models/executor",
    rawResponseText: JSON.stringify(output),
    inputUnits: 10,
    outputUnits: 5,
    estimatedCostUsd: 0.0001,
    outcome: "success" as const,
  };
}

function failureLLMResponse() {
  return {
    providerAlias: "fireworks" as const,
    modelAlias: "accounts/fireworks/models/executor",
    rawResponseText: "",
    inputUnits: 0,
    outputUnits: 0,
    estimatedCostUsd: 0,
    outcome: "provider_failure" as const,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("extractMoodFromText", () => {
  let loader: MoodExtractorConfigLoader;
  let cleanup: () => void;
  let metrics: MetricsRegistry;
  let logger: OpenClawLogger;

  beforeEach(() => {
    const result = makeExtractorConfigLoader();
    loader = result.loader;
    cleanup = result.cleanup;
    metrics = makeMetrics();
    logger = makeLogger();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("returns score from default model on success", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(successLLMResponse(7, 0.9, "устал но в целом норм"));

    const result = await extractMoodFromText(
      "сегодня устал, всё бесит",
      "req-001",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(result.score).toBe(7);
    expect(result.confidence).toBe(0.9);
    expect(result.inferredComment).toBe("устал но в целом норм");
    expect(result.modelTier).toBe("default");
  });

  it("falls back to fallback model when default fails", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce(failureLLMResponse())
      .mockResolvedValueOnce({
        providerAlias: "fireworks" as const,
        modelAlias: "accounts/fireworks/models/reviewer",
        rawResponseText: JSON.stringify({ score: 4, confidence: 0.75 }),
        inputUnits: 10,
        outputUnits: 5,
        estimatedCostUsd: 0.0002,
        outcome: "success" as const,
      });

    const result = await extractMoodFromText(
      "плохое настроение",
      "req-002",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(result.score).toBe(4);
    expect(result.confidence).toBe(0.75);
    expect(result.modelTier).toBe("fallback");
  });

  it("falls back to emergency model when default and fallback fail", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce(failureLLMResponse())
      .mockResolvedValueOnce(failureLLMResponse())
      .mockResolvedValueOnce({
        providerAlias: "omniroute" as const,
        modelAlias: "openrouter/nvidia/nemotron-3-super:free",
        rawResponseText: JSON.stringify({ score: 5, confidence: 0.65 }),
        inputUnits: 10,
        outputUnits: 5,
        estimatedCostUsd: 0,
        outcome: "success" as const,
      });

    const result = await extractMoodFromText(
      "средняк",
      "req-003",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(result.score).toBe(5);
    expect(result.modelTier).toBe("emergency");
  });

  it("returns failure tier when all models fail", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce(failureLLMResponse())
      .mockResolvedValueOnce(failureLLMResponse())
      .mockResolvedValueOnce(failureLLMResponse());

    const result = await extractMoodFromText(
      "непонятный текст",
      "req-004",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.modelTier).toBe("failure");
  });

  it("rejects LLM output with extra keys (strict-keys validation)", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce({
        providerAlias: "fireworks" as const,
        modelAlias: "accounts/fireworks/models/executor",
        rawResponseText: JSON.stringify({ score: 7, confidence: 0.9, extra_field: "bad" }),
        inputUnits: 10,
        outputUnits: 5,
        estimatedCostUsd: 0.0001,
        outcome: "success" as const,
      })
      .mockResolvedValueOnce(successLLMResponse(6, 0.8));

    const result = await extractMoodFromText(
      "текст",
      "req-005",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    // Should fall back to fallback model since default had extra keys
    expect(result.score).toBe(6);
    expect(result.modelTier).toBe("fallback");
  });

  it("rejects out-of-range score from LLM output", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce({
        providerAlias: "fireworks" as const,
        modelAlias: "accounts/fireworks/models/executor",
        rawResponseText: JSON.stringify({ score: 0, confidence: 0.9 }),
        inputUnits: 10,
        outputUnits: 5,
        estimatedCostUsd: 0.0001,
        outcome: "success" as const,
      })
      .mockResolvedValueOnce({
        providerAlias: "fireworks" as const,
        modelAlias: "accounts/fireworks/models/reviewer",
        rawResponseText: JSON.stringify({ score: 11, confidence: 0.8 }),
        inputUnits: 10,
        outputUnits: 5,
        estimatedCostUsd: 0.0002,
        outcome: "success" as const,
      })
      .mockResolvedValueOnce(successLLMResponse(5, 0.7));

    const result = await extractMoodFromText(
      "текст",
      "req-006",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    // Both default and fallback had out-of-range scores, emergency succeeds
    expect(result.score).toBe(5);
    expect(result.modelTier).toBe("emergency");
  });

  it("rejects non-integer score from LLM output", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce({
        providerAlias: "fireworks" as const,
        modelAlias: "accounts/fireworks/models/executor",
        rawResponseText: JSON.stringify({ score: 7.5, confidence: 0.9 }),
        inputUnits: 10,
        outputUnits: 5,
        estimatedCostUsd: 0.0001,
        outcome: "success" as const,
      })
      .mockResolvedValueOnce(successLLMResponse(7, 0.85));

    const result = await extractMoodFromText(
      "текст",
      "req-007",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(result.score).toBe(7);
    expect(result.modelTier).toBe("fallback");
  });

  it("rejects invalid confidence from LLM output", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce({
        providerAlias: "fireworks" as const,
        modelAlias: "accounts/fireworks/models/executor",
        rawResponseText: JSON.stringify({ score: 7, confidence: 1.5 }),
        inputUnits: 10,
        outputUnits: 5,
        estimatedCostUsd: 0.0001,
        outcome: "success" as const,
      })
      .mockResolvedValueOnce(successLLMResponse(7, 0.8));

    const result = await extractMoodFromText(
      "текст",
      "req-008",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(result.modelTier).toBe("fallback");
  });

  it("returns failure when config is missing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mood-extractor-nocfg-"));
    const filePath = path.join(tmpDir, "nonexistent.json");
    const nullLoader = new MoodExtractorConfigLoader(filePath, logger);

    const result = await extractMoodFromText(
      "текст",
      "req-009",
      "user-001",
      nullLoader,
      logger,
      metrics,
    );

    expect(result.score).toBe(0);
    expect(result.modelTier).toBe("failure");

    nullLoader.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects non-string inferred_comment from LLM output", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce({
        providerAlias: "fireworks" as const,
        modelAlias: "accounts/fireworks/models/executor",
        rawResponseText: JSON.stringify({ score: 7, confidence: 0.9, inferred_comment: 123 }),
        inputUnits: 10,
        outputUnits: 5,
        estimatedCostUsd: 0.0001,
        outcome: "success" as const,
      })
      .mockResolvedValueOnce(successLLMResponse(7, 0.85));

    const result = await extractMoodFromText(
      "текст",
      "req-010",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(result.modelTier).toBe("fallback");
  });

  it("truncates inferred_comment to 200 chars", async () => {
    const longComment = "а".repeat(250);
    mockCallOmniRoute.mockResolvedValueOnce(
      successLLMResponse(5, 0.8, longComment)
    );

    const result = await extractMoodFromText(
      "длинный текст",
      "req-011",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(result.inferredComment).toHaveLength(200);
  });

  it("handles confidence threshold edge case — exactly 0.6", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(
      successLLMResponse(6, 0.6)
    );

    const result = await extractMoodFromText(
      "текст",
      "req-012",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    // 0.6 >= 0.6 threshold → should succeed
    expect(result.score).toBe(6);
    expect(result.modelTier).toBe("default");
  });

  it("handles confidence threshold edge case — just below 0.6", async () => {
    // Note: the extractor always returns the result; it's the logger
    // that checks confidence. But we still test that the extractor
    // returns the confidence correctly.
    mockCallOmniRoute.mockResolvedValueOnce(
      successLLMResponse(6, 0.59)
    );

    const result = await extractMoodFromText(
      "текст",
      "req-013",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(result.score).toBe(6);
    expect(result.confidence).toBe(0.59);
    // The logger will decide whether confidence is high enough
  });

  it("rejects malformed JSON from LLM", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce({
        providerAlias: "fireworks" as const,
        modelAlias: "accounts/fireworks/models/executor",
        rawResponseText: "not json at all",
        inputUnits: 10,
        outputUnits: 5,
        estimatedCostUsd: 0.0001,
        outcome: "success" as const,
      })
      .mockResolvedValueOnce(successLLMResponse(5, 0.7));

    const result = await extractMoodFromText(
      "текст",
      "req-014",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(result.modelTier).toBe("fallback");
  });

  it("emits correct metrics on success", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(successLLMResponse(7, 0.9));

    await extractMoodFromText(
      "текст",
      "req-015",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(metrics.increment).toHaveBeenCalledWith(
      "kbju_modality_router_llm_call",
      { component: "C20", outcome: "success_default" },
    );
  });

  it("emits failure metric when all tiers fail", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce(failureLLMResponse())
      .mockResolvedValueOnce(failureLLMResponse())
      .mockResolvedValueOnce(failureLLMResponse());

    await extractMoodFromText(
      "текст",
      "req-016",
      "user-001",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false,
    );

    expect(metrics.increment).toHaveBeenCalledWith(
      "kbju_modality_router_llm_call",
      { component: "C20", outcome: "failure" },
    );
  });
});
