/**
 * C17 Water Logger — persist water intake events per ARCH-001@0.6.2 §3.17
 * and PRD-003@0.1.3 §5 US-1.
 *
 * Entry point: handleWaterEvent(input) → WaterReply
 *
 * Flow:
 * 1. Check settings: if water_on === false → return OFF-state reply.
 * 2. For source=keyboard with presetMl: validate range, persist directly.
 * 3. For source=text|voice with rawText: extract volume via LLM (extractVolumeFromText),
 *    reject low-confidence or out-of-range, persist on success.
 * 4. Emit kbju_modality_event_persisted telemetry with {modality, source} labels.
 * 5. Return Russian confirmation reply.
 */

import type { TenantStore, WaterEventSource } from "../../store/types.js";
import type { MetricsRegistry } from "../../observability/metricsEndpoint.js";
import type { OpenClawLogger, ComponentId } from "../../shared/types.js";
import { PROMETHEUS_METRIC_NAMES, KPI_EVENT_NAMES } from "../../observability/kpiEvents.js";
import { buildRedactedEvent, emitLog } from "../../observability/events.js";
import type { ModalitySettings } from "../settings/service.js";
import {
  extractVolumeFromText,
  ExtractorConfigLoader,
} from "./extractVolume.js";
import {
  SUCCESS_REPLY,
  OUT_OF_RANGE_REPLY,
  OFF_STATE_REPLY,
  LOW_CONFIDENCE_REPLY,
} from "./copy.ru.js";
import { buildWaterKeyboard } from "./keyboard.js";

// ── Public types ──────────────────────────────────────────────────────────

/** The modality label enum for telemetry — closed set per PRD-003. */
export type ModalityLabel = "water" | "sleep" | "workout" | "mood";

/** The source enum for telemetry — closed set per PRD-003. */
export type SourceLabel = "text" | "voice" | "keyboard" | "photo";

/** Input to the water handler. */
export interface WaterEventInput {
  userId: string;
  source: "text" | "voice" | "keyboard";
  rawText?: string;
  presetMl?: number;
  requestId: string;
}

/** Result of handling a water event. */
export interface WaterReply {
  text: string;
  keyboard?: unknown;
  persisted: boolean;
  volumeMl?: number;
}

// ── Sanity bounds ─────────────────────────────────────────────────────────

const VOLUME_MIN = 1;
const VOLUME_MAX = 5000;
const CONFIDENCE_THRESHOLD = 0.6;

// C17 component ID for observability — not yet in ComponentId union;
// cast to satisfy buildRedactedEvent. Will be added when ComponentId
// is updated to cover PRD-003 components.
const C17 = "C17" as ComponentId;

// ── Handler ───────────────────────────────────────────────────────────────

/**
 * Handle a water event: extract volume, persist, reply.
 *
 * Dependencies are injected for testability.
 */
export async function handleWaterEvent(
  input: WaterEventInput,
  deps: {
    store: TenantStore;
    settingsService: { getSettings(userId: string): Promise<ModalitySettings | null> };
    configLoader: ExtractorConfigLoader;
    metrics: MetricsRegistry;
    logger: OpenClawLogger;
    spendTracker?: import("../../observability/costGuard.js").SpendTracker;
    degradeModeEnabled?: boolean;
  },
): Promise<WaterReply> {
  const { userId, source, rawText, presetMl, requestId } = input;
  const degrade = deps.degradeModeEnabled ?? false;

  // ── Step 1: Check OFF-state ───────────────────────────────────────────
  const settings = await deps.settingsService.getSettings(userId);
  if (settings && !settings.waterOn) {
    emitLog(deps.logger, buildRedactedEvent(
      "info",
      "kbju-meal-logging",
      C17,
      KPI_EVENT_NAMES.modality_event_persisted,
      requestId,
      userId,
      "skipped_off",
      degrade,
      { modality: "water", source },
    ));
    return { text: OFF_STATE_REPLY, persisted: false };
  }

  // ── Step 2: Determine volume ──────────────────────────────────────────
  let volumeMl: number;
  let confidence: number;
  let modelTier: string;

  if (source === "keyboard" && presetMl !== undefined) {
    // Direct preset — no LLM call
    volumeMl = presetMl;
    confidence = 1.0;
    modelTier = "preset";
  } else if ((source === "text" || source === "voice") && rawText) {
    // LLM extraction
    const extractResult = await extractVolumeFromText(
      rawText,
      requestId,
      userId,
      deps.configLoader,
      deps.logger,
      deps.metrics,
      deps.spendTracker,
      degrade,
    );
    volumeMl = extractResult.volumeMl;
    confidence = extractResult.confidence;
    modelTier = extractResult.modelTier;
  } else {
    // No text, no preset — can't determine volume
    return {
      text: LOW_CONFIDENCE_REPLY,
      keyboard: buildWaterKeyboard(),
      persisted: false,
    };
  }

  // ── Step 3: Validate confidence first ──────────────────────────────────
  // Check confidence before range: when LLM extraction fails completely
  // (volumeMl=0, confidence=0), the low-confidence reply is more helpful
  // than the out-of-range reply.
  if (confidence < CONFIDENCE_THRESHOLD) {
    emitLog(deps.logger, buildRedactedEvent(
      "info",
      "kbju-meal-logging",
      C17,
      KPI_EVENT_NAMES.modality_event_persisted,
      requestId,
      userId,
      "low_confidence",
      degrade,
      { modality: "water", source, model_tier: modelTier },
    ));
    return {
      text: LOW_CONFIDENCE_REPLY,
      keyboard: buildWaterKeyboard(),
      persisted: false,
    };
  }

  // ── Step 4: Validate volume ───────────────────────────────────────────
  if (volumeMl < VOLUME_MIN || volumeMl > VOLUME_MAX) {
    emitLog(deps.logger, buildRedactedEvent(
      "info",
      "kbju-meal-logging",
      C17,
      KPI_EVENT_NAMES.modality_event_persisted,
      requestId,
      userId,
      "out_of_range",
      degrade,
      { modality: "water", source },
    ));
    return {
      text: OUT_OF_RANGE_REPLY,
      keyboard: buildWaterKeyboard(),
      persisted: false,
    };
  }

  // ── Step 5: Persist ───────────────────────────────────────────────────
  const eventSource: WaterEventSource = source;
  const rawTextForDb = (source === "text" || source === "voice") && rawText ? rawText : null;

  const { event_id } = await deps.store.insertWaterEvent(
    userId,
    eventSource,
    volumeMl,
    rawTextForDb,
  );

  // ── Step 6: Telemetry ─────────────────────────────────────────────────
  deps.metrics.increment(
    PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
    { modality: "water", source },
  );

  emitLog(deps.logger, buildRedactedEvent(
    "info",
    "kbju-meal-logging",
    C17,
    KPI_EVENT_NAMES.modality_event_persisted,
    requestId,
    userId,
    "success",
    degrade,
    { modality: "water", source, volume_ml: volumeMl },
  ));

  // ── Step 7: Reply ─────────────────────────────────────────────────────
  const replyText = SUCCESS_REPLY.replace("{ml}", String(volumeMl));

  // Avoid unused-variable lint for event_id
  void event_id;

  return {
    text: replyText,
    persisted: true,
    volumeMl,
  };
}
