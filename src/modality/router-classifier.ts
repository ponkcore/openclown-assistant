/**
 * C16 Modality Router — LLM classifier via OmniRoute.
 *
 * Per ADR-018@0.1.0:
 *   default model: accounts/fireworks/models/gpt-oss-20b
 *   fallback model: accounts/fireworks/models/qwen3-vl-30b-a3b
 *   emergency-free model: openrouter/nvidia/nemotron-3-super:free
 *
 * Call chain: default → on error/timeout/invalid-json → fallback →
 *   on second failure → emergency → on third failure → return AMBIGUOUS with failure label.
 *
 * Per ADR-006@0.1.0: forced-output guardrail — hard-validate JSON schema,
 * reject + fall back to AMBIGUOUS on parse failure.
 */

import fs from "node:fs";
import type { OpenClawLogger } from "../shared/types.js";
import type { MetricsRegistry } from "../observability/metricsEndpoint.js";
import { PROMETHEUS_METRIC_NAMES } from "../observability/kpiEvents.js";
import { callOmniRoute } from "../llm/omniRouteClient.js";
import type {
  OmniRouteConfig,
  OmniRouteCallOptions,
  OmniRouteCallResult,
} from "../llm/omniRouteClient.js";
import type { SpendTracker } from "../observability/costGuard.js";
import type { ModalityLabel } from "./router.js";
import { MODALITY_LABELS } from "./router.js";

// ── Classifier config types ───────────────────────────────────────────────

export interface ClassifierModelPick {
  modelAlias: string;
  providerHint: string;
}

export interface ClassifierConfig {
  /** System prompt template for modality classification */
  systemPromptTemplate: string;
  /** JSON schema the LLM must produce */
  outputJsonSchema: string;
  /** Confidence threshold (0.6 default per ADR-018) */
  confidenceThreshold: number;
  /** Default model per ADR-018 */
  defaultModel: ClassifierModelPick;
  /** Fallback model per ADR-018 */
  fallbackModel: ClassifierModelPick;
  /** Emergency-free model per ADR-018 */
  emergencyModel: ClassifierModelPick;
}

// ── Classifier result ────────────────────────────────────────────────────

export interface ClassifierResult {
  modality: ModalityLabel;
  confidence: number | null;
  /** Which model tier succeeded (for metrics) */
  modelTier: "default" | "fallback" | "emergency" | "failure";
}

// ── Valid output schema ───────────────────────────────────────────────────

interface ClassifyOutput {
  label: string;
  confidence: number;
}

const VALID_LABELS = new Set<string>(MODALITY_LABELS);

/**
 * Hard-validate the LLM output per ADR-006@0.1.0 forced-output guardrail.
 * Returns null if the output is malformed or contains an invalid label.
 */
function parseClassifierOutput(raw: string, allowedSet: readonly ModalityLabel[]): ClassifyOutput | null {
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

  if (typeof obj.label !== "string" || typeof obj.confidence !== "number") {
    return null;
  }

  const label = obj.label as string;
  const confidence = obj.confidence as number;

  if (!allowedSet.includes(label as ModalityLabel)) {
    return null;
  }

  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }

  // Per ADR-006@0.1.0 forced-output guardrail: reject responses with extra keys.
  // Only {label, confidence} is allowed — no unexpected content in the routing path.
  const allowedKeys = new Set(["label", "confidence"]);
  const objKeys = Object.keys(obj);
  if (objKeys.length !== 2 || !objKeys.every((k) => allowedKeys.has(k))) {
    return null;
  }

  return { label, confidence };
}

// ── Hot-reloadable config loader (ADR-013 pattern) ───────────────────────

export class ClassifierConfigLoader {
  private config: ClassifierConfig | null = null;
  private lastValidConfig: ClassifierConfig | null = null;
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

  getConfig(): ClassifierConfig | null {
    return this.config ?? this.lastValidConfig;
  }

  close(): void {
    fs.unwatchFile(this.filePath);
  }

  private loadFile(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.logger.warn(
          `classifier config missing at ${this.filePath}, preserving last valid config`
        );
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as ClassifierConfig;
      this.validateConfig(parsed);
      this.config = parsed;
      this.lastValidConfig = parsed;
    } catch (err) {
      this.logger.warn(
        `classifier config load failed at ${this.filePath}: ${err instanceof Error ? err.message : String(err)}, preserving last valid config`
      );
    }
  }

  private validateConfig(cfg: ClassifierConfig): void {
    if (typeof cfg.confidenceThreshold !== "number" || cfg.confidenceThreshold < 0 || cfg.confidenceThreshold > 1) {
      throw new Error("classifier config must have confidenceThreshold in [0, 1]");
    }
    if (!cfg.defaultModel || !cfg.fallbackModel || !cfg.emergencyModel) {
      throw new Error("classifier config must have defaultModel, fallbackModel, emergencyModel");
    }
    if (typeof cfg.systemPromptTemplate !== "string" || cfg.systemPromptTemplate.length === 0) {
      throw new Error("classifier config must have non-empty systemPromptTemplate");
    }
  }
}

// ── Build prompt content ─────────────────────────────────────────────────

function buildSystemPrompt(
  template: string,
  candidateSet: readonly ModalityLabel[],
  jsonSchema: string
): string {
  const candidatesStr = candidateSet.join(", ");
  return template
    .replace("{{CANDIDATE_SET}}", candidatesStr)
    .replace("{{JSON_SCHEMA}}", jsonSchema);
}

function buildUserContent(text: string): string {
  // Per ticket constraint: LLM-classifier prompt MUST NOT include any user PII
  // beyond the message text being classified. No telegram_user_id, chat_id, etc.
  return JSON.stringify({ message_text: text });
}

// ── Call OmniRoute with a specific model ──────────────────────────────────

async function callWithModel(
  modelPick: ClassifierModelPick,
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
    maxInputTokens: 512,
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

// ── Main classifier function ─────────────────────────────────────────────

/**
 * Classify a message text into a modality label via LLM.
 *
 * Per ADR-018: try default → fallback → emergency. Each transition
 * emits the corresponding kbju_modality_router_llm_call label.
 * After third failure → return AMBIGUOUS with failure label.
 */
export async function classifyViaLLM(
  text: string,
  candidateSet: readonly ModalityLabel[],
  requestId: string,
  userId: string,
  configLoader: ClassifierConfigLoader,
  logger: OpenClawLogger,
  metricsRegistry: MetricsRegistry,
  omniRouteBaseUrl?: string,
  omniRouteApiKey?: string,
  spendTracker?: SpendTracker,
  degradeModeEnabled?: boolean
): Promise<ClassifierResult> {
  const config = configLoader.getConfig();

  if (!config) {
    metricsRegistry.increment(
      PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
      { component: "C16", outcome: "failure" }
    );
    return { modality: "AMBIGUOUS", confidence: null, modelTier: "failure" };
  }

  const systemPrompt = buildSystemPrompt(
    config.systemPromptTemplate,
    candidateSet,
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
    const parsed = parseClassifierOutput(defaultResult.rawResponseText, candidateSet);
    if (parsed) {
      metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
        { component: "C16", outcome: "success_default" }
      );
      return {
        modality: parsed.label as ModalityLabel,
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
    const parsed = parseClassifierOutput(fallbackResult.rawResponseText, candidateSet);
    if (parsed) {
      metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
        { component: "C16", outcome: "success_fallback" }
      );
      return {
        modality: parsed.label as ModalityLabel,
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
    const parsed = parseClassifierOutput(emergencyResult.rawResponseText, candidateSet);
    if (parsed) {
      metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
        { component: "C16", outcome: "success_emergency" }
      );
      return {
        modality: parsed.label as ModalityLabel,
        confidence: parsed.confidence,
        modelTier: "emergency",
      };
    }
  }

  // All tiers failed → AMBIGUOUS
  metricsRegistry.increment(
    PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call,
    { component: "C16", outcome: "failure" }
  );
  return { modality: "AMBIGUOUS", confidence: null, modelTier: "failure" };
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
