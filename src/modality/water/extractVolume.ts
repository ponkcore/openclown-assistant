/**
 * C17 Water Volume Extractor — LLM-backed volume parsing via OmniRoute.
 *
 * Per ADR-018@0.1.0 §Decision (C17):
 *   default model: accounts/fireworks/models/gpt-oss-20b
 *   fallback model: accounts/fireworks/models/minimax-m2p7
 *   emergency-free model: openrouter/nvidia/nemotron-3-super:free
 *
 * Call chain: default → on error/timeout/invalid-json → fallback →
 *   on second failure → emergency → on third failure → return failure
 *   with volumeMl=0, confidence=0, tier='failure'.
 *
 * Per ADR-006@0.1.0: forced-output guardrail — hard-validate JSON schema,
 * reject + fall back to failure on parse failure.
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

export interface ExtractorConfig {
  /** System prompt template for volume extraction */
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

export interface ExtractVolumeResult {
  volumeMl: number;
  confidence: number;
  /** Which model tier succeeded (for metrics) */
  modelTier: "default" | "fallback" | "emergency" | "failure";
}

// ── Valid output schema ───────────────────────────────────────────────────

interface VolumeOutput {
  volume_ml: number;
  confidence: number;
}

/**
 * Hard-validate the LLM output per ADR-006@0.1.0 forced-output guardrail.
 * Returns null if the output is malformed or contains invalid values.
 */
function parseVolumeOutput(raw: string): VolumeOutput | null {
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

  if (typeof obj.volume_ml !== "number" || typeof obj.confidence !== "number") {
    return null;
  }

  const volumeMl = obj.volume_ml as number;
  const confidence = obj.confidence as number;

  if (!Number.isFinite(volumeMl) || !Number.isInteger(volumeMl)) {
    return null;
  }

  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }

  // Per ADR-006@0.1.0 forced-output guardrail: reject responses with extra keys.
  const allowedKeys = new Set(["volume_ml", "confidence"]);
  const objKeys = Object.keys(obj);
  if (objKeys.length !== 2 || !objKeys.every((k) => allowedKeys.has(k))) {
    return null;
  }

  return { volume_ml: volumeMl, confidence };
}

// ── Hot-reloadable config loader (ADR-013 pattern) ────────────────────────

export class ExtractorConfigLoader {
  private config: ExtractorConfig | null = null;
  private lastValidConfig: ExtractorConfig | null = null;
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

  getConfig(): ExtractorConfig | null {
    return this.config ?? this.lastValidConfig;
  }

  close(): void {
    fs.unwatchFile(this.filePath);
  }

  private loadFile(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.logger.warn(
          `water extractor config missing at ${this.filePath}, preserving last valid config`
        );
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as ExtractorConfig;
      this.validateConfig(parsed);
      this.config = parsed;
      this.lastValidConfig = parsed;
    } catch (err) {
      this.logger.warn(
        `water extractor config load failed at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}, preserving last valid config`
      );
    }
  }

  private validateConfig(cfg: ExtractorConfig): void {
    if (typeof cfg.confidenceThreshold !== "number" || cfg.confidenceThreshold < 0 || cfg.confidenceThreshold > 1) {
      throw new Error("water extractor config must have confidenceThreshold in [0, 1]");
    }
    if (!cfg.defaultModel || !cfg.fallbackModel || !cfg.emergencyModel) {
      throw new Error("water extractor config must have defaultModel, fallbackModel, emergencyModel");
    }
    if (typeof cfg.systemPromptTemplate !== "string" || cfg.systemPromptTemplate.length === 0) {
      throw new Error("water extractor config must have non-empty systemPromptTemplate");
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
 * Extract water volume from free-form Russian text via LLM.
 *
 * Per ADR-018: try default → fallback → emergency. Each transition
 * emits the corresponding kbju_modality_router_llm_call metric.
 * After third failure → return failure with volumeMl=0, confidence=0.
 */
export async function extractVolumeFromText(
  text: string,
  requestId: string,
  userId: string,
  configLoader: ExtractorConfigLoader,
  logger: OpenClawLogger,
  metricsRegistry: MetricsRegistry,
  omniRouteBaseUrl?: string,
  omniRouteApiKey?: string,
  spendTracker?: SpendTracker,
  degradeModeEnabled?: boolean
): Promise<ExtractVolumeResult> {
  const config = configLoader.getConfig();

  if (!config) {
    metricsRegistry.increment(
      PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
      { component: "C17", outcome: "failure" }
    );
    return { volumeMl: 0, confidence: 0, modelTier: "failure" };
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
    const parsed = parseVolumeOutput(defaultResult.rawResponseText);
    if (parsed) {
      metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
        { component: "C17", outcome: "success_default" }
      );
      return {
        volumeMl: parsed.volume_ml,
        confidence: parsed.confidence,
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
    const parsed = parseVolumeOutput(fallbackResult.rawResponseText);
    if (parsed) {
      metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
        { component: "C17", outcome: "success_fallback" }
      );
      return {
        volumeMl: parsed.volume_ml,
        confidence: parsed.confidence,
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
    const parsed = parseVolumeOutput(emergencyResult.rawResponseText);
    if (parsed) {
      metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
        { component: "C17", outcome: "success_emergency" }
      );
      return {
        volumeMl: parsed.volume_ml,
        confidence: parsed.confidence,
        modelTier: "emergency",
      };
    }
  }

  // All tiers failed → failure
  metricsRegistry.increment(
    PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
    { component: "C17", outcome: "failure" }
  );
  return { volumeMl: 0, confidence: 0, modelTier: "failure" };
}

// ── Null spend tracker ────────────────────────────────────────────────────

function createNullSpendTracker(): SpendTracker {
  return {
    async preflightCheck() {
      return { allowed: true, projectedSpendUsd: 0, estimatedCallCostUsd: 0 };
    },
    async recordCostAndCheckBudget() {},
    async getState() {
      return {
        estimatedSpendUsd: 0,
        degradeModeEnabled: false,
        poAlertSentAt: null,
        monthUtc: new Date().toISOString().slice(0, 7),
      };
    },
  } as unknown as SpendTracker;
}
