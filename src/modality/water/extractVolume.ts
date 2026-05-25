/**
 * C17 Water Volume Extractor — LLM-backed volume parsing via registry.
 *
 * Per ADR-024@0.1.0: model/provider resolved from config/llm.json via
 * manifest.call_type → registry.resolve(). Fallback chain is defined in
 * the registry (fallback_call_type), not in the manifest.
 *
 * Per ADR-006@0.1.0: forced-output guardrail — hard-validate JSON schema,
 * reject + fall back to failure on parse failure.
 */

import fs from "node:fs";
import type { OpenClawLogger, CallType } from "../../shared/types.js";
import type { MetricsRegistry } from "../../observability/metricsEndpoint.js";
import { PROMETHEUS_METRIC_NAMES } from "../../observability/kpiEvents.js";
import { chatCompletion } from "../../llm/llmClient.js";
import type { ChatCompletionResult, LlmCallContext } from "../../llm/llmClient.js";
import { resolve } from "../../llm/registry.js";
import type { Resolved } from "../../llm/registry.js";
import type { SpendTracker } from "../../observability/costGuard.js";

// ── Config types ──────────────────────────────────────────────────────────

export interface ExtractorConfig {
  /** Registry call-type alias (ADR-024@0.1.0) */
  call_type: string;
  /** Optional operator context (e.g. previous model pick) */
  comment?: string;
  /** System prompt template for volume extraction */
  systemPromptTemplate: string;
  /** JSON schema the LLM must produce */
  outputJsonSchema: string;
  /** Confidence threshold (0.6 default per ADR-018) */
  confidenceThreshold: number;
}

// ── Result type ───────────────────────────────────────────────────────────

export interface ExtractVolumeResult {
  volumeMl: number;
  confidence: number;
  /** Which model tier succeeded (for metrics) */
  modelTier: "default" | "fallback" | "failure";
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
    if (typeof cfg.call_type !== "string" || cfg.call_type.length === 0) {
      throw new Error("water extractor config must have non-empty call_type");
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

// ── Call LLM via registry-resolved provider ────────────────────────────────

async function callWithResolved(
  callType: string,
  resolved: Resolved,
  systemPrompt: string,
  userContent: string,
  requestId: string,
  userId: string,
  spendTracker: SpendTracker,
  logger: OpenClawLogger,
  degradeModeEnabled: boolean
): Promise<ChatCompletionResult> {

  const opts = {
    call_type: callType,
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userContent },
    ],
    max_tokens: 64,
  };

  const ctx: LlmCallContext = {
    callType: "text_llm" as CallType,
    requestId,
    userId,
    logger,
    spendTracker,
    degradeModeEnabled,
  };

  return chatCompletion(opts, ctx, resolved);
}

// ── Null spend tracker (for when no real tracker available) ───────────────

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

// ── Main extraction function ──────────────────────────────────────────────

/**
 * Extract water volume from free-form Russian text via LLM.
 *
 * Registry resolves call_type → provider/model with optional fallback.
 * After both tiers fail → return failure with volumeMl=0, confidence=0.
 */
export async function extractVolumeFromText(
  text: string,
  requestId: string,
  userId: string,
  configLoader: ExtractorConfigLoader,
  logger: OpenClawLogger,
  metricsRegistry: MetricsRegistry,
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

  const tracker = spendTracker ?? createNullSpendTracker();
  const degrade = degradeModeEnabled ?? false;

  // Resolve from registry
  let resolved: Resolved;
  try {
    resolved = resolve(config.call_type);
  } catch (err) {
    logger.warn(
      `water extractor registry resolve failed for call_type="${config.call_type}": ${err instanceof Error ? err.message : String(err)}`
    );
    metricsRegistry.increment(
      PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
      { component: "C17", outcome: "failure" }
    );
    return { volumeMl: 0, confidence: 0, modelTier: "failure" };
  }

  // Tier 1: default (registry primary)
  try {
    const defaultResult = await callWithResolved(
      config.call_type,
      resolved,
      systemPrompt,
      userContent,
      requestId,
      userId,
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
  } catch (err) {
    logger.warn(
      `water extractor default call failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Tier 2: fallback (registry fallback_call_type)
  if (resolved.fallback) {
    try {
      const fallbackResult = await callWithResolved(
        config.call_type,
        resolved.fallback,
        systemPrompt,
        userContent,
        requestId,
        userId,
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
    } catch (err) {
      logger.warn(
        `water extractor fallback call failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // All tiers failed
  metricsRegistry.increment(
    PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
    { component: "C17", outcome: "failure" }
  );
  return { volumeMl: 0, confidence: 0, modelTier: "failure" };
}
