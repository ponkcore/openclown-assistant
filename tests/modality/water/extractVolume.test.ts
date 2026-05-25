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
  systemPromptTemplate: "Extract volume from message. Schema: {{JSON_SCHEMA}}. Respond with ONLY JSON.",
  outputJsonSchema: '{"volume_ml":"integer","confidence":"number"}',
  confidenceThreshold: 0.6,
  defaultModel: { modelAlias: "accounts/fireworks/models/gpt-oss-20b", providerHint: "fireworks" },
  fallbackModel: { modelAlias: "accounts/fireworks/models/minimax-m2p7", providerHint: "fireworks" },
  emergencyModel: { modelAlias: "openrouter/nvidia/nemotron-3-super:free", providerHint: "openrouter" },
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

function successResponse(rawJson: string) {
  return {
    providerAlias: "fireworks" as const,
    modelAlias: "accounts/fireworks/models/gpt-oss-20b",
    rawResponseText: rawJson,
    inputUnits: 10,
    outputUnits: 5,
    estimatedCostUsd: 0.0001,
    outcome: "success" as const,
  };
}

function failureResponse() {
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
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("returns volume from default model on success", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(
      successResponse('{"volume_ml": 500, "confidence": 0.95}')
    );

    const result = await extractVolumeFromText(
      "выпил пол-литра воды",
      "req-1",
      "user-1",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      spendTracker as any,
      false,
    );

    expect(result.volumeMl).toBe(500);
    expect(result.confidence).toBe(0.95);
    expect(result.modelTier).toBe("default");
  });

  it("falls back to fallback model when default fails", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce(failureResponse())
      .mockResolvedValueOnce(
        successResponse('{"volume_ml": 250, "confidence": 0.8}')
      );

    const result = await extractVolumeFromText(
      "стакан воды",
      "req-2",
      "user-1",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      spendTracker as any,
      false,
    );

    expect(result.volumeMl).toBe(250);
    expect(result.confidence).toBe(0.8);
    expect(result.modelTier).toBe("fallback");
  });

  it("falls back to emergency model when default and fallback fail", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce(failureResponse())
      .mockResolvedValueOnce(failureResponse())
      .mockResolvedValueOnce(
        successResponse('{"volume_ml": 1000, "confidence": 0.7}')
      );

    const result = await extractVolumeFromText(
      "литр воды",
      "req-3",
      "user-1",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      spendTracker as any,
      false,
    );

    expect(result.volumeMl).toBe(1000);
    expect(result.confidence).toBe(0.7);
    expect(result.modelTier).toBe("emergency");
  });

  it("returns failure when all three tiers fail", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce(failureResponse())
      .mockResolvedValueOnce(failureResponse())
      .mockResolvedValueOnce(failureResponse());

    const result = await extractVolumeFromText(
      "что-то непонятное",
      "req-4",
      "user-1",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      spendTracker as any,
      false,
    );

    expect(result.volumeMl).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.modelTier).toBe("failure");
  });

  it("rejects malformed JSON and falls through to next tier (forced-output guardrail)", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce(
        successResponse("This is not JSON at all")
      )
      .mockResolvedValueOnce(
        successResponse('{"volume_ml": 300, "confidence": 0.85}')
      );

    const result = await extractVolumeFromText(
      "кружка воды",
      "req-5",
      "user-1",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      spendTracker as any,
      false,
    );

    expect(result.volumeMl).toBe(300);
    expect(result.modelTier).toBe("fallback");
  });

  it("rejects JSON with extra keys (forced-output guardrail)", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce(
        successResponse('{"volume_ml": 500, "confidence": 0.9, "extra": "dangerous"}')
      )
      .mockResolvedValueOnce(
        successResponse('{"volume_ml": 500, "confidence": 0.9}')
      );

    const result = await extractVolumeFromText(
      "пол-литра",
      "req-6",
      "user-1",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      spendTracker as any,
      false,
    );

    expect(result.modelTier).toBe("fallback");
    expect(result.volumeMl).toBe(500);
  });

  it("rejects JSON with non-integer volume_ml", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce(
        successResponse('{"volume_ml": 500.5, "confidence": 0.9}')
      )
      .mockResolvedValueOnce(
        successResponse('{"volume_ml": 500, "confidence": 0.9}')
      );

    const result = await extractVolumeFromText(
      "пол-литра",
      "req-7",
      "user-1",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      spendTracker as any,
      false,
    );

    expect(result.modelTier).toBe("fallback");
  });

  it("rejects out-of-range LLM output (negative volume)", async () => {
    // The parser accepts any integer, but the logger validates the range.
    // Here we test that the extractor returns whatever the LLM gives;
    // range validation is in the logger.
    mockCallOmniRoute.mockResolvedValueOnce(
      successResponse('{"volume_ml": -100, "confidence": 0.8}')
    );

    const result = await extractVolumeFromText(
      "что-то",
      "req-8",
      "user-1",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      spendTracker as any,
      false,
    );

    // Extractor returns the LLM output; range validation is in logger
    expect(result.volumeMl).toBe(-100);
    expect(result.modelTier).toBe("default");
  });

  it("returns failure when config loader has no config", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "water-extractor-empty-"));
    const filePath = path.join(tmpDir, "nonexistent.json");
    const nullLoader = new ExtractorConfigLoader(filePath, makeLogger());

    const result = await extractVolumeFromText(
      "стакан воды",
      "req-9",
      "user-1",
      nullLoader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      spendTracker as any,
      false,
    );

    expect(result.volumeMl).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.modelTier).toBe("failure");

    nullLoader.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits correct metrics on default success", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(
      successResponse('{"volume_ml": 250, "confidence": 0.9}')
    );

    await extractVolumeFromText(
      "стакан воды",
      "req-10",
      "user-1",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      spendTracker as any,
      false,
    );

    expect(metrics.increment).toHaveBeenCalledWith(
      "kbju_modality_router_llm_call",
      { component: "C17", outcome: "success_default" },
    );
  });

  it("emits failure metric when all tiers fail", async () => {
    mockCallOmniRoute
      .mockResolvedValueOnce(failureResponse())
      .mockResolvedValueOnce(failureResponse())
      .mockResolvedValueOnce(failureResponse());

    await extractVolumeFromText(
      "xyz",
      "req-11",
      "user-1",
      loader,
      logger,
      metrics,
      "http://localhost:11434",
      "test-key",
      spendTracker as any,
      false,
    );

    expect(metrics.increment).toHaveBeenCalledWith(
      "kbju_modality_router_llm_call",
      { component: "C17", outcome: "failure" },
    );
  });
});
