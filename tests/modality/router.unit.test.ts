import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  routeModality,
  ModalityRouterConfigLoader,
  CLARIFYING_REPLY_TEXT,
  CLARIFYING_KEYBOARD_BUTTONS,
  CLARIFYING_KEYBOARD_CALLBACK_DATA,
  type ModalityRouterInput,
  type ModalityRouterDecision,
  type RouterDeps,
  type ModalityRouterConfig,
  type MatcherChain,
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

// A simple C4 detector that matches food-related Russian words
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "modality-router-test-"));
  const filePath = path.join(tmpDir, "modality-router.json");
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(config), "utf-8");
  fs.renameSync(tmpPath, filePath);
  const loader = new ModalityRouterConfigLoader(filePath, metrics, logger);
  return loader;
}

function makeClassifierConfigLoader(
  threshold: number = 0.6
): ClassifierConfigLoader {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "modality-classifier-test-"));
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
  const logger = makeLogger();
  return new ClassifierConfigLoader(filePath, logger);
}

function makeRouterDeps(
  config: ModalityRouterConfig,
  classifierResult: ClassifierResult | null = null,
  metrics?: MetricsRegistry,
  logger?: OpenClawLogger,
  classifierThreshold?: number
): { deps: RouterDeps; cleanup: () => void; metrics: MetricsRegistry } {
  const m = metrics ?? makeMetrics();
  const l = logger ?? makeLogger();
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
    metrics: m,
  };
}

// ── Test config ────────────────────────────────────────────────────────────

const TEST_CONFIG: ModalityRouterConfig = {
  chains: [
    {
      modality: "KBJU",
      delegateToC4: true,
    },
    {
      modality: "WATER",
      patterns: [
        { lemma: "вод", suffixPatterns: ["а", "ы", "у", "ой", "е"] },
        { lemma: "мл" },
        { lemma: "литр", suffixPatterns: ["", "а", "ов"] },
        { lemma: "стакан", suffixPatterns: ["", "а"] },
        { lemma: "выпил", suffixPatterns: ["", "а"] },
      ],
    },
    {
      modality: "SLEEP",
      patterns: [
        { lemma: "спал", suffixPatterns: ["", "а", "и"] },
        { lemma: "лёг", suffixPatterns: ["", "ла"] },
        { lemma: "встал", suffixPatterns: ["", "а", "и"] },
        { lemma: "проснул", suffixPatterns: ["ся", "ась", "ись"] },
        { lemma: "сон", suffixPatterns: ["", "а"] },
        { lemma: "поспал", suffixPatterns: ["", "а"] },
        { lemma: "сны" },
      ],
    },
    {
      modality: "WORKOUT",
      patterns: [
        { lemma: "бегал", suffixPatterns: ["", "а", "и"] },
        { lemma: "км" },
        { lemma: "трениров", suffixPatterns: ["ка", "ку", "ки"] },
        { lemma: "жим", suffixPatterns: ["", "а"] },
        { lemma: "присед", suffixPatterns: ["", "а", "ы", "аний"] },
      ],
    },
    {
      modality: "MOOD",
      patterns: [
        { lemma: "настроени", suffixPatterns: ["е", "я", "ем"] },
        { lemma: "mood" },
        { lemma: "7/10" },
        { lemma: "5/10" },
      ],
    },
  ],
  ambiguousClarifyingReply: CLARIFYING_REPLY_TEXT,
  ambiguousKeyboardButtons: CLARIFYING_KEYBOARD_BUTTONS,
  ambiguousKeyboardCallbackData: CLARIFYING_KEYBOARD_CALLBACK_DATA,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ModalityRouterConfigLoader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-loader-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads valid config from file", () => {
    const filePath = path.join(tmpDir, "modality-router.json");
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(TEST_CONFIG), "utf-8");
    fs.renameSync(tmpPath, filePath);
    const metrics = makeMetrics();
    const logger = makeLogger();
    const loader = new ModalityRouterConfigLoader(filePath, metrics, logger);
    const config = loader.getConfig();
    expect(config).not.toBeNull();
    expect(config!.chains.length).toBe(5);
    loader.close();
  });

  it("preserves last valid config on malformed update", () => {
    const filePath = path.join(tmpDir, "modality-router.json");
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(TEST_CONFIG), "utf-8");
    fs.renameSync(tmpPath, filePath);
    const metrics = makeMetrics();
    const logger = makeLogger();
    const loader = new ModalityRouterConfigLoader(filePath, metrics, logger);
    expect(loader.getConfig()).not.toBeNull();

    // Write malformed config
    const badTmpPath = filePath + ".tmp";
    fs.writeFileSync(badTmpPath, "{ invalid json", "utf-8");
    fs.renameSync(badTmpPath, filePath);

    // Should still have the last valid config
    expect(loader.getConfig()).not.toBeNull();
    expect(loader.getConfig()!.chains.length).toBe(5);
    loader.close();
  });

  it("rejects config with AMBIGUOUS in chains", () => {
    const filePath = path.join(tmpDir, "modality-router.json");
    const badConfig = { ...TEST_CONFIG, chains: [{ modality: "AMBIGUOUS" }] };
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(badConfig), "utf-8");
    fs.renameSync(tmpPath, filePath);
    const metrics = makeMetrics();
    const logger = makeLogger();
    const loader = new ModalityRouterConfigLoader(filePath, metrics, logger);
    // Config should be null (no valid config loaded)
    expect(loader.getConfig()).toBeNull();
    loader.close();
  });
});

describe("routeModality", () => {
  describe("deterministic_single — exactly one chain matches", () => {
    it("routes 'выпил 200мл' → WATER (deterministic_single)", async () => {
      const { deps, cleanup, metrics } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "выпил 200мл", requestId: "r1", userId: "u1" },
        deps
      );
      expect(result.modality).toBe("WATER");
      expect(result.outcome).toBe("deterministic_single");
      expect(result.matchedChains).toEqual(["WATER"]);
      expect(result.confidence).toBeNull();
      expect(metrics.increment).toHaveBeenCalledWith(
        "kbju_modality_route_outcome",
        { component: "C16", outcome: "deterministic_single" }
      );
      cleanup();
    });

    it("routes 'съел 200г творога' → KBJU (deterministic_single)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "съел 200г творога", requestId: "r2", userId: "u2" },
        deps
      );
      expect(result.modality).toBe("KBJU");
      expect(result.outcome).toBe("deterministic_single");
      expect(result.matchedChains).toEqual(["KBJU"]);
      cleanup();
    });

    it("routes 'спал 7 часов' → SLEEP (deterministic_single)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "спал 7 часов", requestId: "r3", userId: "u3" },
        deps
      );
      expect(result.modality).toBe("SLEEP");
      expect(result.outcome).toBe("deterministic_single");
      cleanup();
    });

    it("routes 'бегал 5 км' → WORKOUT (deterministic_single)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "бегал 5 км", requestId: "r4", userId: "u4" },
        deps
      );
      expect(result.modality).toBe("WORKOUT");
      expect(result.outcome).toBe("deterministic_single");
      cleanup();
    });

    it("routes 'настроение 7/10' → MOOD (deterministic_single)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "настроение 7/10", requestId: "r5", userId: "u5" },
        deps
      );
      expect(result.modality).toBe("MOOD");
      expect(result.outcome).toBe("deterministic_single");
      cleanup();
    });

    it("routes 'лёг' → SLEEP (deterministic_single, bare verb)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "лёг", requestId: "r6", userId: "u6" },
        deps
      );
      expect(result.modality).toBe("SLEEP");
      expect(result.outcome).toBe("deterministic_single");
      cleanup();
    });

    it("routes 'встал' → SLEEP (deterministic_single)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "встал", requestId: "r7", userId: "u7" },
        deps
      );
      expect(result.modality).toBe("SLEEP");
      expect(result.outcome).toBe("deterministic_single");
      cleanup();
    });
  });

  describe("deterministic_multi_llm_resolved — two+ chains match, LLM resolves", () => {
    it("multi-match: 'выпил пол-литра кефира' → LLM resolves to KBJU", async () => {
      const classifierResult: ClassifierResult = {
        modality: "KBJU",
        confidence: 0.9,
        modelTier: "default",
      };
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG, classifierResult);
      const result = await routeModality(
        { text: "выпил пол-литра кефира", requestId: "r8", userId: "u8" },
        deps
      );
      // Both WATER and KBJU should match
      expect(result.matchedChains.length).toBeGreaterThanOrEqual(2);
      expect(result.modality).toBe("KBJU");
      expect(result.outcome).toBe("deterministic_multi_llm_resolved");
      expect(result.confidence).toBe(0.9);
      cleanup();
    });

    it("multi-match with low confidence → ambiguous_clarified", async () => {
      const classifierResult: ClassifierResult = {
        modality: "WATER",
        confidence: 0.4,
        modelTier: "default",
      };
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG, classifierResult);
      const result = await routeModality(
        { text: "выпил стакан кефира", requestId: "r9", userId: "u9" },
        deps
      );
      expect(result.modality).toBe("AMBIGUOUS");
      expect(result.outcome).toBe("ambiguous_clarified");
      cleanup();
    });

    it("multi-match: LLM returns AMBIGUOUS → ambiguous_clarified", async () => {
      const classifierResult: ClassifierResult = {
        modality: "AMBIGUOUS",
        confidence: 0.3,
        modelTier: "default",
      };
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG, classifierResult);
      const result = await routeModality(
        { text: "вода и каша", requestId: "r10", userId: "u10" },
        deps
      );
      expect(result.modality).toBe("AMBIGUOUS");
      expect(result.outcome).toBe("ambiguous_clarified");
      cleanup();
    });
  });

  describe("zero_match_llm_resolved — no chain matches, LLM resolves", () => {
    it("zero-match: LLM resolves to a modality with high confidence", async () => {
      const classifierResult: ClassifierResult = {
        modality: "MOOD",
        confidence: 0.8,
        modelTier: "fallback",
      };
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG, classifierResult);
      const result = await routeModality(
        { text: "чувствую себя не очень", requestId: "r11", userId: "u11" },
        deps
      );
      expect(result.modality).toBe("MOOD");
      expect(result.outcome).toBe("zero_match_llm_resolved");
      expect(result.confidence).toBe(0.8);
      cleanup();
    });

    it("zero-match: LLM returns low confidence → zero_match_llm_ambiguous", async () => {
      const classifierResult: ClassifierResult = {
        modality: "WORKOUT",
        confidence: 0.4,
        modelTier: "default",
      };
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG, classifierResult);
      const result = await routeModality(
        { text: "абракадабра", requestId: "r12", userId: "u12" },
        deps
      );
      expect(result.modality).toBe("AMBIGUOUS");
      expect(result.outcome).toBe("zero_match_llm_ambiguous");
      cleanup();
    });

    it("zero-match: LLM returns AMBIGUOUS → zero_match_llm_ambiguous", async () => {
      const classifierResult: ClassifierResult = {
        modality: "AMBIGUOUS",
        confidence: 0.5,
        modelTier: "default",
      };
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG, classifierResult);
      const result = await routeModality(
        { text: "вчера вечером было прям овациииииии", requestId: "r13", userId: "u13" },
        deps
      );
      expect(result.modality).toBe("AMBIGUOUS");
      expect(result.outcome).toBe("zero_match_llm_ambiguous");
      cleanup();
    });
  });

  describe("no config loaded → fallback AMBIGUOUS", () => {
    it("returns AMBIGUOUS when no config is available", async () => {
      const metrics = makeMetrics();
      const logger = makeLogger();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-config-test-"));
      const filePath = path.join(tmpDir, "nonexistent.json");
      const configLoader = new ModalityRouterConfigLoader(filePath, metrics, logger);
      const classifierConfigLoader = makeClassifierConfigLoader();

      const deps: RouterDeps = {
        configLoader,
        classifierConfigLoader,
        c4Detector: simpleC4Detector,
        logger,
        metricsRegistry: metrics,
        callClassifier: vi.fn(),
      };

      const result = await routeModality(
        { text: "что-то", requestId: "r14", userId: "u14" },
        deps
      );
      expect(result.modality).toBe("AMBIGUOUS");
      expect(result.outcome).toBe("ambiguous_clarified");

      configLoader.close();
      classifierConfigLoader.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("clarifying-reply constants", () => {
    it("CLARIFYING_REPLY_TEXT matches ARCH-001 §6.2.2 verbatim", () => {
      expect(CLARIFYING_REPLY_TEXT).toBe("Не разобралась, что записать. Уточни:");
    });

    it("CLARIFYING_KEYBOARD_BUTTONS has 6 buttons in correct order", () => {
      expect(CLARIFYING_KEYBOARD_BUTTONS).toEqual([
        "вода", "еда", "сон", "тренировка", "настроение", "отмена",
      ]);
    });

    it("CLARIFYING_KEYBOARD_CALLBACK_DATA has 6 entries", () => {
      expect(CLARIFYING_KEYBOARD_CALLBACK_DATA).toEqual([
        "modality:water", "modality:kbju", "modality:sleep",
        "modality:workout", "modality:mood", "modality:cancel",
      ]);
    });
  });

  describe("Russian morphology matching", () => {
    it("matches 'воду' (accusative case of вода)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "пить воду", requestId: "rm1", userId: "u1" },
        deps
      );
      expect(result.modality).toBe("WATER");
      cleanup();
    });

    it("matches 'спала' (past feminine of спать)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "спала 8 часов", requestId: "rm2", userId: "u2" },
        deps
      );
      expect(result.modality).toBe("SLEEP");
      cleanup();
    });

    it("matches 'бегала' (past feminine of бегать)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "бегала 3 км", requestId: "rm3", userId: "u3" },
        deps
      );
      expect(result.modality).toBe("WORKOUT");
      cleanup();
    });

    it("matches 'настроением' (instrumental case)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "настроением не очень", requestId: "rm4", userId: "u4" },
        deps
      );
      expect(result.modality).toBe("MOOD");
      cleanup();
    });

    it("matches 'тренировка' (noun)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "тренировка была тяжёлая", requestId: "rm5", userId: "u5" },
        deps
      );
      expect(result.modality).toBe("WORKOUT");
      cleanup();
    });

    it("matches 'сны' (plural of сон with morphological variant)", async () => {
      const { deps, cleanup } = makeRouterDeps(TEST_CONFIG);
      const result = await routeModality(
        { text: "сон был хороший", requestId: "rm6", userId: "u6" },
        deps
      );
      expect(result.modality).toBe("SLEEP");
      cleanup();
    });
  });
});
