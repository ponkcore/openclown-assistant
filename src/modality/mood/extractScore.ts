/**
 * C20 Mood Score Extractor — LLM-backed mood-score parsing via OmniRoute.
 *
 * Per ADR-018@0.1.0 §Decision (C20):
 *   default model: accounts/fireworks/models/executor
 *   fallback model: accounts/fireworks/models/reviewer
 *   emergency-free model: openrouter/nvidia/nemotron-3-super:free
 *
 * Call chain: default → on error/timeout/invalid-json → fallback →
 *   on second failure → emergency → on third failure → return failure
 *   with score=0, confidence=0, tier='failure'.
 *
 * Per ADR-006@0.1.0: forced-output guardrail — hard-validate JSON schema,
 * strict-keys validation, reject + fall back to failure on parse failure.
 */

import fs from "node:fs";
import type { OpenClawLogger } from "../../shared/types.js";
import type { MetricsRegistry } from "../../observability/metricsEndpoint.js";
import { PROMETHEUS_METRIC_NAMES } from "../../observability/kpiEvents.js";
import { callOmniRoute } from "../../llm/omniRouteClient.js";
import type {
  OmniRouteConfig,
  OmniRouteCallOptions,
  OmniRouteCallResult,
} from "../../llm/omniRouteClient.js";
import type { SpendTracker } from "../../observability/costGuard.js";

// ── Config types ──────────────────────────────────────────────────────────

export interface ExtractorModelPick {
  modelAlias: string;
  providerHint: string;
}

export interface MoodExtractorConfig {
  /** System prompt template for mood-score extraction */
  systemPromptTemplate: string;
  /** JSON schema the LLM must produce */
  outputJsonSchema: string;
  /** Confidence threshold (0.6 default per ADR-018) */
  confidenceThreshold: number;
  /** Default model per ADR-018 */
  defaultModel: ExtractorModelPick;
  /** Fallback model per ADR-018 */
  fallbackModel: ExtractorModelPick;
  /** Emergency-free model per ADR-018 */
  emergencyModel: ExtractorModelPick;
}

// ── Result type ───────────────────────────────────────────────────────────

export interface ExtractMoodResult {
  score: number;
  confidence: number;
  inferredComment: string | null;
  /** Which model tier succeeded (for metrics) */
  modelTier: "default" | "fallback" | "emergency" | "failure";
}

// ── Valid output schema ───────────────────────────────────────────────────

interface MoodOutput {
  score: number;
  confidence: number;
  inferred_comment?: string;
}

const COMMENT_MAX_LENGTH = 200;

/**
 * Hard-validate the LLM output per ADR-006@0.1.0 forced-output guardrail.
 * Returns null if the output is malformed, has extra keys, or contains
 * invalid values.
 */
function parseMoodOutput(raw: string): MoodOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.score !== "number" || typeof obj.confidence !== "number") {
    return null;
  }

  const score = obj.score as number;
  const confidence = obj.confidence as number;

  if (!Number.isFinite(score) || !Number.isInteger(score)) {
    return null;
  }

  if (score < 1 || score > 10) {
    return null;
  }

  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }

  // inferred_comment is optional
  let inferredComment: string | null = null;
  if (obj.inferred_comment !== undefined) {
    if (typeof obj.inferred_comment !== "string") {
      return null;
    }
    inferredComment = (obj.inferred_comment as string).slice(0, COMMENT_MAX_LENGTH);
  }

  // Per ADR-006@0.1.0 forced-output guardrail: strict-keys validation.
  // Allowed keys: score, confidence, inferred_comment (optional).
  const allowedKeys = new Set(["score", "confidence", "inferred_comment"]);
  const objKeys = Object.keys(obj);
  if (!objKeys.every((k) => allowedKeys.has(k))) {
    return null;
  }

  return { score, confidence, inferred_comment: inferredComment ?? undefined };
}

// ── Hot-reloadable config loader (ADR-013 pattern) ────────────────────────

export class MoodExtractorConfigLoader {
  private config: MoodExtractorConfig | null = null;
  private lastValidConfig: MoodExtractorConfig | null = null;
  private filePath: string;
  private logger: OpenClawLogger;

  constructor(filePath: string, logger: OpenClawLogger) {
    this.filePath = filePath;
    this.logger = logger;

    if (fs.existsSync(filePath)) {
      this.loadFile();
    }

    fs.watchFile(filePath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs > prev.mtimeMs) {
        this.loadFile();
      }
    });
  }

  getConfig(): MoodExtractorConfig | null {
    return this.config ?? this.lastValidConfig;
  }

  close(): void {
    fs.unwatchFile(this.filePath);
  }

  private loadFile(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.logger.warn(
          `mood extractor config missing at ${this.filePath}, preserving last valid config`
        );
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as MoodExtractorConfig;
      this.validateConfig(parsed);
      this.config = parsed;
      this.lastValidConfig = parsed;
    } catch (err) {
      this.logger.warn(
        `mood extractor config load failed at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}, preserving last valid config`
      );
    }
  }

  private validateConfig(cfg: MoodExtractorConfig): void {
    if (typeof cfg.confidenceThreshold !== "number" || cfg.confidenceThreshold < 0 || cfg.confidenceThreshold > 1) {
      throw new Error("mood extractor config must have confidenceThreshold in [0, 1]");
    }
    if (!cfg.defaultModel || !cfg.fallbackModel || !cfg.emergencyModel) {
      throw new Error("mood extractor config must have defaultModel, fallbackModel, emergencyModel");
    }
    if (typeof cfg.systemPromptTemplate !== "string" || cfg.systemPromptTemplate.length === 0) {
      throw new Error("mood extractor config must have non-empty systemPromptTemplate");
    }
  }
}

// ── Build prompt content ──────────────────────────────────────────────────

function buildSystemPrompt(
  template: string,
  jsonSchema: string
): string {
  return template
    .replace("{{JSON_SCHEMA}}", jsonSchema);
}

function buildUserContent(text: string): string {
  return JSON.stringify({ message_text_ru: text });
}

// ── Null spend tracker (for when caller doesn't supply one) ────────────────

function createNullSpendTracker(): SpendTracker {
  return {
    preflightCheck: async () => ({ allowed: true, projectedSpendUsd: 0, estimatedCallCostUsd: 0 }),
    recordCostAndCheckBudget: async () => {},
    getState: async () => ({
      estimatedSpendUsd: 0,
      degradeModeEnabled: false,
      poAlertSentAt: null,
      monthUtc: new Date().toISOString().slice(0, 7),
    }),
  } as unknown as SpendTracker;
}

// ── Call OmniRoute with a specific model ──────────────────────────────────

async function callWithModel(
  modelPick: ExtractorModelPick,
  systemPrompt: string,
  userContent: string,
  requestId: string,
  userId: string,
  omniRouteBaseUrl: string,
  omniRouteApiKey: string,
  spendTracker: SpendTracker,
  logger: OpenClawLogger,
  degradeModeEnabled: boolean
): Promise<OmniRouteCallResult> {
  const config: OmniRouteConfig = {
    baseUrl: omniRouteBaseUrl,
    apiKey: omniRouteApiKey,
    textModelAlias: modelPick.modelAlias,
    maxInputTokens: 256,
    maxOutputTokens: 64,
  };

  const options: OmniRouteCallOptions = {
    callType: "text_llm",
    systemPrompt,
    userContent,
    requestId,
    userId,
    degradeModeEnabled,
    logger,
    spendTracker,
  };

  return callOmniRoute(config, options);
}

// ── Main extraction function ──────────────────────────────────────────────

/**
 * Extract mood score from free-form Russian text via LLM.
 *
 * Per ADR-018: try default → fallback → emergency. Each transition
 * emits the corresponding kbju_modality_router_llm_call metric.
 * After third failure → return failure with score=0, confidence=0.
 */
export async function extractMoodFromText(
  text: string,
  requestId: string,
  userId: string,
  configLoader: MoodExtractorConfigLoader,
  logger: OpenClawLogger,
  metricsRegistry: MetricsRegistry,
  omniRouteBaseUrl?: string,
  omniRouteApiKey?: string,
  spendTracker?: SpendTracker,
  degradeModeEnabled?: boolean
): Promise<ExtractMoodResult> {
  const config = configLoader.getConfig();

  if (!config) {
    metricsRegistry.increment(
      PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
      { component: "C20", outcome: "failure" }
    );
    return { score: 0, confidence: 0, inferredComment: null, modelTier: "failure" };
  }

  const systemPrompt = buildSystemPrompt(
    config.systemPromptTemplate,
    config.outputJsonSchema
  );
  const userContent = buildUserContent(text);

  const baseUrl = omniRouteBaseUrl ?? process.env.OMNIROUTE_BASE_URL ?? "http://localhost:11434";
  const apiKey = omniRouteApiKey ?? process.env.OMNIROUTE_API_KEY ?? "";
  const tracker = spendTracker ?? createNullSpendTracker();
  const degrade = degradeModeEnabled ?? false;

  // Tier 1: default model
  const defaultResult = await callWithModel(
    config.defaultModel,
    systemPrompt,
    userContent,
    requestId,
    userId,
    baseUrl,
    apiKey,
    tracker,
    logger,
    degrade
  );

  if (defaultResult.outcome === "success") {
    const parsed = parseMoodOutput(defaultResult.rawResponseText);
    if (parsed) {
      metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
        { component: "C20", outcome: "success_default" }
      );
      return {
        score: parsed.score,
        confidence: parsed.confidence,
        inferredComment: parsed.inferred_comment ?? null,
        modelTier: "default",
      };
    }
  }

  // Tier 2: fallback model
  const fallbackResult = await callWithModel(
    config.fallbackModel,
    systemPrompt,
    userContent,
    requestId,
    userId,
    baseUrl,
    apiKey,
    tracker,
    logger,
    degrade
  );

  if (fallbackResult.outcome === "success") {
    const parsed = parseMoodOutput(fallbackResult.rawResponseText);
    if (parsed) {
      metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
        { component: "C20", outcome: "success_fallback" }
      );
      return {
        score: parsed.score,
        confidence: parsed.confidence,
        inferredComment: parsed.inferred_comment ?? null,
        modelTier: "fallback",
      };
    }
  }

  // Tier 3: emergency-free model
  const emergencyResult = await callWithModel(
    config.emergencyModel,
    systemPrompt,
    userContent,
    requestId,
    userId,
    baseUrl,
    apiKey,
    tracker,
    logger,
    degrade
  );

  if (emergencyResult.outcome === "success") {
    const parsed = parseMoodOutput(emergencyResult.rawResponseText);
    if (parsed) {
      metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
        { component: "C20", outcome: "success_emergency" }
      );
      return {
        score: parsed.score,
        confidence: parsed.confidence,
        inferredComment: parsed.inferred_comment ?? null,
        modelTier: "emergency",
      };
    }
  }

  // All tiers failed
  metricsRegistry.increment(
    PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
    { component: "C20", outcome: "failure" }
  );
  return { score: 0, confidence: 0, inferredComment: null, modelTier: "failure" };
}
