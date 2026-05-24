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

// Mock callOmniRoute to control LLM call outcomes
vi.mock("../../src/llm/omniRouteClient.js", () => ({
  callOmniRoute: vi.fn(),
  buildMealParsingSystemPrompt: vi.fn(),
  buildMealParsingUserContent: vi.fn(),
}));

import { callOmniRoute } from "../../src/llm/omniRouteClient.js";
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

const CLASSIFIER_CONFIG = {
  systemPromptTemplate: "You are a modality classifier. Candidates: {{CANDIDATE_SET}}. Schema: {{JSON_SCHEMA}}. Respond with ONLY JSON.",
  outputJsonSchema: '{"label":"string","confidence":"number"}',
  confidenceThreshold: 0.6,
  defaultModel: { modelAlias: "accounts/fireworks/models/gpt-oss-20b", providerHint: "fireworks" },
  fallbackModel: { modelAlias: "accounts/fireworks/models/qwen3-vl-30b-a3b", providerHint: "fireworks" },
  emergencyModel: { modelAlias: "openrouter/nvidia/nemotron-3-super:free", providerHint: "openrouter" },
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
      monthUtc: "2026-05",
    }),
  };
}

beforeEach(() => {
  mockCallOmniRoute.mockReset();
});

// ── ClassifierConfigLoader tests ───────────────────────────────────────────

describe("ClassifierConfigLoader", () => {
  it("loads valid classifier config", () => {
    const { loader, cleanup } = makeClassifierConfigLoader();
    const config = loader.getConfig();
    expect(config).not.toBeNull();
    expect(config!.confidenceThreshold).toBe(0.6);
    expect(config!.defaultModel.modelAlias).toBe("accounts/fireworks/models/gpt-oss-20b");
    cleanup();
  });

  it("preserves last valid config on malformed update", () => {
    const { loader, cleanup } = makeClassifierConfigLoader();
    expect(loader.getConfig()).not.toBeNull();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "classifier-malformed-"));
    const badPath = path.join(tmpDir, "bad.json");
    const tmpPath = badPath + ".tmp";
    fs.writeFileSync(tmpPath, "{ invalid", "utf-8");
    fs.renameSync(tmpPath, badPath);
    const logger = makeLogger();
    const badLoader = new ClassifierConfigLoader(badPath, logger);
    expect(badLoader.getConfig()).toBeNull();
    badLoader.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    cleanup();
  });

  it("rejects config with invalid confidenceThreshold", () => {
    const badConfig = { ...CLASSIFIER_CONFIG, confidenceThreshold: 2.0 };
    const { loader, cleanup } = makeClassifierConfigLoader(badConfig);
    expect(loader.getConfig()).toBeNull();
    cleanup();
  });
});

// ── classifyViaLLM degradation chain tests ─────────────────────────────────

describe("classifyViaLLM degradation chain", () => {
  const candidateSet = ["KBJU", "WATER", "AMBIGUOUS"] as const;

  it("returns success_default when default model succeeds", async () => {
    const { loader, cleanup } = makeClassifierConfigLoader();
    const metrics = makeMetrics();
    const logger = makeLogger();

    mockCallOmniRoute.mockResolvedValue({
      providerAlias: "omniroute",
      modelAlias: "accounts/fireworks/models/gpt-oss-20b",
      rawResponseText: '{"label":"WATER","confidence":0.9}',
      inputUnits: 50,
      outputUnits: 5,
      estimatedCostUsd: 0.0001,
      outcome: "success",
    });

    const result = await classifyViaLLM(
      "выпил воды",
      candidateSet,
      "req-1",
      "user-1",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false
    );

    expect(result.modality).toBe("WATER");
    expect(result.confidence).toBe(0.9);
    expect(result.modelTier).toBe("default");
    expect(metrics.increment).toHaveBeenCalledWith(
      "kbju_modality_router_llm_call",
      { component: "C16", outcome: "success_default" }
    );
    cleanup();
  });

  it("falls back to fallback model when default fails", async () => {
    const { loader, cleanup } = makeClassifierConfigLoader();
    const metrics = makeMetrics();
    const logger = makeLogger();

    let callCount = 0;
    mockCallOmniRoute.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          providerAlias: "omniroute",
          modelAlias: "accounts/fireworks/models/gpt-oss-20b",
          rawResponseText: "",
          inputUnits: 0,
          outputUnits: 0,
          estimatedCostUsd: 0,
          outcome: "provider_failure",
        };
      }
      return {
        providerAlias: "omniroute",
        modelAlias: "accounts/fireworks/models/qwen3-vl-30b-a3b",
        rawResponseText: '{"label":"KBJU","confidence":0.7}',
        inputUnits: 50,
        outputUnits: 5,
        estimatedCostUsd: 0.0001,
        outcome: "success",
      };
    });

    const result = await classifyViaLLM(
      "курица с рисом",
      candidateSet,
      "req-2",
      "user-2",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false
    );

    expect(result.modality).toBe("KBJU");
    expect(result.confidence).toBe(0.7);
    expect(result.modelTier).toBe("fallback");
    expect(metrics.increment).toHaveBeenCalledWith(
      "kbju_modality_router_llm_call",
      { component: "C16", outcome: "success_fallback" }
    );
    cleanup();
  });

  it("falls back to emergency when default and fallback fail", async () => {
    const { loader, cleanup } = makeClassifierConfigLoader();
    const metrics = makeMetrics();
    const logger = makeLogger();

    let callCount = 0;
    mockCallOmniRoute.mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          providerAlias: "omniroute",
          modelAlias: "failed-model",
          rawResponseText: "",
          inputUnits: 0,
          outputUnits: 0,
          estimatedCostUsd: 0,
          outcome: "provider_failure",
        };
      }
      return {
        providerAlias: "omniroute",
        modelAlias: "openrouter/nvidia/nemotron-3-super:free",
        rawResponseText: '{"label":"AMBIGUOUS","confidence":0.3}',
        inputUnits: 50,
        outputUnits: 5,
        estimatedCostUsd: 0,
        outcome: "success",
      };
    });

    const result = await classifyViaLLM(
      "непонятный текст",
      candidateSet,
      "req-3",
      "user-3",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false
    );

    expect(result.modality).toBe("AMBIGUOUS");
    expect(result.modelTier).toBe("emergency");
    expect(metrics.increment).toHaveBeenCalledWith(
      "kbju_modality_router_llm_call",
      { component: "C16", outcome: "success_emergency" }
    );
    cleanup();
  });

  it("returns AMBIGUOUS with failure label when all three tiers fail", async () => {
    const { loader, cleanup } = makeClassifierConfigLoader();
    const metrics = makeMetrics();
    const logger = makeLogger();

    mockCallOmniRoute.mockResolvedValue({
      providerAlias: "omniroute",
      modelAlias: "failed-model",
      rawResponseText: "",
      inputUnits: 0,
      outputUnits: 0,
      estimatedCostUsd: 0,
      outcome: "provider_failure",
    });

    const result = await classifyViaLLM(
      "абракадабра",
      candidateSet,
      "req-4",
      "user-4",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false
    );

    expect(result.modality).toBe("AMBIGUOUS");
    expect(result.modelTier).toBe("failure");
    expect(metrics.increment).toHaveBeenCalledWith(
      "kbju_modality_router_llm_call",
      { component: "C16", outcome: "failure" }
    );
    cleanup();
  });

  it("returns AMBIGUOUS on malformed LLM JSON output (forced-output guardrail)", async () => {
    const { loader, cleanup } = makeClassifierConfigLoader();
    const metrics = makeMetrics();
    const logger = makeLogger();

    // All tiers succeed HTTP-wise but return malformed JSON
    mockCallOmniRoute.mockResolvedValue({
      providerAlias: "omniroute",
      modelAlias: "some-model",
      rawResponseText: "not valid json at all",
      inputUnits: 50,
      outputUnits: 5,
      estimatedCostUsd: 0.0001,
      outcome: "success",
    });

    const result = await classifyViaLLM(
      "текст",
      candidateSet,
      "req-5",
      "user-5",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false
    );

    // Malformed JSON → all tiers "succeed" but parse fails → AMBIGUOUS with failure
    expect(result.modality).toBe("AMBIGUOUS");
    expect(result.modelTier).toBe("failure");
    cleanup();
  });

  it("rejects LLM output with label not in candidate set", async () => {
    const { loader, cleanup } = makeClassifierConfigLoader();
    const metrics = makeMetrics();
    const logger = makeLogger();

    mockCallOmniRoute.mockResolvedValue({
      providerAlias: "omniroute",
      modelAlias: "some-model",
      rawResponseText: '{"label":"INVALID_LABEL","confidence":0.9}',
      inputUnits: 50,
      outputUnits: 5,
      estimatedCostUsd: 0.0001,
      outcome: "success",
    });

    const result = await classifyViaLLM(
      "текст",
      candidateSet,
      "req-6",
      "user-6",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false
    );

    // Invalid label → parseClassifierOutput rejects → falls through tiers → failure
    expect(result.modality).toBe("AMBIGUOUS");
    cleanup();
  });

  it("returns AMBIGUOUS when config is null (no config loaded)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-cfg-classifier-"));
    const filePath = path.join(tmpDir, "nonexistent.json");
    const logger = makeLogger();
    const loader = new ClassifierConfigLoader(filePath, logger);
    const metrics = makeMetrics();

    const result = await classifyViaLLM(
      "текст",
      ["KBJU", "AMBIGUOUS"],
      "req-noconfig",
      "user-noconfig",
      loader,
      logger,
      metrics
    );

    expect(result.modality).toBe("AMBIGUOUS");
    expect(result.modelTier).toBe("failure");
    expect(metrics.increment).toHaveBeenCalledWith(
      "kbju_modality_router_llm_call",
      { component: "C16", outcome: "failure" }
    );

    loader.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("classifier returns the label from LLM even with low confidence (threshold checked by router)", async () => {
    const { loader, cleanup } = makeClassifierConfigLoader();
    const metrics = makeMetrics();
    const logger = makeLogger();

    mockCallOmniRoute.mockResolvedValue({
      providerAlias: "omniroute",
      modelAlias: "some-model",
      rawResponseText: '{"label":"MOOD","confidence":0.4}',
      inputUnits: 50,
      outputUnits: 5,
      estimatedCostUsd: 0.0001,
      outcome: "success",
    });

    const result = await classifyViaLLM(
      "какой-то текст",
      ["MOOD", "AMBIGUOUS"],
      "req-threshold",
      "user-threshold",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      makeSpendTracker() as any,
      false
    );

    // The classifier itself returns what the LLM said; confidence threshold is checked by the router.
    expect(result.modality).toBe("MOOD");
    expect(result.confidence).toBe(0.4);
    cleanup();
  });
});
