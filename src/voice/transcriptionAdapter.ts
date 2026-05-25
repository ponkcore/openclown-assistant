/**
 * C5 Voice Transcription Adapter — wraps voiceClient.ts
 *
 * This module preserves the existing C5 contract surface:
 *   - Duration check (>15s rejection)
 *   - Budget check (SpendTracker preflight)
 *   - Raw audio deletion obligation
 *   - Retry orchestration at the adapter level is removed;
 *     retry now lives inside voiceClient.ts (ONE retry on transport failure)
 *
 * The actual HTTP call to the provider's `POST /v1/audio/transcriptions`
 * endpoint is delegated to voiceClient.transcribe(), which resolves
 * the provider from the registry per ADR-023@0.1.0 and ADR-024@0.1.0.
 *
 * Per TKT-034@0.1.0: "Do NOT change the C5 contract surface
 *   (transcript text + duration metadata + raw-audio deletion obligation).
 *   This is an indirection swap, not a feature change."
 */

import { readFile } from "node:fs/promises";
import type { ProviderAlias } from "../shared/types.js";
import type { PreflightResult } from "../observability/costGuard.js";
import { buildRedactedEvent, emitLog } from "../observability/events.js";
import { KPI_EVENT_NAMES } from "../observability/kpiEvents.js";
import { MSG_VOICE_TOO_LONG } from "../telegram/messages.js";
import {
  MAX_VOICE_DURATION_SECONDS,
  type TranscriptionConfig,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "./types.js";
import {
  transcribe as voiceTranscribe,
  type TranscribeOpts,
  type VoiceCallContext,
} from "./voiceClient.js";
import type { Resolved } from "../llm/registry.js";

async function defaultAudioFileReader(filePath: string): Promise<Uint8Array> {
  const buffer = await readFile(filePath);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export class DurationExceededError extends Error {
  public readonly durationSeconds: number;
  public readonly maxDurationSeconds: number;

  constructor(durationSeconds: number) {
    super(
      `Voice duration ${durationSeconds}s exceeds maximum ${MAX_VOICE_DURATION_SECONDS}s`
    );
    this.name = "DurationExceededError";
    this.durationSeconds = durationSeconds;
    this.maxDurationSeconds = MAX_VOICE_DURATION_SECONDS;
  }
}

/**
 * Build a Resolved override from the legacy TranscriptionConfig so that
 * callers who pass explicit config (without the registry) continue to work.
 */
function buildResolvedFromConfig(config: TranscriptionConfig): Resolved {
  return {
    provider_id: config.providerAlias,
    base_url: `${config.baseUrl}/v1`,
    api_key_env: `LLM_${config.providerAlias.toUpperCase()}_API_KEY`,
    model: config.modelAlias,
  };
}

export async function transcribeVoice(
  config: TranscriptionConfig,
  request: TranscriptionRequest,
  resolvedOverride?: Resolved,
): Promise<TranscriptionResult> {
  const startTime = Date.now();
  const readAudio = request.audioFileReader ?? defaultAudioFileReader;

  // ── Duration check (>15s rejection) — C5 contract ──────────────────────
  if (request.durationSeconds > MAX_VOICE_DURATION_SECONDS) {
    emitLog(
      request.logger,
      buildRedactedEvent(
        "info",
        "kbju-meal-logging",
        "C5",
        KPI_EVENT_NAMES.voice_transcription_failed,
        request.requestId,
        request.userId,
        "user_fallback",
        request.degradeModeEnabled,
        {
          provider_alias: config.providerAlias,
          duration_seconds: request.durationSeconds,
        }
      )
    );

    await safeDeleteAudio(request, config.providerAlias);

    return {
      providerAlias: config.providerAlias,
      modelAlias: config.modelAlias,
      transcriptText: MSG_VOICE_TOO_LONG,
      confidence: null,
      estimatedCostUsd: 0,
      outcome: "duration_exceeded",
      audioDeleted: true,
    };
  }

  // ── Budget check (SpendTracker preflight) — C5 contract ────────────────
  const preflight = await request.spendTracker.preflightCheck("transcription");
  if (!preflight.allowed) {
    emitLog(
      request.logger,
      buildRedactedEvent(
        "warn",
        "kbju-meal-logging",
        "C5",
        KPI_EVENT_NAMES.budget_blocked,
        request.requestId,
        request.userId,
        "budget_blocked",
        request.degradeModeEnabled,
        {
          call_type: "transcription",
          estimated_cost_usd: preflight.estimatedCallCostUsd,
          provider_alias: config.providerAlias,
        }
      )
    );

    await safeDeleteAudio(request, config.providerAlias);

    return {
      providerAlias: config.providerAlias,
      modelAlias: config.modelAlias,
      transcriptText: "",
      confidence: null,
      estimatedCostUsd: 0,
      outcome: "budget_blocked",
      audioDeleted: true,
    };
  }

  // ── Read audio file ────────────────────────────────────────────────────
  const audioBytes = await readAudio(request.audioFilePath);

  // ── Delegate HTTP call to voiceClient ──────────────────────────────────
  // Use resolvedOverride if provided (registry-based); otherwise build one
  // from the legacy TranscriptionConfig so existing callers continue to work.
  const resolved = resolvedOverride ?? buildResolvedFromConfig(config);

  const voiceOpts: TranscribeOpts = {
    call_type: "kbju.voice_transcription",
    audio_buffer: audioBytes,
    audio_mime: "audio/ogg",
    audio_filename: "voice.ogg",
    language: config.languageHint,
  };

  const voiceCtx: VoiceCallContext = {
    apiKeyOverride: config.apiKey,
    requestId: request.requestId,
    userId: request.userId,
    logger: request.logger,
  };

  const voiceResult = await voiceTranscribe(voiceOpts, voiceCtx, resolved);

  // ── Process result ─────────────────────────────────────────────────────
  if (voiceResult.outcome === "success") {
    await request.spendTracker.recordCostAndCheckBudget(
      preflight.estimatedCallCostUsd,
      false
    );

    const deletionOk = await safeDeleteAudio(request, config.providerAlias);

    const latencyMs = Date.now() - startTime;

    emitLog(
      request.logger,
      buildRedactedEvent(
        "info",
        "kbju-meal-logging",
        "C5",
        KPI_EVENT_NAMES.voice_transcription_completed,
        request.requestId,
        request.userId,
        "success",
        request.degradeModeEnabled,
        {
          call_type: "transcription",
          provider_alias: config.providerAlias,
          model_alias: config.modelAlias,
          estimated_cost_usd: preflight.estimatedCallCostUsd,
          latency_ms: latencyMs,
        }
      )
    );

    return {
      providerAlias: config.providerAlias,
      modelAlias: config.modelAlias,
      transcriptText: voiceResult.transcriptText,
      confidence: null,
      estimatedCostUsd: preflight.estimatedCallCostUsd,
      outcome: "success",
      audioDeleted: deletionOk,
    };
  }

  // ── Failure path — delete audio, return failure ────────────────────────
  await safeDeleteAudio(request, config.providerAlias);

  return {
    providerAlias: config.providerAlias,
    modelAlias: config.modelAlias,
    transcriptText: "",
    confidence: null,
    estimatedCostUsd: preflight.estimatedCallCostUsd,
    outcome: "provider_failure",
    audioDeleted: true,
  };
}

async function safeDeleteAudio(
  request: TranscriptionRequest,
  providerAlias: ProviderAlias
): Promise<boolean> {
  try {
    await request.deleteAudioFile();
    return true;
  } catch {
    emitLog(
      request.logger,
      buildRedactedEvent(
        "critical",
        "kbju-meal-logging",
        "C5",
        KPI_EVENT_NAMES.raw_media_delete_failed,
        request.requestId,
        request.userId,
        "provider_failure",
        request.degradeModeEnabled,
        {
          call_type: "transcription",
          provider_alias: providerAlias,
        }
      )
    );
    return false;
  }
}
