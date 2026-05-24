/**
 * TKT-025@0.1.0 — Full golden test suite covering all 5 ADR-015@0.1.0 Option C paths.
 *
 * Reads JSON fixtures from tests/fixtures/modality/ and runs each case
 * against `routeModality()` with a mocked `classifyViaLLM` that returns
 * the fixture's `llmMock` value per case.
 *
 * Paths:
 *   1. deterministic_single     — ≥15 cases, no LLM mock needed
 *   2. deterministic_multi_llm_resolved — ≥10 cases, LLM mock
 *   3. zero_match_llm_resolved  — ≥5 cases, LLM mock (confidence ≥ 0.6)
 *   4. zero_match_llm_ambiguous — ≥5 cases, LLM mock (confidence < 0.6 or AMBIGUOUS label)
 *   5. ambiguous_clarified      — ≥5 cases asserting verbatim §6.2.2 copy + keyboard
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
import type { MetricsRegistry } from "../../src/observability/metricsEndpoint.js";
import type { OpenClawLogger } from "../../src/shared/types.js";

// ── Fixture types ──────────────────────────────────────────────────────────

interface LLMMock {
  modality: string;
  confidence: number;
  modelTier: "default" | "fallback" | "emergency" | "failure";
}

interface DeterministicCase {
  name: string;
  input: string;
  expectedModality: string;
  expectedOutcome: string;
  llmMock: null;
}

interface LLMResolvedCase {
  name: string;
  input: string;
  expectedModality: string;
  expectedOutcome: string;
  llmMock: LLMMock;
}

interface ClarifyingCase {
  name: string;
  input: string;
  expectedModality: string;
  expectedOutcome: string;
  llmMock: LLMMock;
  expectedClarifyingReply: string;
  expectedKeyboardButtons: string[];
  expectedKeyboardCallbackData: string[];
  expectedKeyboardRows: number;
  expectedButtonsPerRow: number;
}

interface FixtureFile<T> {
  path: string;
  cases: T[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-full-router-"));
  const filePath = path.join(tmpDir, "modality-router.json");
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(config), "utf-8");
  fs.renameSync(tmpPath, filePath);
  return new ModalityRouterConfigLoader(filePath, metrics, logger);
}

function makeClassifierConfigLoader(threshold: number = 0.6): ClassifierConfigLoader {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-full-classifier-"));
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

function makeRouterDepsWithMock(
  config: ModalityRouterConfig,
  classifierResult: ClassifierResult | null = null,
  metrics?: MetricsRegistry,
  classifierThreshold?: number
): { deps: RouterDeps; cleanup: () => void } {
  const m = metrics ?? makeMetrics();
  const l = makeLogger();
  const configLoader = makeConfigLoader(config, m, l);
  const classifierConfigLoader = makeClassifierConfigLoader(classifierThreshold);

  const mockClassifier = vi.fn().mockResolvedValue(
    classifierResult ?? { modality: "AMBIGUOUS", confidence: 0.3, modelTier: "default" as const }
  );

  return {
    deps: {
      configLoader,
      classifierConfigLoader,
      c4Detector: simpleC4Detector,
      logger: l,
      metricsRegistry: m,
      callClassifier: mockClassifier,
    },
    cleanup: () => {
      configLoader.close();
      classifierConfigLoader.close();
    },
  };
}

// ── Shared config (same as TKT-022 golden test) ────────────────────────────

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

// ── Fixture loader ─────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "modality");

function loadFixture<T>(filename: string): FixtureFile<T> {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, filename), "utf-8");
  return JSON.parse(raw) as FixtureFile<T>;
}

// ════════════════════════════════════════════════════════════════════════════
// Path 1: deterministic_single (≥15 cases)
// ════════════════════════════════════════════════════════════════════════════

describe("Path 1: deterministic_single golden cases (from fixture)", () => {
  const fixture = loadFixture<DeterministicCase>("deterministic-single.json");

  for (const tc of fixture.cases) {
    it(tc.name, async () => {
      const { deps, cleanup } = makeRouterDepsWithMock(GOLDEN_CONFIG);
      const result = await routeModality(
        { text: tc.input, requestId: "golden-full", userId: "u0" },
        deps
      );
      expect(result.modality).toBe(tc.expectedModality);
      expect(result.outcome).toBe(tc.expectedOutcome);
      // Deterministic single: no LLM call expected
      expect(deps.callClassifier).not.toHaveBeenCalled();
      cleanup();
    });
  }

  it("deterministic_single case count ≥15", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(15);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Path 2: deterministic_multi_llm_resolved (≥10 cases)
// ════════════════════════════════════════════════════════════════════════════

describe("Path 2: deterministic_multi_llm_resolved golden cases (from fixture)", () => {
  const fixture = loadFixture<LLMResolvedCase>("multi-match-llm-resolved.json");

  for (const tc of fixture.cases) {
    it(tc.name, async () => {
      const classifierResult: ClassifierResult = {
        modality: tc.llmMock.modality as "KBJU" | "WATER" | "SLEEP" | "WORKOUT" | "MOOD" | "AMBIGUOUS",
        confidence: tc.llmMock.confidence,
        modelTier: tc.llmMock.modelTier,
      };
      const { deps, cleanup } = makeRouterDepsWithMock(GOLDEN_CONFIG, classifierResult);
      const result = await routeModality(
        { text: tc.input, requestId: "golden-full", userId: "u0" },
        deps
      );
      expect(result.modality).toBe(tc.expectedModality);
      expect(result.outcome).toBe(tc.expectedOutcome);
      // LLM call expected for multi-match
      expect(deps.callClassifier).toHaveBeenCalled();
      cleanup();
    });
  }

  it("multi_match_llm_resolved case count ≥10", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Path 3: zero_match_llm_resolved (≥5 cases, high confidence ≥0.6)
// ════════════════════════════════════════════════════════════════════════════

describe("Path 3: zero_match_llm_resolved golden cases (from fixture)", () => {
  const fixture = loadFixture<LLMResolvedCase>("zero-match-high-confidence.json");

  for (const tc of fixture.cases) {
    it(tc.name, async () => {
      const classifierResult: ClassifierResult = {
        modality: tc.llmMock.modality as "KBJU" | "WATER" | "SLEEP" | "WORKOUT" | "MOOD" | "AMBIGUOUS",
        confidence: tc.llmMock.confidence,
        modelTier: tc.llmMock.modelTier,
      };
      const { deps, cleanup } = makeRouterDepsWithMock(GOLDEN_CONFIG, classifierResult);
      const result = await routeModality(
        { text: tc.input, requestId: "golden-full", userId: "u0" },
        deps
      );
      expect(result.modality).toBe(tc.expectedModality);
      expect(result.outcome).toBe(tc.expectedOutcome);
      // Confidence should be ≥0.6 for resolved path
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
      cleanup();
    });
  }

  it("zero_match_llm_resolved case count ≥5", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Path 4: zero_match_llm_ambiguous (≥5 cases, low confidence <0.6 or AMBIGUOUS)
// ════════════════════════════════════════════════════════════════════════════

describe("Path 4: zero_match_llm_ambiguous golden cases (from fixture)", () => {
  const fixture = loadFixture<LLMResolvedCase>("zero-match-low-confidence.json");

  for (const tc of fixture.cases) {
    it(tc.name, async () => {
      const classifierResult: ClassifierResult = {
        modality: tc.llmMock.modality as "KBJU" | "WATER" | "SLEEP" | "WORKOUT" | "MOOD" | "AMBIGUOUS",
        confidence: tc.llmMock.confidence,
        modelTier: tc.llmMock.modelTier,
      };
      const { deps, cleanup } = makeRouterDepsWithMock(GOLDEN_CONFIG, classifierResult);
      const result = await routeModality(
        { text: tc.input, requestId: "golden-full", userId: "u0" },
        deps
      );
      expect(result.modality).toBe("AMBIGUOUS");
      expect(result.outcome).toBe(tc.expectedOutcome);
      cleanup();
    });
  }

  it("zero_match_llm_ambiguous case count ≥5", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Path 5: ambiguous_clarified (≥5 cases, verbatim §6.2.2 copy + keyboard)
// ════════════════════════════════════════════════════════════════════════════

describe("Path 5: ambiguous_clarified golden cases (verbatim copy per ARCH-001@0.6.0 §6.2.2)", () => {
  const fixture = loadFixture<ClarifyingCase>("clarifying-reply-copy.json");

  for (const tc of fixture.cases) {
    it(tc.name, async () => {
      const classifierResult: ClassifierResult = {
        modality: tc.llmMock.modality as "KBJU" | "WATER" | "SLEEP" | "WORKOUT" | "MOOD" | "AMBIGUOUS",
        confidence: tc.llmMock.confidence,
        modelTier: tc.llmMock.modelTier,
      };
      const { deps, cleanup } = makeRouterDepsWithMock(GOLDEN_CONFIG, classifierResult);
      const result = await routeModality(
        { text: tc.input, requestId: "golden-full", userId: "u0" },
        deps
      );
      expect(result.modality).toBe("AMBIGUOUS");
      expect(result.outcome).toBe("ambiguous_clarified");

      // ── Verbatim clarifying-reply copy per ARCH-001@0.6.0 §6.2.2 ────
      // Character-equality assertion, NOT approximate
      expect(CLARIFYING_REPLY_TEXT).toBe(tc.expectedClarifyingReply);

      // ── Inline keyboard structure per ARCH-001@0.6.0 §6.2.2 ──────────
      // Two rows of 3 buttons each
      expect(CLARIFYING_KEYBOARD_BUTTONS).toEqual(tc.expectedKeyboardButtons);
      expect(CLARIFYING_KEYBOARD_CALLBACK_DATA).toEqual(tc.expectedKeyboardCallbackData);
      expect(CLARIFYING_KEYBOARD_BUTTONS.length).toBe(
        tc.expectedKeyboardRows * tc.expectedButtonsPerRow
      );

      cleanup();
    });
  }

  it("ambiguous_clarified case count ≥5", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Cross-path totals
// ════════════════════════════════════════════════════════════════════════════

describe("Golden full suite totals", () => {
  const det = loadFixture<DeterministicCase>("deterministic-single.json");
  const multi = loadFixture<LLMResolvedCase>("multi-match-llm-resolved.json");
  const zeroHigh = loadFixture<LLMResolvedCase>("zero-match-high-confidence.json");
  const zeroLow = loadFixture<LLMResolvedCase>("zero-match-low-confidence.json");
  const clarifying = loadFixture<ClarifyingCase>("clarifying-reply-copy.json");

  it("total golden cases ≥40", () => {
    const total =
      det.cases.length +
      multi.cases.length +
      zeroHigh.cases.length +
      zeroLow.cases.length +
      clarifying.cases.length;
    expect(total).toBeGreaterThanOrEqual(40);
  });
});
