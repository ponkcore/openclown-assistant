/**
 * TKT-025@0.1.0 — End-to-end integration test proving AC line 68:
 * "The three metric views (misclassification_rate, llm_fallback_rate,
 *  llm_failure_rate) are queryable via the existing local Prometheus surface;
 *  manual scrape returns non-empty values after a smoke run exercising all 5
 *  routing paths."
 *
 * Strategy:
 *   1. Construct a registry via the production wiring path
 *      (createMetricsServer → createMetricsRegistry → createModalityInstrumentedRegistry).
 *   2. Pass the wrapped registry to routeModality across all 5 paths
 *      (one case per path, reusing the golden fixture inputs).
 *   3. Call the registry's render() (the same function the /metrics endpoint calls).
 *   4. Assert the rendered output contains the three derived gauge names with
 *      non-null numeric values.
 */

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  routeModality,
  ModalityRouterConfigLoader,
  CLARIFYING_REPLY_TEXT,
  CLARIFYING_KEYBOARD_BUTTONS,
  CLARIFYING_KEYBOARD_CALLBACK_DATA,
  type ModalityRouterConfig,
  type RouterDeps,
} from "../../src/modality/router.js";
import { ClassifierConfigLoader, type ClassifierResult } from "../../src/modality/router-classifier.js";
import {
  createMetricsRegistry,
  type MetricsRegistry,
  type MetricsServer,
} from "../../src/observability/metricsEndpoint.js";
import { createModalityInstrumentedRegistry } from "../../src/observability/modalityMisclassificationRate.js";
import { PROMETHEUS_METRIC_NAMES } from "../../src/observability/kpiEvents.js";
import type { OpenClawLogger } from "../../src/shared/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLogger(): OpenClawLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
}

function simpleC4Detector(text: string): boolean {
  const foodPatterns: Array<{ lemma: string; suffixes?: string[] }> = [
    { lemma: "съел", suffixes: ["", "а", "и"] },
    { lemma: "ел", suffixes: ["", "а", "и"] },
    { lemma: "куриц", suffixes: ["а", "е", "ей", "у", "ы"] },
    { lemma: "рис", suffixes: ["", "а", "у", "ом", "е"] },
    { lemma: "творог", suffixes: ["", "а", "у", "е"] },
    { lemma: "кефир", suffixes: ["", "а", "у", "е"] },
    { lemma: "хлеб", suffixes: ["", "а", "у", "е"] },
    { lemma: "мяс", suffixes: ["о", "а", "у", "е"] },
    { lemma: "рыб", suffixes: ["а", "у", "е", "ы"] },
    { lemma: "яблок", suffixes: ["о", "а", "у", "и"] },
    { lemma: "банан", suffixes: ["", "а", "у", "ы"] },
    { lemma: "каш", suffixes: ["а", "у", "и", "е"] },
    { lemma: "грамм", suffixes: ["", "а", "ы", "ов"] },
    { lemma: "ккал" },
    { lemma: "белк", suffixes: ["", "а", "и", "ов"] },
    { lemma: "жир", suffixes: ["", "а", "у", "ы"] },
    { lemma: "углевод", suffixes: ["", "а", "ы", "ов"] },
    { lemma: "молок", suffixes: ["о", "а", "у", "е"] },
  ];
  const lower = text.toLowerCase();
  for (const { lemma, suffixes } of foodPatterns) {
    const suffixesList = suffixes ?? [""];
    for (const suffix of suffixesList) {
      const word = lemma + suffix;
      const idx = lower.indexOf(word);
      if (idx >= 0) {
        const before = idx === 0 || /[^\p{L}]/u.test(lower[idx - 1]);
        const afterIdx = idx + word.length;
        const after = afterIdx >= lower.length || /[^\p{L}]/u.test(lower[afterIdx]);
        if (before && after) return true;
        if (before && !after && word.length >= 3) return true;
      }
    }
  }
  return false;
}

function makeConfigLoader(
  config: ModalityRouterConfig,
  metrics: MetricsRegistry,
  logger: OpenClawLogger
): ModalityRouterConfigLoader {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-modality-router-"));
  const filePath = path.join(tmpDir, "modality-router.json");
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(config), "utf-8");
  fs.renameSync(tmpPath, filePath);
  return new ModalityRouterConfigLoader(filePath, metrics, logger);
}

function makeClassifierConfigLoader(threshold: number = 0.6): ClassifierConfigLoader {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-classifier-"));
  const filePath = path.join(tmpDir, "modality-router-classifier.json");
  const cfg = {
    systemPromptTemplate: "test prompt {{CANDIDATE_SET}} {{JSON_SCHEMA}}",
    outputJsonSchema: '{"label":"string","confidence":"number"}',
    confidenceThreshold: threshold,
    defaultModel: { modelAlias: "default-model", providerHint: "fireworks" },
    fallbackModel: { modelAlias: "fallback-model", providerHint: "fireworks" },
    emergencyModel: { modelAlias: "emergency-model", providerHint: "openrouter" },
  };
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(cfg), "utf-8");
  fs.renameSync(tmpPath, filePath);
  return new ClassifierConfigLoader(filePath, makeLogger());
}

const GOLDEN_CONFIG: ModalityRouterConfig = {
  chains: [
    { modality: "KBJU", delegateToC4: true },
    {
      modality: "WATER",
      patterns: [
        { lemma: "вод", suffixPatterns: ["а", "ы", "у", "ой", "ою", "е"] },
        { lemma: "ml" },
        { lemma: "мл" },
        { lemma: "литр", suffixPatterns: ["", "а", "у", "ов", "ах", "ы"] },
        { lemma: "стакан", suffixPatterns: ["", "а", "у", "ов", "ах", "ы"] },
        { lemma: "выпил", suffixPatterns: ["", "а", "и"] },
        { lemma: "пол-литр" },
        { lemma: "поллитр" },
        { lemma: "0.5 л" },
        { lemma: "0.5л" },
      ],
    },
    {
      modality: "SLEEP",
      patterns: [
        { lemma: "спал", suffixPatterns: ["", "а", "и"] },
        { lemma: "лёг", suffixPatterns: ["", "ла", "ли"] },
        { lemma: "встал", suffixPatterns: ["", "а", "и"] },
        { lemma: "проснул", suffixPatterns: ["ся", "ась", "ись"] },
        { lemma: "сон", suffixPatterns: ["", "а", "у", "ов", "ы"] },
        { lemma: "поспал", suffixPatterns: ["", "а", "и"] },
        { lemma: "вздремн", suffixPatterns: ["ул", "ула", "ули"] },
        { lemma: "дрем", suffixPatterns: ["а", "ать", "лю", "лет"] },
        { lemma: "сны" },
      ],
    },
    {
      modality: "WORKOUT",
      patterns: [
        { lemma: "бегал", suffixPatterns: ["", "а", "и"] },
        { lemma: "км" },
        { lemma: "минут", suffixPatterns: ["", "а", "ы"] },
        { lemma: "трениров", suffixPatterns: ["ка", "ку", "ки", "ался", "алась"] },
        { lemma: "жим", suffixPatterns: ["", "а", "ы"] },
        { lemma: "присед", suffixPatterns: ["", "а", "ы", "аний"] },
        { lemma: "5×5" },
        { lemma: "йог", suffixPatterns: ["а", "ой", "у"] },
      ],
    },
    {
      modality: "MOOD",
      patterns: [
        { lemma: "настроени", suffixPatterns: ["е", "я", "ем", "ю"] },
        { lemma: "энергия", suffixPatterns: ["", "и"] },
        { lemma: "mood" },
        { lemma: "1/10" },
        { lemma: "2/10" },
        { lemma: "3/10" },
        { lemma: "4/10" },
        { lemma: "5/10" },
        { lemma: "6/10" },
        { lemma: "7/10" },
        { lemma: "8/10" },
        { lemma: "9/10" },
        { lemma: "10/10" },
      ],
    },
  ],
  ambiguousClarifyingReply: CLARIFYING_REPLY_TEXT,
  ambiguousKeyboardButtons: CLARIFYING_KEYBOARD_BUTTONS,
  ambiguousKeyboardCallbackData: CLARIFYING_KEYBOARD_CALLBACK_DATA,
};

// ════════════════════════════════════════════════════════════════════════════
// E2E integration: AC line 68 — scrape returns non-empty values after all 5 paths
// ════════════════════════════════════════════════════════════════════════════

describe("End-to-end: modality metrics in Prometheus scrape surface (AC line 68)", () => {
  it("renders misclassification_rate, llm_fallback_rate, llm_failure_rate after exercising all 5 routing paths", async () => {
    // 1. Construct the wrapped registry via the production wiring path
    const inner = createMetricsRegistry();
    const { registry, aggregator } = createModalityInstrumentedRegistry(inner);
    const logger = makeLogger();

    // 2. Route one case per path through the router using the wrapped registry
    const configLoader = makeConfigLoader(GOLDEN_CONFIG, registry, logger);
    const classifierConfigLoader = makeClassifierConfigLoader();

    // Path 1: deterministic_single
    const mockClassifier1 = vi.fn().mockResolvedValue({
      modality: "AMBIGUOUS", confidence: 0.3, modelTier: "default" as const,
    });
    const deps1: RouterDeps = {
      configLoader, classifierConfigLoader, c4Detector: simpleC4Detector,
      logger, metricsRegistry: registry, callClassifier: mockClassifier1,
    };
    await routeModality({ text: "съел 200г творога", requestId: "e2e-p1", userId: "u0" }, deps1);

    // Path 2: deterministic_multi_llm_resolved
    const mockClassifier2 = vi.fn().mockResolvedValue({
      modality: "KBJU", confidence: 0.85, modelTier: "default" as const,
    });
    const deps2: RouterDeps = {
      configLoader, classifierConfigLoader, c4Detector: simpleC4Detector,
      logger, metricsRegistry: registry, callClassifier: mockClassifier2,
    };
    await routeModality({ text: "выпил пол-литра кефира", requestId: "e2e-p2", userId: "u0" }, deps2);

    // Path 3: zero_match_llm_resolved (high confidence)
    const mockClassifier3 = vi.fn().mockResolvedValue({
      modality: "MOOD", confidence: 0.85, modelTier: "default" as const,
    });
    const deps3: RouterDeps = {
      configLoader, classifierConfigLoader, c4Detector: simpleC4Detector,
      logger, metricsRegistry: registry, callClassifier: mockClassifier3,
    };
    await routeModality({ text: "чувствую себя отлично", requestId: "e2e-p3", userId: "u0" }, deps3);

    // Path 4: zero_match_llm_ambiguous (low confidence)
    const mockClassifier4 = vi.fn().mockResolvedValue({
      modality: "AMBIGUOUS", confidence: 0.5, modelTier: "default" as const,
    });
    const deps4: RouterDeps = {
      configLoader, classifierConfigLoader, c4Detector: simpleC4Detector,
      logger, metricsRegistry: registry, callClassifier: mockClassifier4,
    };
    await routeModality({ text: "что-то произошло", requestId: "e2e-p4", userId: "u0" }, deps4);

    // Path 5: ambiguous_clarified (multi-match, LLM says ambiguous)
    const mockClassifier5 = vi.fn().mockResolvedValue({
      modality: "AMBIGUOUS", confidence: 0.2, modelTier: "default" as const,
    });
    const deps5: RouterDeps = {
      configLoader, classifierConfigLoader, c4Detector: simpleC4Detector,
      logger, metricsRegistry: registry, callClassifier: mockClassifier5,
    };
    await routeModality({ text: "кефир с водой", requestId: "e2e-p5", userId: "u0" }, deps5);

    // Also simulate an LLM failure event (to populate llm_failure_rate)
    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call, {
      component: "C16", outcome: "failure",
    });

    // 3. Call the registry's render() (same function the /metrics endpoint uses)
    const rendered = registry.render();

    // 4. Assert the three derived gauge names appear in the scrape output
    //    with non-null numeric values
    expect(rendered).toContain("kbju_modality_misclassification_rate");
    expect(rendered).toContain("kbju_modality_llm_fallback_rate");
    expect(rendered).toContain("kbju_modality_llm_failure_rate");

    // Extract actual values and verify they are numeric and non-null
    const misclassLine = rendered.split("\n").find((l) =>
      l.startsWith("kbju_modality_misclassification_rate{") && !l.startsWith("#")
    );
    const fallbackLine = rendered.split("\n").find((l) =>
      l.startsWith("kbju_modality_llm_fallback_rate{") && !l.startsWith("#")
    );
    const failureLine = rendered.split("\n").find((l) =>
      l.startsWith("kbju_modality_llm_failure_rate{") && !l.startsWith("#")
    );

    expect(misclassLine).toBeDefined();
    expect(fallbackLine).toBeDefined();
    expect(failureLine).toBeDefined();

    // Values are the last token on each line
    const misclassValue = parseFloat(misclassLine!.split(" ").pop()!);
    const fallbackValue = parseFloat(fallbackLine!.split(" ").pop()!);
    const failureValue = parseFloat(failureLine!.split(" ").pop()!);

    expect(Number.isFinite(misclassValue)).toBe(true);
    expect(Number.isFinite(fallbackValue)).toBe(true);
    expect(Number.isFinite(failureValue)).toBe(true);

    // Smoke-check the actual values are in reasonable range [0, 1]
    expect(misclassValue).toBeGreaterThanOrEqual(0);
    expect(misclassValue).toBeLessThanOrEqual(1);
    expect(fallbackValue).toBeGreaterThanOrEqual(0);
    expect(fallbackValue).toBeLessThanOrEqual(1);
    expect(failureValue).toBeGreaterThanOrEqual(0);
    expect(failureValue).toBeLessThanOrEqual(1);

    // Verify the period_type label is present
    expect(rendered).toContain('period_type="rolling_30d"');

    // Cleanup
    configLoader.close();
    classifierConfigLoader.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E2E integration via production createSidecarDeps path (F-M1 iter-3 wiring)
// ════════════════════════════════════════════════════════════════════════════

import { createSidecarDeps } from "../../src/sidecar/factory.js";

describe("End-to-end: modality metrics via production createSidecarDeps (AC line 68)", () => {
  it("renders misclassification_rate, llm_fallback_rate, llm_failure_rate after exercising all 5 routing paths through production deps", async () => {
    // 1. Construct production deps — factory now uses real wrapped registry
    const deps = createSidecarDeps(["123456"]);
    const registry = deps.metricsRegistry;

    // 2. Route one case per path through the router using the production registry
    const logger = makeLogger();

    // Use the router directly with mock classifier (since sidecar wiring
    // delegates to the router internally, and the registry is shared)
    const configLoader = makeConfigLoader(GOLDEN_CONFIG, registry, logger);
    const classifierConfigLoader = makeClassifierConfigLoader();

    // Path 1: deterministic_single
    const mockClassifier1 = vi.fn().mockResolvedValue({
      modality: "AMBIGUOUS", confidence: 0.3, modelTier: "default" as const,
    });
    const deps1: RouterDeps = {
      configLoader, classifierConfigLoader, c4Detector: simpleC4Detector,
      logger, metricsRegistry: registry, callClassifier: mockClassifier1,
    };
    await routeModality({ text: "съел 200г творога", requestId: "e2e-prod-p1", userId: "u0" }, deps1);

    // Path 2: deterministic_multi_llm_resolved
    const mockClassifier2 = vi.fn().mockResolvedValue({
      modality: "KBJU", confidence: 0.85, modelTier: "default" as const,
    });
    const deps2: RouterDeps = {
      configLoader, classifierConfigLoader, c4Detector: simpleC4Detector,
      logger, metricsRegistry: registry, callClassifier: mockClassifier2,
    };
    await routeModality({ text: "выпил пол-литра кефира", requestId: "e2e-prod-p2", userId: "u0" }, deps2);

    // Path 3: zero_match_llm_resolved (high confidence)
    const mockClassifier3 = vi.fn().mockResolvedValue({
      modality: "MOOD", confidence: 0.85, modelTier: "default" as const,
    });
    const deps3: RouterDeps = {
      configLoader, classifierConfigLoader, c4Detector: simpleC4Detector,
      logger, metricsRegistry: registry, callClassifier: mockClassifier3,
    };
    await routeModality({ text: "чувствую себя отлично", requestId: "e2e-prod-p3", userId: "u0" }, deps3);

    // Path 4: zero_match_llm_ambiguous (low confidence)
    const mockClassifier4 = vi.fn().mockResolvedValue({
      modality: "AMBIGUOUS", confidence: 0.5, modelTier: "default" as const,
    });
    const deps4: RouterDeps = {
      configLoader, classifierConfigLoader, c4Detector: simpleC4Detector,
      logger, metricsRegistry: registry, callClassifier: mockClassifier4,
    };
    await routeModality({ text: "что-то произошло", requestId: "e2e-prod-p4", userId: "u0" }, deps4);

    // Path 5: ambiguous_clarified (multi-match, LLM says ambiguous)
    const mockClassifier5 = vi.fn().mockResolvedValue({
      modality: "AMBIGUOUS", confidence: 0.2, modelTier: "default" as const,
    });
    const deps5: RouterDeps = {
      configLoader, classifierConfigLoader, c4Detector: simpleC4Detector,
      logger, metricsRegistry: registry, callClassifier: mockClassifier5,
    };
    await routeModality({ text: "кефир с водой", requestId: "e2e-prod-p5", userId: "u0" }, deps5);

    // Also simulate an LLM failure event
    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call, {
      component: "C16", outcome: "failure",
    });

    // 3. Call the production registry's render()
    const rendered = registry.render();

    // 4. Assert the three derived gauge names appear with non-null numeric values
    expect(rendered).toContain("kbju_modality_misclassification_rate");
    expect(rendered).toContain("kbju_modality_llm_fallback_rate");
    expect(rendered).toContain("kbju_modality_llm_failure_rate");
    expect(rendered).toContain('period_type="rolling_30d"');

    // Extract and verify values are finite and in [0,1]
    const misclassLine = rendered.split("\n").find((l) =>
      l.startsWith("kbju_modality_misclassification_rate{") && !l.startsWith("#")
    );
    const fallbackLine = rendered.split("\n").find((l) =>
      l.startsWith("kbju_modality_llm_fallback_rate{") && !l.startsWith("#")
    );
    const failureLine = rendered.split("\n").find((l) =>
      l.startsWith("kbju_modality_llm_failure_rate{") && !l.startsWith("#")
    );

    expect(misclassLine).toBeDefined();
    expect(fallbackLine).toBeDefined();
    expect(failureLine).toBeDefined();

    const misclassValue = parseFloat(misclassLine!.split(" ").pop()!);
    const fallbackValue = parseFloat(fallbackLine!.split(" ").pop()!);
    const failureValue = parseFloat(failureLine!.split(" ").pop()!);

    expect(Number.isFinite(misclassValue)).toBe(true);
    expect(Number.isFinite(fallbackValue)).toBe(true);
    expect(Number.isFinite(failureValue)).toBe(true);
    expect(misclassValue).toBeGreaterThanOrEqual(0);
    expect(misclassValue).toBeLessThanOrEqual(1);
    expect(fallbackValue).toBeGreaterThanOrEqual(0);
    expect(fallbackValue).toBeLessThanOrEqual(1);
    expect(failureValue).toBeGreaterThanOrEqual(0);
    expect(failureValue).toBeLessThanOrEqual(1);

    // Cleanup
    configLoader.close();
    classifierConfigLoader.close();
  });
});
