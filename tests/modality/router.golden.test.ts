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
      // Check word boundary: preceded by start/space/non-letter
      const idx = lower.indexOf(word);
      if (idx >= 0) {
        const before = idx === 0 || /[^\p{L}]/u.test(lower[idx - 1]);
        const afterIdx = idx + word.length;
        const after = afterIdx >= lower.length || /[^\p{L}]/u.test(lower[afterIdx]);
        if (before && after) return true;
        // Also match as prefix (for inflected forms not in suffix list)
        if (before && !after) {
          // Word boundary on left, continuing on right — possible inflection
          // Only accept if the word is a reasonable prefix (at least 3 chars)
          if (word.length >= 3) return true;
        }
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-router-test-"));
  const filePath = path.join(tmpDir, "modality-router.json");
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(config), "utf-8");
  fs.renameSync(tmpPath, filePath);
  return new ModalityRouterConfigLoader(filePath, metrics, logger);
}

function makeClassifierConfigLoader(threshold: number = 0.6): ClassifierConfigLoader {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-classifier-test-"));
  const filePath = path.join(tmpDir, "modality-router-classifier.json");
  const cfg = {
    systemPromptTemplate: "test prompt {{CANDIDATE_SET}} {{JSON_SCHEMA}}",
    outputJsonSchema: '{"label":"string","confidence":"number"}',
    confidenceThreshold: threshold,
    call_type: "kbju.modality_router_classifier",
  };
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(cfg), "utf-8");
  fs.renameSync(tmpPath, filePath);
  return new ClassifierConfigLoader(filePath, makeLogger());
}

function makeRouterDeps(
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
// DETERMINISTIC GOLDEN CASES (≥30 hand-curated Russian morphology)
// ════════════════════════════════════════════════════════════════════════════

describe("Deterministic golden cases (Russian morphology)", () => {
  const cases: Array<{ input: string; expected: string; name: string }> = [
    // KBJU (C4 delegation)
    { input: "съел 200г творога", expected: "KBJU", name: "KBJU: съел творог" },
    { input: "съела курицу с рисом", expected: "KBJU", name: "KBJU: съела курица" },
    { input: "ел кашу", expected: "KBJU", name: "KBJU: ел кашу" },
    { input: "ела рыбу на обед", expected: "KBJU", name: "KBJU: ела рыбу" },
    { input: "курица 150г", expected: "KBJU", name: "KBJU: курица 150г" },
    { input: "хлеб с маслом", expected: "KBJU", name: "KBJU: хлеб с маслом" },
    { input: "мясо на ужин", expected: "KBJU", name: "KBJU: мясо" },

    // WATER
    { input: "выпил 200мл воды", expected: "WATER", name: "WATER: выпил 200мл" },
    { input: "выпила стакан воды", expected: "WATER", name: "WATER: выпила стакан" },
    { input: "воду выпил", expected: "WATER", name: "WATER: воду выпил" },
    { input: "250 мл", expected: "WATER", name: "WATER: 250 мл" },
    { input: "1 литр воды", expected: "WATER", name: "WATER: 1 литр" },
    { input: "пол-литра воды", expected: "WATER", name: "WATER: пол-литра" },
    { input: "выпили по стакану", expected: "WATER", name: "WATER: выпили стакан" },

    // SLEEP
    { input: "спал 7 часов", expected: "SLEEP", name: "SLEEP: спал 7 часов" },
    { input: "спала 8 ч", expected: "SLEEP", name: "SLEEP: спала 8ч" },
    { input: "лёг в 23", expected: "SLEEP", name: "SLEEP: лёг в 23" },
    { input: "лёгла в полночь", expected: "SLEEP", name: "SLEEP: лёгла" },
    { input: "встал в 7", expected: "SLEEP", name: "SLEEP: встал" },
    { input: "встала", expected: "SLEEP", name: "SLEEP: встала" },
    { input: "проснулся в 6", expected: "SLEEP", name: "SLEEP: проснулся" },
    { input: "проснулась", expected: "SLEEP", name: "SLEEP: проснулась" },
    { input: "поспал 2 часа", expected: "SLEEP", name: "SLEEP: поспал 2ч" },
    { input: "сон был хороший", expected: "SLEEP", name: "SLEEP: сон был" },

    // WORKOUT
    { input: "бегал 5 км", expected: "WORKOUT", name: "WORKOUT: бегал 5км" },
    { input: "бегала 3 км", expected: "WORKOUT", name: "WORKOUT: бегала 3км" },
    { input: "тренировка плечи", expected: "WORKOUT", name: "WORKOUT: тренировка" },
    { input: "жим 80 кг", expected: "WORKOUT", name: "WORKOUT: жим 80кг" },
    { input: "присед 100 кг", expected: "WORKOUT", name: "WORKOUT: присед" },
    { input: "йога 60 мин", expected: "WORKOUT", name: "WORKOUT: йога" },

    // MOOD
    { input: "настроение 7/10", expected: "MOOD", name: "MOOD: настроение 7/10" },
    { input: "настроением подавленным", expected: "MOOD", name: "MOOD: настроением" },
    { input: "mood is low", expected: "MOOD", name: "MOOD: mood is low" },
  ];

  for (const tc of cases) {
    it(tc.name, async () => {
      const { deps, cleanup } = makeRouterDeps(GOLDEN_CONFIG);
      const result = await routeModality(
        { text: tc.input, requestId: "golden", userId: "u0" },
        deps
      );
      expect(result.modality).toBe(tc.expected);
      expect(result.outcome).toBe("deterministic_single");
      cleanup();
    });
  }

  it("golden case count ≥30", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LLM-FALLBACK MOCK ROUND-TRIP CASES (≥20)
// ════════════════════════════════════════════════════════════════════════════

describe("LLM-fallback mock round-trip cases", () => {
  // Multi-match cases → LLM tie-breaker
  const multiMatchCases: Array<{
    input: string;
    classifierResult: ClassifierResult;
    expectedModality: string;
    expectedOutcome: string;
    name: string;
  }> = [
    {
      input: "выпил пол-литра кефира",
      classifierResult: { modality: "KBJU", confidence: 0.85, modelTier: "default" },
      expectedModality: "KBJU",
      expectedOutcome: "deterministic_multi_llm_resolved",
      name: "multi: выпил пол-литра кефира → KBJU (LLM resolves)",
    },
    {
      input: "выпил стакан кефира",
      classifierResult: { modality: "WATER", confidence: 0.7, modelTier: "default" },
      expectedModality: "WATER",
      expectedOutcome: "deterministic_multi_llm_resolved",
      name: "multi: выпил стакан кефира → WATER (LLM resolves)",
    },
    {
      input: "вода и мясо",
      classifierResult: { modality: "KBJU", confidence: 0.75, modelTier: "fallback" },
      expectedModality: "KBJU",
      expectedOutcome: "deterministic_multi_llm_resolved",
      name: "multi: вода и мясо → KBJU (fallback resolves)",
    },
    {
      input: "кефир и вода",
      classifierResult: { modality: "WATER", confidence: 0.6, modelTier: "fallback" },
      expectedModality: "WATER",
      expectedOutcome: "deterministic_multi_llm_resolved",
      name: "multi: кефир и вода → WATER (fallback resolves)",
    },
    {
      input: "выпил воды после тренировки",
      classifierResult: { modality: "WATER", confidence: 0.9, modelTier: "default" },
      expectedModality: "WATER",
      expectedOutcome: "deterministic_multi_llm_resolved",
      name: "multi: выпил воды после тренировки → WATER",
    },
    {
      input: "кефир с водой",
      classifierResult: { modality: "AMBIGUOUS", confidence: 0.2, modelTier: "default" },
      expectedModality: "AMBIGUOUS",
      expectedOutcome: "ambiguous_clarified",
      name: "multi: кефир с водой → AMBIGUOUS (LLM says ambiguous)",
    },
    {
      input: "вода кефир тренировка",
      classifierResult: { modality: "WATER", confidence: 0.45, modelTier: "default" },
      expectedModality: "AMBIGUOUS",
      expectedOutcome: "ambiguous_clarified",
      name: "multi: 3-match low confidence → ambiguous_clarified",
    },
    {
      input: "молоко и бегал",
      classifierResult: { modality: "KBJU", confidence: 0.82, modelTier: "default" },
      expectedModality: "KBJU",
      expectedOutcome: "deterministic_multi_llm_resolved",
      name: "multi: молоко и бегал → KBJU",
    },
    {
      input: "кефир с водой",
      classifierResult: { modality: "KBJU", confidence: 0.78, modelTier: "default" },
      expectedModality: "KBJU",
      expectedOutcome: "deterministic_multi_llm_resolved",
      name: "multi: кефир с водой → KBJU",
    },
    {
      input: "выпил воды с лимоном и кефир",
      classifierResult: { modality: "SLEEP", confidence: 0.65, modelTier: "default" },
      expectedModality: "SLEEP",
      expectedOutcome: "deterministic_multi_llm_resolved",
      name: "multi: выпил воды с лимоном и кефир → SLEEP (LLM interprets context)",
    },
  ];

  // Zero-match cases → LLM full classifier
  const zeroMatchCases: Array<{
    input: string;
    classifierResult: ClassifierResult;
    expectedModality: string;
    expectedOutcome: string;
    name: string;
  }> = [
    {
      input: "вчера вечером было прям овацииииии",
      classifierResult: { modality: "AMBIGUOUS", confidence: 0.5, modelTier: "default" },
      expectedModality: "AMBIGUOUS",
      expectedOutcome: "zero_match_llm_ambiguous",
      name: "zero: овацииииии → AMBIGUOUS",
    },
    {
      input: "чувствую себя отлично",
      classifierResult: { modality: "MOOD", confidence: 0.85, modelTier: "default" },
      expectedModality: "MOOD",
      expectedOutcome: "zero_match_llm_resolved",
      name: "zero: чувствую отлично → MOOD",
    },
    {
      input: "плавал в бассейне",
      classifierResult: { modality: "WORKOUT", confidence: 0.8, modelTier: "default" },
      expectedModality: "WORKOUT",
      expectedOutcome: "zero_match_llm_resolved",
      name: "zero: плавал → WORKOUT",
    },
    {
      input: "не мог заснуть",
      classifierResult: { modality: "SLEEP", confidence: 0.75, modelTier: "fallback" },
      expectedModality: "SLEEP",
      expectedOutcome: "zero_match_llm_resolved",
      name: "zero: не мог заснуть → SLEEP (fallback)",
    },
    {
      input: "приятная усталость после зала",
      classifierResult: { modality: "WORKOUT", confidence: 0.7, modelTier: "default" },
      expectedModality: "WORKOUT",
      expectedOutcome: "zero_match_llm_resolved",
      name: "zero: усталость после зала → WORKOUT",
    },
    {
      input: "пил чай без сахара",
      classifierResult: { modality: "WATER", confidence: 0.55, modelTier: "default" },
      expectedModality: "AMBIGUOUS",
      expectedOutcome: "zero_match_llm_ambiguous",
      name: "zero: пил чай → AMBIGUOUS (low conf)",
    },
    {
      input: "что-то произошло",
      classifierResult: { modality: "AMBIGUOUS", confidence: 0.4, modelTier: "default" },
      expectedModality: "AMBIGUOUS",
      expectedOutcome: "zero_match_llm_ambiguous",
      name: "zero: что-то произошло → AMBIGUOUS",
    },
    {
      input: "сходил на фитнес",
      classifierResult: { modality: "WORKOUT", confidence: 0.9, modelTier: "fallback" },
      expectedModality: "WORKOUT",
      expectedOutcome: "zero_match_llm_resolved",
      name: "zero: сходил на фитнес → WORKOUT (fallback)",
    },
    {
      input: "грустно",
      classifierResult: { modality: "MOOD", confidence: 0.88, modelTier: "default" },
      expectedModality: "MOOD",
      expectedOutcome: "zero_match_llm_resolved",
      name: "zero: грустно → MOOD",
    },
    {
      input: "вздремнул полчасика",
      classifierResult: { modality: "SLEEP", confidence: 0.92, modelTier: "default" },
      expectedModality: "SLEEP",
      expectedOutcome: "deterministic_single",
      name: "det: вздремнул → SLEEP (deterministic)",
    },
  ];

  const allCases = [...multiMatchCases, ...zeroMatchCases];

  for (const tc of allCases) {
    it(tc.name, async () => {
      const { deps, cleanup } = makeRouterDeps(GOLDEN_CONFIG, tc.classifierResult);
      const result = await routeModality(
        { text: tc.input, requestId: "golden-llm", userId: "u0" },
        deps
      );
      expect(result.modality).toBe(tc.expectedModality);
      expect(result.outcome).toBe(tc.expectedOutcome);
      cleanup();
    });
  }

  it("LLM mock case count ≥20", () => {
    expect(allCases.length).toBeGreaterThanOrEqual(20);
  });
});
