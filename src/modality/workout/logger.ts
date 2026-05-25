/**
 * C19 Workout Logger — persist workout events per ARCH-001@0.6.2 §3.19
 * and PRD-003@0.1.3 §5 US-3.
 *
 * Entry point: handleWorkoutEvent(input) → WorkoutReply
 *
 * Flow:
 * 1. Check settings: if workout_on === false → return OFF-state reply (silent).
 * 2. For source=text: free-form Russian text → call extractWorkoutFromText (LLM with forced-output) → validate → persist.
 * 3. For source=voice: transcribed text → same path as 'text' but with source='voice' on persist.
 * 4. For source=photo: Telegram photo file_id → fetch image bytes → call extractWorkoutFromPhoto (vision LLM) → validate → persist.
 * 5. Emit kbju_modality_event_persisted telemetry with {modality, source} labels.
 * 6. Return Russian confirmation reply.
 */

import type { TenantStore, WorkoutEventSource } from "../../store/types.js";
import type { MetricsRegistry } from "../../observability/metricsEndpoint.js";
import type { OpenClawLogger, ComponentId } from "../../shared/types.js";
import { PROMETHEUS_METRIC_NAMES, KPI_EVENT_NAMES } from "../../observability/kpiEvents.js";
import { buildRedactedEvent, emitLog } from "../../observability/events.js";
import type { ModalitySettings } from "../settings/service.js";
import {
  extractWorkoutFromText,
  extractWorkoutFromPhoto,
  ExtractorConfigLoader,
  type WorkoutExtractorConfig,
} from "./extractWorkout.js";
import {
  validateWorkout,
  type RawWorkoutExtraction,
  type WorkoutType,
} from "./validator.js";
import {
  buildWorkoutSuccessReply,
  AMBIGUOUS_REPLY,
  PHOTO_AMBIGUOUS_REPLY,
  MISSING_FIELDS_REPLY,
  OFF_STATE_REPLY,
} from "./copy.ru.js";
import type { SpendTracker } from "../../observability/costGuard.js";

// ── Public types ────────────────────────────────────────────────────────────

/** Input to the workout handler. */
export interface WorkoutHandlerInput {
  userId: string;
  /** Source: text for typed text, voice for voice-transcribed text, photo for Telegram photo */
  source: "text" | "voice" | "photo";
  /** For source=text|voice: the raw text from the user / transcription */
  rawText?: string;
  /** For source=photo: Telegram photo file_id to download */
  photoFileId?: string;
  /** Request ID for observability */
  requestId: string;
}

/** Result of handling a workout event. */
export interface WorkoutReply {
  text: string;
  persisted: boolean;
}

// ── Confidence threshold ────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.5;

// C19 component ID for observability
const C19 = "C19" as ComponentId;

// ── Photo download helper ───────────────────────────────────────────────────

/**
 * Download a Telegram photo by file_id and return base64-encoded bytes.
 * Uses the Telegram Bot API file endpoint.
 */
async function downloadTelegramPhoto(fileId: string): Promise<string> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN not set — cannot download photo");
  }

  // Step 1: Get file path from Telegram API
  const fileinfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
  const fileinfoResp = await fetch(fileinfoUrl);
  if (!fileinfoResp.ok) {
    throw new Error(`Telegram getFile failed: ${fileinfoResp.status}`);
  }
  const fileinfo = await fileinfoResp.json() as { ok: boolean; result?: { file_path: string } };
  if (!fileinfo.ok || !fileinfo.result?.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }

  // Step 2: Download the actual file
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileinfo.result.file_path}`;
  const downloadResp = await fetch(downloadUrl);
  if (!downloadResp.ok) {
    throw new Error(`Telegram file download failed: ${downloadResp.status}`);
  }

  const arrayBuffer = await downloadResp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return buffer.toString("base64");
}

// ── Handler ─────────────────────────────────────────────────────────────────

/**
 * Handle a workout event: extract type + fields, validate, persist, reply.
 *
 * Dependencies are injected for testability.
 */
export async function handleWorkoutEvent(
  input: WorkoutHandlerInput,
  store: TenantStore,
  settings: ModalitySettings,
  extractorConfigLoader: ExtractorConfigLoader,
  metrics: MetricsRegistry,
  logger: OpenClawLogger,
  spendTracker: SpendTracker,
  degradeModeEnabled: boolean = false,
  /** Injected for testing: replaces Telegram photo download */
  photoDownloader?: (fileId: string) => Promise<string>,
): Promise<WorkoutReply> {
  // 1. Check settings: if workout_on === false → silent skip per §6.2.2
  if (!settings.workoutOn) {
    return { text: OFF_STATE_REPLY, persisted: false };
  }

  const config = extractorConfigLoader.getConfig();
  if (!config) {
    logger.error("workout extractor config not available");
    return { text: AMBIGUOUS_REPLY, persisted: false };
  }

  // 2. Extract based on source
  let extraction: import("./extractWorkout.js").ExtractWorkoutResult;
  let sourceLabel: WorkoutEventSource;
  let rawTextForDb: string | null = null;
  let rawDescriptionForDb: string | null = null;

  if (input.source === "photo") {
    sourceLabel = "photo";
    if (!input.photoFileId) {
      return { text: PHOTO_AMBIGUOUS_REPLY, persisted: false };
    }

    let imageBase64: string;
    try {
      imageBase64 = photoDownloader
        ? await photoDownloader(input.photoFileId)
        : await downloadTelegramPhoto(input.photoFileId);
    } catch (err) {
      logger.warn(`workout photo download failed: ${err instanceof Error ? err.message : String(err)}`);
      return { text: PHOTO_AMBIGUOUS_REPLY, persisted: false };
    }

    extraction = await extractWorkoutFromPhoto(
      imageBase64,
      config,
      input.requestId,
      input.userId,
      logger,
      metrics,
      spendTracker,
      degradeModeEnabled,
    );
  } else {
    // text or voice
    sourceLabel = input.source;
    const text = input.rawText ?? "";
    if (!text.trim()) {
      return { text: MISSING_FIELDS_REPLY, persisted: false };
    }

    rawTextForDb = text;
    extraction = await extractWorkoutFromText(
      text,
      config,
      input.requestId,
      input.userId,
      logger,
      metrics,
      spendTracker,
      degradeModeEnabled,
    );
  }

  // 3. Check extraction result
  if (extraction.modelTier === "failure" || extraction.workoutType === null) {
    const reply = input.source === "photo" ? PHOTO_AMBIGUOUS_REPLY : AMBIGUOUS_REPLY;
    return { text: reply, persisted: false };
  }

  // 4. Soft confidence gate (0.5 threshold per ticket §2)
  if (extraction.confidence < CONFIDENCE_THRESHOLD) {
    const reply = input.source === "photo" ? PHOTO_AMBIGUOUS_REPLY : AMBIGUOUS_REPLY;
    return { text: reply, persisted: false };
  }

  // 5. Deterministic validation (ADR-006 strict-keys + ADR-016 closed-enum)
  const rawExtraction: RawWorkoutExtraction = {
    workout_type: extraction.workoutType,
    duration_min: extraction.durationMin,
    distance_km: extraction.distanceKm,
    sets: extraction.sets,
    repetitions: extraction.reps,
    confidence: extraction.confidence,
  };

  const validation = validateWorkout(rawExtraction);
  if (!validation.valid || validation.normalized === null) {
    const reply = input.source === "photo" ? PHOTO_AMBIGUOUS_REPLY : AMBIGUOUS_REPLY;
    return { text: reply, persisted: false };
  }

  const normalized = validation.normalized;

  // 6. Persist to workout_events
  const eventId = await store.insertWorkoutEvent(
    input.userId,
    sourceLabel,
    normalized.workoutType,
    normalized.durationMin,
    normalized.distanceKm,
    normalized.sets,
    normalized.reps,
    rawTextForDb,
    rawDescriptionForDb,
  );

  // 7. Emit telemetry
  metrics.increment(PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted, {
    modality: "workout",
    source: sourceLabel,
  });

  emitLog(logger, buildRedactedEvent(
    "info",
    "kbju-workout-logging",
    C19,
    KPI_EVENT_NAMES.modality_event_persisted,
    input.requestId,
    input.userId,
    "success",
    degradeModeEnabled,
    {
      modality: "workout",
      source: sourceLabel,
      event_id: eventId.event_id,
    },
  ));

  // 8. Build Russian reply
  const replyText = buildWorkoutSuccessReply({
    workoutType: normalized.workoutType,
    durationMin: normalized.durationMin,
    distanceKm: normalized.distanceKm,
    sets: normalized.sets,
    reps: normalized.reps,
  });

  return { text: replyText, persisted: true };
}
