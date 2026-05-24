/**
 * C16 Modality Router — hybrid deterministic chain + LLM-fallback classifier
 * per ADR-015@0.1.0 amended Option C Hybrid.
 *
 * Routing decision tree:
 * 1. Run all five deterministic chains in parallel (cheap, in-process, ~ms).
 * 2. If exactly one chain matches → return that modality (deterministic_single).
 * 3. If two+ chains match → call LLM classifier with candidateSet=matched
 *    → deterministic_multi_llm_resolved or ambiguous_clarified.
 * 4. If zero chains match → call LLM full classifier with candidateSet=all six
 *    → zero_match_llm_resolved or zero_match_llm_ambiguous.
 * 5. AMBIGUOUS outcome → caller sends §6.2.2 verbatim clarifying-reply.
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawLogger } from "../shared/types.js";
import type { MetricsRegistry } from "../observability/metricsEndpoint.js";
import { PROMETHEUS_METRIC_NAMES } from "../observability/kpiEvents.js";
import { classifyViaLLM } from "./router-classifier.js";

// ── Public types ──────────────────────────────────────────────────────────

export const MODALITY_LABELS = [
  "KBJU",
  "WATER",
  "SLEEP",
  "WORKOUT",
  "MOOD",
  "AMBIGUOUS",
] as const;

export type ModalityLabel = (typeof MODALITY_LABELS)[number];

export const ROUTE_OUTCOMES = [
  "deterministic_single",
  "deterministic_multi_llm_resolved",
  "zero_match_llm_resolved",
  "zero_match_llm_ambiguous",
  "ambiguous_clarified",
] as const;

export type RouteOutcome = (typeof ROUTE_OUTCOMES)[number];

export interface ModalityRouterInput {
  /** Inbound text or voice-transcribed text */
  text: string;
  /** Request ID for observability */
  requestId: string;
  /** User ID for observability (hashed/anonymised at emit boundary) */
  userId: string;
}

export interface ModalityRouterDecision {
  /** The chosen modality label */
  modality: ModalityLabel;
  /** Which routing path was taken */
  outcome: RouteOutcome;
  /** Confidence from LLM classifier (null for deterministic_single) */
  confidence: number | null;
  /** Which deterministic chains matched (empty for zero-match path) */
  matchedChains: readonly ModalityLabel[];
}

// ── Config types ──────────────────────────────────────────────────────────

export interface MatcherPattern {
  /** Base lemma or keyword stem */
  lemma: string;
  /** Morphological suffix patterns (linear-time, no backtracking) */
  suffixPatterns?: readonly string[];
}

export interface MatcherChain {
  modality: ModalityLabel;
  /** If true, delegate to C4 detector function rather than keyword matching */
  delegateToC4?: boolean;
  /** Keyword patterns for this chain (omitted when delegateToC4=true) */
  patterns?: readonly MatcherPattern[];
}

export interface ModalityRouterConfig {
  /** Fixed-priority order: KBJU → water → sleep → workout → mood */
  chains: readonly MatcherChain[];
  /** Clarifying-reply string per ARCH-001 §6.2.2 */
  ambiguousClarifyingReply: string;
  /** Inline keyboard button labels */
  ambiguousKeyboardButtons: readonly string[];
  /** Callback data for each button */
  ambiguousKeyboardCallbackData: readonly string[];
}

// ── Clarifying-reply constants (ARCH-001 §6.2.2 verbatim) ────────────────

export const CLARIFYING_REPLY_TEXT =
  "Не разобралась, что записать. Уточни:";

export const CLARIFYING_KEYBOARD_BUTTONS: readonly string[] = [
  "вода",
  "еда",
  "сон",
  "тренировка",
  "настроение",
  "отмена",
];

export const CLARIFYING_KEYBOARD_CALLBACK_DATA: readonly string[] = [
  "modality:water",
  "modality:kbju",
  "modality:sleep",
  "modality:workout",
  "modality:mood",
  "modality:cancel",
];

// ── C4 KBJU detection hook (delegate, do NOT duplicate) ──────────────────

export type C4KbjuDetector = (text: string) => boolean;



// ── Deterministic matcher ─────────────────────────────────────────────────

/**
 * Build a linear-time RegExp from a MatcherPattern's lemma + suffixPatterns.
 * Pattern is anchored to word boundaries on the left only; the right side
 * allows Russian inflectional suffixes. We use non-capturing groups and
 * character classes to guarantee linear time (no catastrophic backtracking).
 */
function buildMatcherRegex(pattern: MatcherPattern): RegExp {
  const lemma = pattern.lemma.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffixes = pattern.suffixPatterns ?? [];
  if (suffixes.length === 0) {
    // Lemma alone — match lemma as prefix of a word (handles inflections)
    return new RegExp(`(?<=^|\\s|[^\\p{L}])${lemma}`, "iu");
  }
  // Build alternation of suffix patterns after the lemma
  const suffixAlt = suffixes
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(
    `(?<=^|\\s|[^\\p{L}])${lemma}(?:${suffixAlt})`,
    "iu"
  );
}

/**
 * Test whether a given text matches a matcher chain.
 * For chains with delegateToC4=true, use the C4 detector hook.
 * For keyword chains, test all patterns (OR semantics: any match fires).
 */
/**
 * Default C4 KBJU detector. Uses the same food-word keyword matching
 * that the C4 Meal Orchestrator applies to inbound text. This is the
 * built-in implementation used when no custom C4 detector is injected.
 *
 * Per TKT-022 §7: C4 pattern set is read-only; this function mirrors
 * the C4 trigger keywords without modifying the C4 module itself.
 */
export const FOOD_KEYWORD_LEMMAS: readonly MatcherPattern[] = [
  { lemma: "съел", suffixPatterns: ["", "а", "и"] },
  { lemma: "ел", suffixPatterns: ["", "а", "и"] },
  { lemma: "куриц", suffixPatterns: ["а", "е", "ей", "у", "ы"] },
  { lemma: "рис", suffixPatterns: ["", "а", "у", "ом", "е"] },
  { lemma: "творог", suffixPatterns: ["", "а", "у", "е"] },
  { lemma: "кефир", suffixPatterns: ["", "а", "у", "е"] },
  { lemma: "хлеб", suffixPatterns: ["", "а", "у", "е"] },
  { lemma: "мяс", suffixPatterns: ["о", "а", "у", "е"] },
  { lemma: "рыб", suffixPatterns: ["а", "у", "е", "ы"] },
  { lemma: "яблок", suffixPatterns: ["о", "а", "у", "и"] },
  { lemma: "банан", suffixPatterns: ["", "а", "у", "ы"] },
  { lemma: "каш", suffixPatterns: ["а", "у", "и", "е"] },
  { lemma: "молок", suffixPatterns: ["о", "а", "у", "е"] },
  { lemma: "грамм", suffixPatterns: ["", "а", "ы", "ов"] },
  { lemma: "ккал" },
  { lemma: "белк", suffixPatterns: ["", "а", "и", "ов"] },
  { lemma: "жир", suffixPatterns: ["", "а", "у", "ы"] },
  { lemma: "углевод", suffixPatterns: ["", "а", "ы", "ов"] },
  { lemma: "г." },
];

// Pre-compiled regexes for default C4 detection (built once)
const _c4Regexes: RegExp[] = FOOD_KEYWORD_LEMMAS.map((p) => buildMatcherRegex(p));

export function defaultC4KbjuDetector(text: string): boolean {
  const lower = text.toLowerCase();
  return _c4Regexes.some((re) => re.test(lower));
}

// ── Deterministic chain matching ────────────────────────────────────────

function chainMatches(
  chain: MatcherChain,
  text: string,
  c4Detector: C4KbjuDetector
): boolean {
  if (chain.delegateToC4) {
    return c4Detector(text);
  }
  if (!chain.patterns || chain.patterns.length === 0) {
    return false;
  }
  const regexes = chain.patterns.map((p) => buildMatcherRegex(p));
  return regexes.some((re) => re.test(text));
}

// ── Hot-reloadable config loader (ADR-013 pattern) ───────────────────────

export class ModalityRouterConfigLoader {
  private config: ModalityRouterConfig | null = null;
  private lastValidConfig: ModalityRouterConfig | null = null;
  private filePath: string;
  private logger: OpenClawLogger;
  private metricsRegistry: MetricsRegistry;

  constructor(
    filePath: string,
    metricsRegistry: MetricsRegistry,
    logger: OpenClawLogger
  ) {
    this.filePath = filePath;
    this.logger = logger;
    this.metricsRegistry = metricsRegistry;

    if (fs.existsSync(filePath)) {
      this.loadFile();
    }

    fs.watchFile(filePath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs > prev.mtimeMs) {
        this.loadFile();
      }
    });
  }

  getConfig(): ModalityRouterConfig | null {
    return this.config ?? this.lastValidConfig;
  }

  close(): void {
    fs.unwatchFile(this.filePath);
  }

  private loadFile(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.logger.warn(
          `modality-router config missing at ${this.filePath}, preserving last valid config`
        );
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as ModalityRouterConfig;
      this.validateConfig(parsed);
      this.config = parsed;
      this.lastValidConfig = parsed;
    } catch (err) {
      this.logger.warn(
        `modality-router config load failed at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}, preserving last valid config`
      );
    }
  }

  private validateConfig(cfg: ModalityRouterConfig): void {
    if (!Array.isArray(cfg.chains) || cfg.chains.length === 0) {
      throw new Error("modality-router config must have non-empty chains array");
    }
    for (const chain of cfg.chains) {
      if (!MODALITY_LABELS.includes(chain.modality as ModalityLabel)) {
        throw new Error(`invalid modality in chain: ${chain.modality}`);
      }
      if (chain.modality === "AMBIGUOUS") {
        throw new Error("AMBIGUOUS is not a valid chain modality (it is a router outcome)");
      }
    }
  }
}

// ── Router class ──────────────────────────────────────────────────────────

export interface RouterDeps {
  configLoader: ModalityRouterConfigLoader;
  classifierConfigLoader: import("./router-classifier.js").ClassifierConfigLoader;
  c4Detector: C4KbjuDetector;
  logger: OpenClawLogger;
  metricsRegistry: MetricsRegistry;
  /** OmniRoute call function injected for testability */
  callClassifier: typeof classifyViaLLM;
}

/**
 * Route an inbound text message to a modality decision.
 *
 * This is the main entry point per ADR-015 Option C.
 */
export async function routeModality(
  input: ModalityRouterInput,
  deps: RouterDeps
): Promise<ModalityRouterDecision> {
  const { text, requestId, userId } = input;
  const config = deps.configLoader.getConfig();

  if (!config) {
    // No config loaded → fallback to AMBIGUOUS
    deps.metricsRegistry.increment(
      PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome,
      { component: "C16", outcome: "ambiguous_clarified" }
    );
    return {
      modality: "AMBIGUOUS",
      outcome: "ambiguous_clarified",
      confidence: null,
      matchedChains: [],
    };
  }

  // 1. Run all five deterministic chains
  const matchedChains: ModalityLabel[] = [];
  for (const chain of config.chains) {
    if (chainMatches(chain, text, deps.c4Detector)) {
      matchedChains.push(chain.modality);
    }
  }

  // 2. Single match → deterministic_single
  if (matchedChains.length === 1) {
    deps.metricsRegistry.increment(
      PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome,
      { component: "C16", outcome: "deterministic_single" }
    );
    return {
      modality: matchedChains[0],
      outcome: "deterministic_single",
      confidence: null,
      matchedChains,
    };
  }

  // 3. Multi-match → LLM tie-breaker
  if (matchedChains.length >= 2) {
    const candidateSet = [...matchedChains, "AMBIGUOUS" as ModalityLabel];
    const classifierResult = await deps.callClassifier(
      text,
      candidateSet,
      requestId,
      userId,
      deps.classifierConfigLoader,
      deps.logger,
      deps.metricsRegistry
    );

    if (
      classifierResult.modality === "AMBIGUOUS" ||
      (classifierResult.confidence !== null &&
        classifierResult.confidence < (deps.classifierConfigLoader.getConfig()?.confidenceThreshold ?? 0.6))
    ) {
      deps.metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome,
        { component: "C16", outcome: "ambiguous_clarified" }
      );
      return {
        modality: "AMBIGUOUS",
        outcome: "ambiguous_clarified",
        confidence: classifierResult.confidence,
        matchedChains,
      };
    }

    deps.metricsRegistry.increment(
      PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome,
      { component: "C16", outcome: "deterministic_multi_llm_resolved" }
    );
    return {
      modality: classifierResult.modality,
      outcome: "deterministic_multi_llm_resolved",
      confidence: classifierResult.confidence,
      matchedChains,
    };
  }

  // 4. Zero-match → LLM full classifier
  const fullCandidateSet = [...MODALITY_LABELS];
  const classifierResult = await deps.callClassifier(
    text,
    fullCandidateSet,
    requestId,
    userId,
    deps.classifierConfigLoader,
    deps.logger,
    deps.metricsRegistry
  );

  const threshold =
    deps.classifierConfigLoader.getConfig()?.confidenceThreshold ?? 0.6;

  if (
    classifierResult.modality === "AMBIGUOUS" ||
    (classifierResult.confidence !== null && classifierResult.confidence < threshold)
  ) {
    deps.metricsRegistry.increment(
      PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome,
      { component: "C16", outcome: "zero_match_llm_ambiguous" }
    );
    return {
      modality: "AMBIGUOUS",
      outcome: "zero_match_llm_ambiguous",
      confidence: classifierResult.confidence,
      matchedChains: [],
    };
  }

  deps.metricsRegistry.increment(
    PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome,
    { component: "C16", outcome: "zero_match_llm_resolved" }
  );
  return {
    modality: classifierResult.modality,
    outcome: "zero_match_llm_resolved",
    confidence: classifierResult.confidence,
    matchedChains: [],
  };
}
