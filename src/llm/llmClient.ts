/**
 * C23 LLM Gateway — Provider-agnostic OpenAI-compatible HTTP client
 *
 * Per ADR-022@0.1.0: single client that accepts {baseUrl, apiKey, model} per call,
 * with per-call-type provider selection driven by config/llm.json (ADR-024@0.1.0).
 *
 * Request shape (ADR-022@0.1.0 — character-for-character):
 *   chatCompletion: { call_type, messages, response_format?, max_tokens?, temperature? }
 *   vision:         { call_type, messages, response_format?, max_tokens?, temperature?, image_url }
 *
 * C13 Stall Watchdog (ADR-012@0.1.0) wraps chatCompletion — ONE place.
 * All log emits pass through redactPii.
 */

import type { CallType, OpenClawLogger, ProviderAlias, ComponentId } from "../shared/types.js";
import type { SpendTracker, PreflightResult } from "../observability/costGuard.js";
import { buildRedactedEvent, emitLog } from "../observability/events.js";
import { KPI_EVENT_NAMES, LOG_FORBIDDEN_FIELDS } from "../observability/kpiEvents.js";
import { LLM_TIMEOUT_MS } from "../kbju/types.js";
import {
  StallWatchdog,
  defaultStallWatchdogConfig,
  checkKillSwitch,
  KILL_SWITCH_DEFAULT_PATH,
  type StallWatchdogConfig,
  type StallEvent,
} from "../observability/stallWatchdog.js";
import { resolve, getApiKey } from "./registry.js";
import type { Resolved } from "./registry.js";
import { RegistryError } from "./registry.js";

// C23 component ID for observability — not yet in ComponentId union;
// cast to satisfy buildRedactedEvent. Will be added when ComponentId
// is extended to cover the C14–C23 range.
const C23 = "C23" as ComponentId;

// ── Request shapes (ADR-022@0.1.0 character-for-character) ────────────────

export interface ChatCompletionOpts {
  call_type: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: Record<string, unknown>;
  max_tokens?: number;
  temperature?: number;
}

export interface VisionOpts extends ChatCompletionOpts {
  image_url: string;
}

// ── Call context (not part of the LLM request shape — runtime plumbing) ────

export interface LlmCallContext {
  /** Coarse CallType for cost guard preflight */
  callType: CallType;
  requestId: string;
  userId: string;
  logger: OpenClawLogger;
  spendTracker: SpendTracker;
  degradeModeEnabled: boolean;
  stallConfig?: StallWatchdogConfig;
  killSwitchPath?: string;
  fileExists?: (path: string) => boolean;
}

// ── Result type ────────────────────────────────────────────────────────────

export interface ChatCompletionResult {
  provider_id: string;
  model: string;
  rawResponseText: string;
  inputUnits: number;
  outputUnits: number;
  estimatedCostUsd: number;
  outcome:
    | "success"
    | "provider_failure"
    | "budget_blocked"
    | "validation_blocked"
    | "stall_detected"
    | "registry_error";
}

// ── Internal: resolve from registry or use override ────────────────────────

function resolveForCall(
  opts: ChatCompletionOpts | VisionOpts,
  resolvedOverride?: Resolved,
): Resolved {
  if (resolvedOverride) return resolvedOverride;
  return resolve(opts.call_type);
}

function resolveApiKey(
  apiKeyEnv: string,
  resolvedOverride?: Resolved,
  legacyFallbackMap?: Readonly<Record<string, string>>,
): string {
  if (resolvedOverride) {
    // When using override (backward-compat adapter), read env var directly
    // with optional legacy fallback
    const value = process.env[apiKeyEnv];
    if (value !== undefined && value !== "") return value;
    if (legacyFallbackMap) {
      const legacy = legacyFallbackMap[apiKeyEnv];
      if (legacy) {
        const legacyValue = process.env[legacy];
        if (legacyValue !== undefined && legacyValue !== "") return legacyValue;
      }
    }
    throw new RegistryError(
      "missing_env_var",
      `Environment variable "${apiKeyEnv}" is not set`,
    );
  }
  return getApiKey(apiKeyEnv);
}

/** Legacy env-var fallback map for the backward-compat adapter path. */
const LEGACY_ENV_FALLBACK: Readonly<Record<string, string>> = {
  LLM_OMNIROUTE_API_KEY: "OMNIROUTE_API_KEY",
  LLM_FIREWORKS_API_KEY: "FIREWORKS_API_KEY",
};

// ── chatCompletion (C13 Stall Watchdog wraps HERE) ────────────────────────

export async function chatCompletion(
  opts: ChatCompletionOpts,
  ctx: LlmCallContext,
  resolvedOverride?: Resolved,
): Promise<ChatCompletionResult> {
  // Resolve provider config from registry (or use override)
  let resolved: Resolved;
  try {
    resolved = resolveForCall(opts, resolvedOverride);
  } catch {
    emitLog(
      ctx.logger,
      buildRedactedEvent(
        "error",
        "kbju-meal-logging",
        C23,
        KPI_EVENT_NAMES.provider_call_finished,
        ctx.requestId,
        ctx.userId,
        "registry_error",
        ctx.degradeModeEnabled,
        {
          call_type: opts.call_type,
          error_code: "registry_resolve_failed",
        },
      ),
    );
    return {
      provider_id: "unknown",
      model: "unknown",
      rawResponseText: "",
      inputUnits: 0,
      outputUnits: 0,
      estimatedCostUsd: 0,
      outcome: "registry_error",
    };
  }

  let apiKey: string;
  try {
    apiKey = resolveApiKey(
      resolved.api_key_env,
      resolvedOverride,
      resolvedOverride ? LEGACY_ENV_FALLBACK : undefined,
    );
  } catch {
    emitLog(
      ctx.logger,
      buildRedactedEvent(
        "error",
        "kbju-meal-logging",
        C23,
        KPI_EVENT_NAMES.provider_call_finished,
        ctx.requestId,
        ctx.userId,
        "registry_error",
        ctx.degradeModeEnabled,
        {
          call_type: opts.call_type,
          provider_alias: resolved.provider_id,
          error_code: "missing_env_var",
        },
      ),
    );
    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      rawResponseText: "",
      inputUnits: 0,
      outputUnits: 0,
      estimatedCostUsd: 0,
      outcome: "registry_error",
    };
  }

  // Kill switch check
  const killSwitchPath = ctx.killSwitchPath ?? KILL_SWITCH_DEFAULT_PATH;
  const fileExists = ctx.fileExists ?? (() => false);
  const killSwitchResult = checkKillSwitch(fileExists, killSwitchPath, Date.now);
  if (killSwitchResult.active) {
    if (killSwitchResult.event) {
      emitLog(
        ctx.logger,
        buildRedactedEvent(
          "warn",
          "kbju-meal-logging",
          "C13" as ComponentId,
          KPI_EVENT_NAMES.runtime_kill_switch_active,
          ctx.requestId,
          ctx.userId,
          "kill_switch_active",
          ctx.degradeModeEnabled,
          { kill_switch_path: killSwitchPath },
        ),
      );
    }
    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      rawResponseText: "",
      inputUnits: 0,
      outputUnits: 0,
      estimatedCostUsd: 0,
      outcome: "stall_detected",
    };
  }

  // Preflight cost check
  const preflight = await ctx.spendTracker.preflightCheck(ctx.callType);
  if (!preflight.allowed) {
    emitLog(
      ctx.logger,
      buildRedactedEvent(
        "warn",
        "kbju-meal-logging",
        C23,
        KPI_EVENT_NAMES.budget_blocked,
        ctx.requestId,
        ctx.userId,
        "budget_blocked",
        ctx.degradeModeEnabled,
        {
          call_type: opts.call_type,
          estimated_cost_usd: preflight.estimatedCallCostUsd,
          provider_alias: resolved.provider_id,
        },
      ),
    );
    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      rawResponseText: "",
      inputUnits: 0,
      outputUnits: 0,
      estimatedCostUsd: 0,
      outcome: "budget_blocked",
    };
  }

  // Stall watchdog setup
  const stallConfig = ctx.stallConfig ?? defaultStallWatchdogConfig();
  let stallRetryCount = 0;
  let stallWatchdog: StallWatchdog | null = null;

  // Build OpenAI-compatible request body
  const body: Record<string, unknown> = {
    model: resolved.model,
    messages: opts.messages,
  };
  if (opts.max_tokens !== undefined) body.max_tokens = opts.max_tokens;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.response_format !== undefined) body.response_format = opts.response_format;

  let responseText = "";
  let outcome: ChatCompletionResult["outcome"] = "success";
  let inputUnits = 0;
  let outputUnits = 0;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    stallWatchdog = new StallWatchdog(
      stallConfig,
      {
        now: Date.now,
        emit: (event: StallEvent) => {
          emitLog(
            ctx.logger,
            buildRedactedEvent(
              "warn",
              "kbju-meal-logging",
              "C13" as ComponentId,
              KPI_EVENT_NAMES.llm_call_stalled,
              ctx.requestId,
              ctx.userId,
              "stall_detected",
              ctx.degradeModeEnabled,
              {
                provider_alias: event.provider,
                model_alias: event.model,
                tenant_id: event.tenant_id,
                threshold_ms: event.threshold_ms,
                actual_stall_ms: event.actual_stall_ms,
                retry_count: event.retry_count,
              },
            ),
          );
        },
        abort: () => controller.abort(),
      },
      resolved.provider_id,
      resolved.model,
      ctx.userId,
    );

    stallWatchdog.start();

    const httpResponse = await fetch(`${resolved.base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (stallWatchdog.isStalled()) {
      stallWatchdog.stop();
      stallRetryCount++;
      if (stallRetryCount <= stallConfig.maxRetries) {
        return retryOnceChat(opts, ctx, resolved, apiKey, preflight);
      }
      return {
        provider_id: resolved.provider_id,
        model: resolved.model,
        rawResponseText: "",
        inputUnits: 0,
        outputUnits: 0,
        estimatedCostUsd: preflight.estimatedCallCostUsd,
        outcome: "stall_detected",
      };
    }

    stallWatchdog.touch();
    stallWatchdog.stop();

    if (!httpResponse.ok) {
      outcome = "provider_failure";
      const responseBody = await httpResponse.text().catch(() => "");
      const retryable = httpResponse.status >= 500 || httpResponse.status === 429;

      emitLog(
        ctx.logger,
        buildRedactedEvent(
          "warn",
          "kbju-meal-logging",
          C23,
          KPI_EVENT_NAMES.provider_call_finished,
          ctx.requestId,
          ctx.userId,
          "provider_failure",
          ctx.degradeModeEnabled,
          {
            call_type: opts.call_type,
            provider_alias: resolved.provider_id,
            model_alias: resolved.model,
            error_code: `http_${httpResponse.status}`,
          },
        ),
      );

      if (retryable) {
        return retryOnceChat(opts, ctx, resolved, apiKey, preflight);
      }

      return {
        provider_id: resolved.provider_id,
        model: resolved.model,
        rawResponseText: responseBody,
        inputUnits: 0,
        outputUnits: 0,
        estimatedCostUsd: preflight.estimatedCallCostUsd,
        outcome: "provider_failure",
      };
    }

    const json = (await httpResponse.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    responseText = json.choices?.[0]?.message?.content ?? "";
    inputUnits = json.usage?.prompt_tokens ?? 0;
    outputUnits = json.usage?.completion_tokens ?? 0;
  } catch (error) {
    outcome = "provider_failure";
    const isStallAbort =
      error instanceof DOMException &&
      error.name === "AbortError" &&
      stallWatchdog?.isStalled() === true;
    const errorCode =
      error instanceof Error && error.name === "AbortError"
        ? isStallAbort
          ? "stall_detected"
          : "timeout"
        : "fetch_error";

    if (stallWatchdog) {
      stallWatchdog.stop();
    }

    emitLog(
      ctx.logger,
      buildRedactedEvent(
        "warn",
        "kbju-meal-logging",
        isStallAbort ? ("C13" as ComponentId) : C23,
        isStallAbort
          ? KPI_EVENT_NAMES.llm_call_stalled
          : KPI_EVENT_NAMES.provider_call_finished,
        ctx.requestId,
        ctx.userId,
        isStallAbort ? "stall_detected" : "provider_failure",
        ctx.degradeModeEnabled,
        {
          call_type: opts.call_type,
          provider_alias: resolved.provider_id,
          model_alias: resolved.model,
          error_code: errorCode,
        },
      ),
    );

    if (isStallAbort) {
      stallRetryCount++;
      if (stallRetryCount <= stallConfig.maxRetries) {
        return retryOnceChat(opts, ctx, resolved, apiKey, preflight);
      }
      return {
        provider_id: resolved.provider_id,
        model: resolved.model,
        rawResponseText: "",
        inputUnits: 0,
        outputUnits: 0,
        estimatedCostUsd: preflight.estimatedCallCostUsd,
        outcome: "stall_detected",
      };
    }

    if (errorCode === "timeout") {
      return retryOnceChat(opts, ctx, resolved, apiKey, preflight);
    }

    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      rawResponseText: "",
      inputUnits: 0,
      outputUnits: 0,
      estimatedCostUsd: preflight.estimatedCallCostUsd,
      outcome: "provider_failure",
    };
  }

  const estimatedCost = preflight.estimatedCallCostUsd;
  await ctx.spendTracker.recordCostAndCheckBudget(estimatedCost, false);

  emitLog(
    ctx.logger,
    buildRedactedEvent(
      "info",
      "kbju-meal-logging",
      C23,
      KPI_EVENT_NAMES.provider_call_finished,
      ctx.requestId,
      ctx.userId,
      "success",
      ctx.degradeModeEnabled,
      {
        call_type: opts.call_type,
        provider_alias: resolved.provider_id,
        model_alias: resolved.model,
        estimated_cost_usd: estimatedCost,
      },
    ),
  );

  return {
    provider_id: resolved.provider_id,
    model: resolved.model,
    rawResponseText: responseText,
    inputUnits,
    outputUnits,
    estimatedCostUsd: estimatedCost,
    outcome,
  };
}

// ── vision (image_url content block in messages) ───────────────────────────

export async function vision(
  opts: VisionOpts,
  ctx: LlmCallContext,
  resolvedOverride?: Resolved,
): Promise<ChatCompletionResult> {
  // Build messages with image_url content block per OpenAI vision contract
  const visionMessages: Array<{ role: string; content: unknown }> =
    opts.messages.map((m) => ({ ...m }));

  // Replace the last user message with a multimodal content block
  const lastUserIdx = visionMessages.findLastIndex(
    (m) => m.role === "user",
  );
  if (lastUserIdx >= 0) {
    const textContent =
      typeof visionMessages[lastUserIdx].content === "string"
        ? visionMessages[lastUserIdx].content
        : "";
    visionMessages[lastUserIdx] = {
      role: "user",
      content: [
        { type: "text", text: textContent },
        {
          type: "image_url",
          image_url: { url: opts.image_url },
        },
      ],
    };
  } else {
    // Add a new user message with the image
    visionMessages.push({
      role: "user",
      content: [
        { type: "text", text: "" },
        {
          type: "image_url",
          image_url: { url: opts.image_url },
        },
      ],
    });
  }

  const chatOpts: ChatCompletionOpts = {
    call_type: opts.call_type,
    messages: visionMessages as Array<{ role: string; content: string }>,
    response_format: opts.response_format,
    max_tokens: opts.max_tokens,
    temperature: opts.temperature,
  };

  return chatCompletion(chatOpts, ctx, resolvedOverride);
}

// ── Retry helper ──────────────────────────────────────────────────────────

async function retryOnceChat(
  opts: ChatCompletionOpts,
  ctx: LlmCallContext,
  resolved: Resolved,
  apiKey: string,
  preflight: PreflightResult,
): Promise<ChatCompletionResult> {
  await new Promise((r) => setTimeout(r, 500));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

    const body: Record<string, unknown> = {
      model: resolved.model,
      messages: opts.messages,
    };
    if (opts.max_tokens !== undefined) body.max_tokens = opts.max_tokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.response_format !== undefined)
      body.response_format = opts.response_format;

    const httpResponse = await fetch(`${resolved.base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!httpResponse.ok) {
      return {
        provider_id: resolved.provider_id,
        model: resolved.model,
        rawResponseText: "",
        inputUnits: 0,
        outputUnits: 0,
        estimatedCostUsd: preflight.estimatedCallCostUsd,
        outcome: "provider_failure",
      };
    }

    const json = (await httpResponse.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const responseText = json.choices?.[0]?.message?.content ?? "";
    const inputUnits = json.usage?.prompt_tokens ?? 0;
    const outputUnits = json.usage?.completion_tokens ?? 0;
    const estimatedCost = preflight.estimatedCallCostUsd;

    await ctx.spendTracker.recordCostAndCheckBudget(estimatedCost, false);

    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      rawResponseText: responseText,
      inputUnits,
      outputUnits,
      estimatedCostUsd: estimatedCost,
      outcome: "success",
    };
  } catch {
    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      rawResponseText: "",
      inputUnits: 0,
      outputUnits: 0,
      estimatedCostUsd: preflight.estimatedCallCostUsd,
      outcome: "provider_failure",
    };
  }
}

// ── Utility: safe-for-logging check ────────────────────────────────────────

export function isPromptOrResponseSafeForLogging(
  obj: Record<string, unknown>,
): boolean {
  for (const forbidden of LOG_FORBIDDEN_FIELDS) {
    if (forbidden in obj) {
      return false;
    }
  }
  if (
    "prompt" in obj ||
    "system_prompt" in obj ||
    "provider_response_raw" in obj
  ) {
    return false;
  }
  return true;
}
