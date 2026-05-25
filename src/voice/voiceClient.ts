/**
 * C5 Voice Transcription — Provider-agnostic OpenAI-compatible HTTP client
 *
 * Per ADR-023@0.1.0: single client that speaks the OpenAI
 * `POST /v1/audio/transcriptions` HTTP surface.
 * Per ADR-024@0.1.0: provider config from registry via `kbju.voice_transcription` alias.
 *
 * Request shape (ADR-023@0.1.0 — character-for-character):
 *   transcribe: { audio_buffer, language?, prompt?, temperature? }
 *
 * C13 Stall Watchdog (ADR-012@0.1.0) wraps transcribe — ONE place.
 * Retry: ONE max, only on transport failure, only inside latency cap
 *   (PRD-001@0.3.0 §G3).
 * All log emits pass through redactPii.
 */

import type { OpenClawLogger, ComponentId } from "../shared/types.js";
import { buildRedactedEvent, emitLog } from "../observability/events.js";
import { KPI_EVENT_NAMES } from "../observability/kpiEvents.js";
import {
  StallWatchdog,
  defaultStallWatchdogConfig,
  checkKillSwitch,
  KILL_SWITCH_DEFAULT_PATH,
  type StallWatchdogConfig,
  type StallEvent,
} from "../observability/stallWatchdog.js";
import { resolve, getApiKey } from "../llm/registry.js";
import type { Resolved } from "../llm/registry.js";
import { RegistryError } from "../llm/registry.js";
import {
  VOICE_LATENCY_BUDGET_MS,
  TRANSCRIPTION_TIMEOUT_MS,
  TRANSCRIPTION_RETRY_DELAY_MS,
} from "./types.js";

// C5 component ID for observability
const C5 = "C5" as ComponentId;

// ── Request shape (ADR-023@0.1.0 character-for-character) ──────────────────

export interface TranscribeOpts {
  /** Call-type alias for registry resolution. Default: "kbju.voice_transcription" */
  call_type?: string;
  /** Raw audio bytes */
  audio_buffer: Uint8Array;
  /** MIME type for the audio (e.g. "audio/ogg", "audio/wav") */
  audio_mime: string;
  /** Filename for the form-data part (e.g. "voice.ogg") */
  audio_filename: string;
  /** Language hint. Default: "ru" for v0.1 (ADR-023@0.1.0 §Decision) */
  language?: string;
  /** Optional prompt hint for the model */
  prompt?: string;
  /** Optional temperature */
  temperature?: number;
}

// ── Call context (runtime plumbing, not part of the HTTP request shape) ────

export interface VoiceCallContext {
  requestId: string;
  userId: string;
  logger: OpenClawLogger;
  stallConfig?: StallWatchdogConfig;
  killSwitchPath?: string;
  fileExists?: (path: string) => boolean;
  /**
   * Direct API key override. When set (typically via resolvedOverride path),
   * this key is used instead of reading from process.env[api_key_env].
   * This allows backward-compat adapters that hold an explicit key string
   * to bypass the env-var lookup.
   */
  apiKeyOverride?: string;
}

// ── Result type ────────────────────────────────────────────────────────────

export type TranscribeOutcome =
  | "success"
  | "provider_failure"
  | "stall_detected"
  | "registry_error";

export interface TranscribeResult {
  provider_id: string;
  model: string;
  transcriptText: string;
  /** Provider-specific extra fields from the JSON response — telemetry only,
   *  never returned to the application's transcript path (ADR-023@0.1.0 §Decision). */
  provider_extras: Record<string, unknown>;
  estimatedCostUsd: number;
  outcome: TranscribeOutcome;
  latencyMs: number;
}

// ── auth_header_template helper (ADR-024@0.1.0 §Schema + ADR-023@0.1.0) ───

/**
 * Build the Authorization header value from the resolved config.
 * If `auth_header_template` is set (e.g. `"Token {key}"` for Deepgram shim),
 * replace `{key}` with the actual API key. Otherwise, use the default
 * OpenAI Bearer pattern: `Bearer <key>`.
 */
export function buildAuthHeader(resolved: Resolved, apiKey: string): string {
  if (resolved.auth_header_template) {
    return resolved.auth_header_template.replace("{key}", apiKey);
  }
  return `Bearer ${apiKey}`;
}

// ── Internal: resolve from registry or use override ────────────────────────

function resolveForCall(
  callType: string,
  resolvedOverride?: Resolved,
): Resolved {
  if (resolvedOverride) return resolvedOverride;
  return resolve(callType);
}

function resolveApiKey(
  apiKeyEnv: string,
  resolvedOverride?: Resolved,
  apiKeyOverride?: string,
): string {
  // Direct key override takes precedence (backward-compat adapter path)
  if (apiKeyOverride !== undefined && apiKeyOverride !== "") return apiKeyOverride;

  if (resolvedOverride) {
    const value = process.env[apiKeyEnv];
    if (value !== undefined && value !== "") return value;
    throw new RegistryError(
      "missing_env_var",
      `Environment variable "${apiKeyEnv}" is not set`,
    );
  }
  return getApiKey(apiKeyEnv);
}

// ── transcribe (C13 Stall Watchdog wraps HERE — ONE place) ─────────────────

export async function transcribe(
  opts: TranscribeOpts,
  ctx: VoiceCallContext,
  resolvedOverride?: Resolved,
): Promise<TranscribeResult> {
  const callType = opts.call_type ?? "kbju.voice_transcription";
  const startTime = Date.now();

  // ── Resolve provider config from registry (or use override) ────────────
  let resolved: Resolved;
  try {
    resolved = resolveForCall(callType, resolvedOverride);
  } catch {
    emitLog(
      ctx.logger,
      buildRedactedEvent(
        "error",
        "kbju-meal-logging",
        C5,
        KPI_EVENT_NAMES.provider_call_finished,
        ctx.requestId,
        ctx.userId,
        "registry_error",
        false,
        { call_type: callType, error_code: "registry_resolve_failed" },
      ),
    );
    return {
      provider_id: "unknown",
      model: "unknown",
      transcriptText: "",
      provider_extras: {},
      estimatedCostUsd: 0,
      outcome: "registry_error",
      latencyMs: Date.now() - startTime,
    };
  }

  // ── Resolve API key ────────────────────────────────────────────────────
  let apiKey: string;
  try {
    apiKey = resolveApiKey(
      resolved.api_key_env,
      resolvedOverride,
      ctx.apiKeyOverride,
    );
  } catch {
    emitLog(
      ctx.logger,
      buildRedactedEvent(
        "error",
        "kbju-meal-logging",
        C5,
        KPI_EVENT_NAMES.provider_call_finished,
        ctx.requestId,
        ctx.userId,
        "registry_error",
        false,
        {
          call_type: callType,
          provider_alias: resolved.provider_id,
          error_code: "missing_env_var",
        },
      ),
    );
    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      transcriptText: "",
      provider_extras: {},
      estimatedCostUsd: 0,
      outcome: "registry_error",
      latencyMs: Date.now() - startTime,
    };
  }

  // ── Kill switch check (ADR-012@0.1.0) ─────────────────────────────────
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
          false,
          { kill_switch_path: killSwitchPath },
        ),
      );
    }
    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      transcriptText: "",
      provider_extras: {},
      estimatedCostUsd: 0,
      outcome: "stall_detected",
      latencyMs: Date.now() - startTime,
    };
  }

  // ── Stall watchdog setup ───────────────────────────────────────────────
  const stallConfig = ctx.stallConfig ?? defaultStallWatchdogConfig();

  // ── Build auth header using template knob (ADR-024@0.1.0) ────────────
  const authHeader = buildAuthHeader(resolved, apiKey);

  // ── Build multipart form data (ADR-023@0.1.0 §Decision) ──────────────
  const language = opts.language ?? "ru";
  const audioBlob = new Blob([opts.audio_buffer.slice().buffer], { type: opts.audio_mime });
  const formData = new FormData();
  formData.append("file", audioBlob, opts.audio_filename);
  formData.append("model", resolved.model);
  formData.append("language", language);
  formData.append("response_format", "json");
  if (opts.prompt !== undefined) formData.append("prompt", opts.prompt);
  if (opts.temperature !== undefined)
    formData.append("temperature", String(opts.temperature));

  // ── Emit provider_call_started ────────────────────────────────────────
  emitLog(
    ctx.logger,
    buildRedactedEvent(
      "info",
      "kbju-meal-logging",
      C5,
      KPI_EVENT_NAMES.provider_call_started,
      ctx.requestId,
      ctx.userId,
      "success",
      false,
      {
        call_type: callType,
        provider_alias: resolved.provider_id,
        model_alias: resolved.model,
      },
    ),
  );

  // ── HTTP call with stall watchdog ─────────────────────────────────────
  let stallRetryCount = 0;
  let stallWatchdog: StallWatchdog | null = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);

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
              false,
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

    const httpResponse = await fetch(
      `${resolved.base_url}/audio/transcriptions`,
      {
        method: "POST",
        headers: { Authorization: authHeader },
        body: formData,
        signal: controller.signal,
      },
    );

    clearTimeout(timer);

    if (stallWatchdog.isStalled()) {
      stallWatchdog.stop();
      stallRetryCount++;
      if (stallRetryCount <= stallConfig.maxRetries) {
        return retryOnceTranscribe(
          opts, ctx, resolved, authHeader, startTime,
        );
      }
      return {
        provider_id: resolved.provider_id,
        model: resolved.model,
        transcriptText: "",
        provider_extras: {},
        estimatedCostUsd: 0,
        outcome: "stall_detected",
        latencyMs: Date.now() - startTime,
      };
    }

    stallWatchdog.touch();
    stallWatchdog.stop();

    if (!httpResponse.ok) {
      const retryable = httpResponse.status >= 500 || httpResponse.status === 429;

      emitLog(
        ctx.logger,
        buildRedactedEvent(
          "warn",
          "kbju-meal-logging",
          C5,
          KPI_EVENT_NAMES.provider_call_finished,
          ctx.requestId,
          ctx.userId,
          "provider_failure",
          false,
          {
            call_type: callType,
            provider_alias: resolved.provider_id,
            model_alias: resolved.model,
            error_code: `http_${httpResponse.status}`,
          },
        ),
      );

      // ONE retry on transport failure, only inside latency cap
      if (retryable && isWithinLatencyBudget(startTime)) {
        return retryOnceTranscribe(
          opts, ctx, resolved, authHeader, startTime,
        );
      }

      return {
        provider_id: resolved.provider_id,
        model: resolved.model,
        transcriptText: "",
        provider_extras: {},
        estimatedCostUsd: 0,
        outcome: "provider_failure",
        latencyMs: Date.now() - startTime,
      };
    }

    // ── Parse response ──────────────────────────────────────────────────
    const json = (await httpResponse.json()) as Record<string, unknown>;
    const transcriptText = typeof json.text === "string" ? json.text : "";

    // provider_extras: everything except "text" — telemetry only
    const { text: _text, ...extras } = json;
    const providerExtras = extras as Record<string, unknown>;

    const latencyMs = Date.now() - startTime;

    emitLog(
      ctx.logger,
      buildRedactedEvent(
        "info",
        "kbju-meal-logging",
        C5,
        KPI_EVENT_NAMES.voice_transcription_completed,
        ctx.requestId,
        ctx.userId,
        "success",
        false,
        {
          call_type: callType,
          provider_alias: resolved.provider_id,
          model_alias: resolved.model,
          latency_ms: latencyMs,
        },
      ),
    );

    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      transcriptText,
      provider_extras: providerExtras,
      estimatedCostUsd: 0, // cost tracking is the wrapping component's job
      outcome: "success",
      latencyMs,
    };
  } catch (error) {
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
        isStallAbort ? ("C13" as ComponentId) : C5,
        isStallAbort
          ? KPI_EVENT_NAMES.llm_call_stalled
          : KPI_EVENT_NAMES.provider_call_finished,
        ctx.requestId,
        ctx.userId,
        isStallAbort ? "stall_detected" : "provider_failure",
        false,
        {
          call_type: callType,
          provider_alias: resolved.provider_id,
          model_alias: resolved.model,
          error_code: errorCode,
        },
      ),
    );

    // Stall abort → retry once if within budget
    if (isStallAbort) {
      stallRetryCount++;
      if (stallRetryCount <= stallConfig.maxRetries) {
        return retryOnceTranscribe(
          opts, ctx, resolved, authHeader, startTime,
        );
      }
      return {
        provider_id: resolved.provider_id,
        model: resolved.model,
        transcriptText: "",
        provider_extras: {},
        estimatedCostUsd: 0,
        outcome: "stall_detected",
        latencyMs: Date.now() - startTime,
      };
    }

    // Transport failure (timeout / fetch_error) → retry once if within budget
    if (
      (errorCode === "timeout" || errorCode === "fetch_error") &&
      isWithinLatencyBudget(startTime)
    ) {
      return retryOnceTranscribe(
        opts, ctx, resolved, authHeader, startTime,
      );
    }

    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      transcriptText: "",
      provider_extras: {},
      estimatedCostUsd: 0,
      outcome: "provider_failure",
      latencyMs: Date.now() - startTime,
    };
  }
}

// ── Latency budget check (PRD-001@0.3.0 §G3) ──────────────────────────────

function isWithinLatencyBudget(startTime: number): boolean {
  return Date.now() - startTime < VOICE_LATENCY_BUDGET_MS;
}

// ── Retry helper (ONE retry on transport failure, inside latency cap) ──────

async function retryOnceTranscribe(
  opts: TranscribeOpts,
  ctx: VoiceCallContext,
  resolved: Resolved,
  authHeader: string,
  startTime: number,
): Promise<TranscribeResult> {
  await new Promise((r) => setTimeout(r, TRANSCRIPTION_RETRY_DELAY_MS));

  // If latency budget already exceeded, don't retry
  if (!isWithinLatencyBudget(startTime)) {
    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      transcriptText: "",
      provider_extras: {},
      estimatedCostUsd: 0,
      outcome: "provider_failure",
      latencyMs: Date.now() - startTime,
    };
  }

  // Resolve API key for retry (same as initial call)
  let apiKey: string;
  try {
    apiKey = resolveApiKey(
      resolved.api_key_env,
      resolved,
      ctx.apiKeyOverride,
    );
  } catch {
    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      transcriptText: "",
      provider_extras: {},
      estimatedCostUsd: 0,
      outcome: "registry_error",
      latencyMs: Date.now() - startTime,
    };
  }

  // Rebuild auth header for retry (may differ if template uses key)
  const retryAuthHeader = buildAuthHeader(resolved, apiKey);

  // Rebuild form data (FormData is consumed after fetch)
  const language = opts.language ?? "ru";
  const audioBlob = new Blob([opts.audio_buffer.slice().buffer], { type: opts.audio_mime });
  const formData = new FormData();
  formData.append("file", audioBlob, opts.audio_filename);
  formData.append("model", resolved.model);
  formData.append("language", language);
  formData.append("response_format", "json");
  if (opts.prompt !== undefined) formData.append("prompt", opts.prompt);
  if (opts.temperature !== undefined)
    formData.append("temperature", String(opts.temperature));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);

    const httpResponse = await fetch(
      `${resolved.base_url}/audio/transcriptions`,
      {
        method: "POST",
        headers: { Authorization: retryAuthHeader },
        body: formData,
        signal: controller.signal,
      },
    );

    clearTimeout(timer);

    if (!httpResponse.ok) {
      return {
        provider_id: resolved.provider_id,
        model: resolved.model,
        transcriptText: "",
        provider_extras: {},
        estimatedCostUsd: 0,
        outcome: "provider_failure",
        latencyMs: Date.now() - startTime,
      };
    }

    const json = (await httpResponse.json()) as Record<string, unknown>;
    const transcriptText = typeof json.text === "string" ? json.text : "";
    const { text: _text, ...extras } = json;
    const providerExtras = extras as Record<string, unknown>;

    const latencyMs = Date.now() - startTime;

    emitLog(
      ctx.logger,
      buildRedactedEvent(
        "info",
        "kbju-meal-logging",
        C5,
        KPI_EVENT_NAMES.voice_transcription_completed,
        ctx.requestId,
        ctx.userId,
        "success",
        false,
        {
          call_type: opts.call_type ?? "kbju.voice_transcription",
          provider_alias: resolved.provider_id,
          model_alias: resolved.model,
          latency_ms: latencyMs,
        },
      ),
    );

    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      transcriptText,
      provider_extras: providerExtras,
      estimatedCostUsd: 0,
      outcome: "success",
      latencyMs,
    };
  } catch {
    return {
      provider_id: resolved.provider_id,
      model: resolved.model,
      transcriptText: "",
      provider_extras: {},
      estimatedCostUsd: 0,
      outcome: "provider_failure",
      latencyMs: Date.now() - startTime,
    };
  }
}
