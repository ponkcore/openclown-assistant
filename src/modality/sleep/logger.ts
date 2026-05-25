/**
 * C18 Sleep Logger — persist sleep records per ARCH-001@0.6.2 §3.18
 * and PRD-003@0.1.3 §5 US-2 + ADR-017@0.1.0 §Decision.
 *
 * Entry point: handleSleepEvent(input) → SleepReply
 *
 * State machine paths (per ADR-017@0.1.0 §Decision):
 * 1. evening-no-pair: insert pairing state row, reply with acknowledgement.
 * 2. evening-replace-pair: UPDATE existing non-expired pairing, reply clarifying.
 * 3. morning-with-pair: compute duration, insert sleep_record, DELETE pairing row.
 * 4. morning-no-pair: clarifying reply, no record.
 * 5. single-event-morning-duration: extract duration, insert sleep_record.
 * 6. hourly-GC: implemented via src/skills/sleep-gc/ cron skill, not this handler.
 *
 * DST policy: UTC-anchored start_ts_utc + end_ts_utc; attribution_date_local
 * computed via luxon DateTime.fromISO(end_ts_utc).setZone(user_tz).toISODate().
 * Duration is derived from UTC timestamps so DST does NOT affect it.
 */

import { DateTime } from "luxon";
import type { TenantStore } from "../../store/types.js";
import type { MetricsRegistry } from "../../observability/metricsEndpoint.js";
import type { OpenClawLogger, ComponentId } from "../../shared/types.js";
import { PROMETHEUS_METRIC_NAMES, KPI_EVENT_NAMES } from "../../observability/kpiEvents.js";
import { buildRedactedEvent, emitLog } from "../../observability/events.js";
import type { ModalitySettings } from "../settings/service.js";
import {
  EVENING_ACK_REPLY,
  EVENING_REPLACE_PAIR_REPLY,
  PAIRED_SUCCESS_REPLY,
  MORNING_NO_PAIR_REPLY,
  SINGLE_EVENT_SUCCESS_REPLY,
  SANITY_FLOOR_WARN,
  SANITY_CEILING_WARN,
  OFF_STATE_REPLY,
} from "./copy.ru.js";

// ── Public types ──────────────────────────────────────────────────────────

/** The sleep event classification — what kind of sleep event is this? */
export type SleepEventKind =
  | "evening_leg"        // "лёг" / "иду спать"
  | "morning_vstal"      // "встал" / "vstal"
  | "single_duration";   // "спал 7 часов"

/** The source label for telemetry — closed set. */
export type SleepSourceLabel = "text" | "voice" | "paired" | "single";

/** Input to the sleep handler. */
export interface SleepEventInput {
  userId: string;
  /** User's IANA timezone from onboarding-locked profile */
  userTz: string;
  /** What kind of sleep event */
  kind: SleepEventKind;
  /** For single_duration: raw text containing duration info */
  rawText?: string;
  /** Telegram envelope timestamp in seconds → converted to UTC ISO 8601 */
  telegramTimestampSec: number;
  /** Request ID for observability */
  requestId: string;
  /** Source for telemetry: text, voice, etc. */
  source: "text" | "voice";
}

/** Result of handling a sleep event. */
export interface SleepReply {
  text: string;
  keyboard?: unknown;
  persisted: boolean;
  /** Duration in minutes if a record was persisted */
  durationMin?: number;
  /** The effective source label persisted (for telemetry assertions) */
  sourceLabel?: SleepSourceLabel;
  /** Whether this hit the sanity-floor / ceiling soft-warn flow */
  sanityWarn?: "floor" | "ceiling";
  /** Pending sanity-warn context for the confirm/correct flow */
  sanityPending?: {
    kind: "floor" | "ceiling";
    durationMin: number;
    startTsUtc: string;
    endTsUtc: string;
    isPairedOrigin: boolean;
  };
}

/** Injectable clock for testing — returns current epoch ms. */
export type Clock = () => number;

// ── Sanity bounds ─────────────────────────────────────────────────────────

const SANITY_FLOOR_MIN = 30;
const SANITY_CEILING_MIN = 1440;
const NAP_THRESHOLD_MIN = 240;
const PAIRING_TTL_HOURS = 24;

// C18 component ID for observability — not yet in ComponentId union;
// cast to satisfy buildRedactedEvent.
const C18 = "C18" as ComponentId;

// ── Russian duration-spelling regex ──────────────────────────────────────

/**
 * Deterministic regex for extracting duration from Russian time-spelling.
 * Covers: "7 часов", "7ч", "семь часов", "полчаса", "пол-часа",
 * "1 час", "2 часа", "5 часов", "7.5 часов", "7,5 ч", etc.
 *
 * Russian number words (1-12) for "семь часов" style inputs.
 */
const RUSSIAN_NUMBER_WORDS: Record<string, number> = {
  "ноль": 0, "один": 1, "одна": 1, "два": 2, "две": 2,
  "три": 3, "четыре": 4, "пять": 5, "шесть": 6,
  "семь": 7, "восемь": 8, "девять": 9, "десять": 10,
  "одиннадцать": 11, "двенадцать": 12,
};

// Pattern for numeric duration: "7 часов", "7ч", "7.5 ч", "7,5 часов"
const NUMERIC_DURATION_RE = /(\d+(?:[.,]\d+)?)\s*(ч|час|часов|мин|минут|минуты|m|h)/gi;

// Pattern for word-form duration: "семь часов", "пять минут"
const WORD_DURATION_RE = /(ноль|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\s+(ч|час|часов|мин|минут|минуты)/gi;

// Pattern for "полчаса" / "пол-часа" (half an hour = 30 min)
const HALF_HOUR_RE = /пол[-]?часа/gi;

/**
 * Extract duration in minutes from Russian text using deterministic regex.
 * Returns null if no duration pattern is found.
 */
export function extractDurationFromText(text: string): number | null {
  let totalMin = 0;
  let found = false;

  // Check for "полчаса" first
  const halfHourMatch = text.match(HALF_HOUR_RE);
  if (halfHourMatch) {
    totalMin += 30;
    found = true;
  }

  // Numeric patterns
  let match: RegExpExecArray | null;
  NUMERIC_DURATION_RE.lastIndex = 0;
  while ((match = NUMERIC_DURATION_RE.exec(text)) !== null) {
    found = true;
    const value = parseFloat(match[1].replace(",", "."));
    const unit = match[2].toLowerCase();

    if (unit.startsWith("ч") || unit.startsWith("h") || unit.startsWith("час")) {
      totalMin += Math.round(value * 60);
    } else if (unit.startsWith("м") || unit.startsWith("min") || unit.startsWith("мин")) {
      totalMin += Math.round(value);
    }
  }

  // Word-form patterns
  WORD_DURATION_RE.lastIndex = 0;
  while ((match = WORD_DURATION_RE.exec(text)) !== null) {
    found = true;
    const word = match[1].toLowerCase();
    const unit = match[2].toLowerCase();
    const value = RUSSIAN_NUMBER_WORDS[word] ?? 0;

    if (unit.startsWith("ч") || unit.startsWith("час")) {
      totalMin += value * 60;
    } else if (unit.startsWith("м") || unit.startsWith("мин")) {
      totalMin += value;
    }
  }

  return found ? totalMin : null;
}

// ── Duration formatting helper ────────────────────────────────────────────

/**
 * Format duration_min as "H ч M мин" for Russian replies.
 */
export function formatDurationHm(durationMin: number): { h: string; m: string } {
  const h = Math.floor(durationMin / 60);
  const m = durationMin % 60;
  return { h: String(h), m: String(m) };
}

/**
 * Format a UTC ISO timestamp as HH:MM in the user's timezone.
 */
function formatTimeInTz(tsUtc: string, tz: string): string {
  return DateTime.fromISO(tsUtc, { zone: "utc" }).setZone(tz).toFormat("HH:mm");
}

/**
 * Compute attribution_date_local from end_ts_utc and user timezone.
 * Per ADR-017@0.1.0 §Decision: the user-tz calendar day of end_ts_utc.
 */
export function computeAttributionDateLocal(endTsUtc: string, userTz: string): string {
  return DateTime.fromISO(endTsUtc, { zone: "utc" }).setZone(userTz).toISODate() ?? "1970-01-01";
}

// ── Handler ───────────────────────────────────────────────────────────────

/**
 * Handle a sleep event: route through the state machine, persist, reply.
 *
 * Dependencies are injected for testability.
 */
export async function handleSleepEvent(
  input: SleepEventInput,
  deps: {
    store: TenantStore;
    settingsService: { getSettings(userId: string): Promise<ModalitySettings | null> };
    metrics: MetricsRegistry;
    logger: OpenClawLogger;
    clock?: Clock;
    /** Optional LLM duration extractor — called if regex fails for single_duration */
    llmDurationExtractor?: (rawText: string, userId: string) => Promise<number | null>;
    degradeModeEnabled?: boolean;
  },
): Promise<SleepReply> {
  const { userId, userTz, kind, rawText, telegramTimestampSec, requestId, source } = input;
  const degrade = deps.degradeModeEnabled ?? false;
  const clock = deps.clock ?? (() => Date.now());

  // Compute event timestamp from Telegram envelope
  const eventTsUtc = new Date(telegramTimestampSec * 1000).toISOString();

  // ── Step 1: Check OFF-state ───────────────────────────────────────────
  const settings = await deps.settingsService.getSettings(userId);
  if (settings && !settings.sleepOn) {
    emitLog(deps.logger, buildRedactedEvent(
      "info",
      "kbju-meal-logging",
      C18,
      KPI_EVENT_NAMES.modality_event_persisted,
      requestId,
      userId,
      "skipped_off",
      degrade,
      { modality: "sleep", source },
    ));
    return { text: OFF_STATE_REPLY, persisted: false };
  }

  // ── Step 2: Route by kind ────────────────────────────────────────────

  // Path 1 & 2: Evening "лёг" event
  if (kind === "evening_leg") {
    const existingPair = await deps.store.getSleepPairingState(userId);

    // Compute expires_at = leg_event_ts_utc + 24h
    const expiresAtUtc = DateTime.fromISO(eventTsUtc, { zone: "utc" })
      .plus({ hours: PAIRING_TTL_HOURS })
      .toISO()!;

    await deps.store.upsertSleepPairingState(userId, eventTsUtc, expiresAtUtc);

    if (existingPair) {
      // Path 2: evening-replace-pair
      emitLog(deps.logger, buildRedactedEvent(
        "info",
        "kbju-meal-logging",
        C18,
        KPI_EVENT_NAMES.modality_event_persisted,
        requestId,
        userId,
        "replace_pair",
        degrade,
        { modality: "sleep", source: "paired" },
      ));
      return { text: EVENING_REPLACE_PAIR_REPLY, persisted: false, sourceLabel: "paired" };
    }

    // Path 1: evening-no-pair
    emitLog(deps.logger, buildRedactedEvent(
      "info",
      "kbju-meal-logging",
      C18,
      KPI_EVENT_NAMES.modality_event_persisted,
      requestId,
      userId,
      "pair_created",
      degrade,
      { modality: "sleep", source: "paired" },
    ));
    return { text: EVENING_ACK_REPLY, persisted: false, sourceLabel: "paired" };
  }

  // Path 3 & 4: Morning "встал" event
  if (kind === "morning_vstal") {
    const existingPair = await deps.store.getSleepPairingState(userId);

    if (existingPair) {
      // Path 3: morning-with-pair
      const startTsUtc = existingPair.leg_event_ts_utc;
      const endTsUtc = eventTsUtc;

      // Compute duration from UTC timestamps (DST-safe)
      const startMs = new Date(startTsUtc).getTime();
      const endMs = new Date(endTsUtc).getTime();
      const durationMin = Math.round((endMs - startMs) / 60_000);

      // Sanity check
      if (durationMin < SANITY_FLOOR_MIN) {
        emitLog(deps.logger, buildRedactedEvent(
          "info",
          "kbju-meal-logging",
          C18,
          KPI_EVENT_NAMES.modality_event_persisted,
          requestId,
          userId,
          "sanity_floor_warn",
          degrade,
          { modality: "sleep", source: "paired", duration_min: durationMin },
        ));
        return {
          text: SANITY_FLOOR_WARN,
          persisted: false,
          sourceLabel: "paired",
          sanityWarn: "floor",
          sanityPending: {
            kind: "floor",
            durationMin,
            startTsUtc,
            endTsUtc,
            isPairedOrigin: true,
          },
        };
      }

      if (durationMin > SANITY_CEILING_MIN) {
        emitLog(deps.logger, buildRedactedEvent(
          "info",
          "kbju-meal-logging",
          C18,
          KPI_EVENT_NAMES.modality_event_persisted,
          requestId,
          userId,
          "sanity_ceiling_warn",
          degrade,
          { modality: "sleep", source: "paired", duration_min: durationMin },
        ));
        return {
          text: SANITY_CEILING_WARN,
          persisted: false,
          sourceLabel: "paired",
          sanityWarn: "ceiling",
          sanityPending: {
            kind: "ceiling",
            durationMin,
            startTsUtc,
            endTsUtc,
            isPairedOrigin: true,
          },
        };
      }

      // Within bounds — persist
      const isNap = durationMin <= NAP_THRESHOLD_MIN;
      const attributionDateLocal = computeAttributionDateLocal(endTsUtc, userTz);

      const { record_id } = await deps.store.insertSleepRecord(
        userId, startTsUtc, endTsUtc, durationMin,
        attributionDateLocal, userTz, isNap, true, // isPairedOrigin=true
      );

      // Delete the pairing row (consumed)
      await deps.store.deleteSleepPairingState(userId);

      // Format reply
      const { h, m } = formatDurationHm(durationMin);
      const startFmt = formatTimeInTz(startTsUtc, userTz);
      const endFmt = formatTimeInTz(endTsUtc, userTz);
      const replyText = PAIRED_SUCCESS_REPLY
        .replace("{h}", h)
        .replace("{m}", m)
        .replace("{start}", startFmt)
        .replace("{end}", endFmt);

      emitLog(deps.logger, buildRedactedEvent(
        "info",
        "kbju-meal-logging",
        C18,
        KPI_EVENT_NAMES.modality_event_persisted,
        requestId,
        userId,
        "success",
        degrade,
        { modality: "sleep", source: "paired", duration_min: durationMin, is_nap: isNap, attribution_date_local: attributionDateLocal, event_id: record_id },
      ));

      return {
        text: replyText,
        persisted: true,
        durationMin,
        sourceLabel: "paired",
      };
    }

    // Path 4: morning-no-pair
    emitLog(deps.logger, buildRedactedEvent(
      "info",
      "kbju-meal-logging",
      C18,
      KPI_EVENT_NAMES.modality_event_persisted,
      requestId,
      userId,
      "no_pair",
      degrade,
      { modality: "sleep", source },
    ));
    return { text: MORNING_NO_PAIR_REPLY, persisted: false, sourceLabel: source === "voice" ? "voice" : "text" };
  }

  // Path 5: single-event-morning-duration
  if (kind === "single_duration") {
    if (!rawText) {
      return { text: MORNING_NO_PAIR_REPLY, persisted: false, sourceLabel: "text" };
    }

    // Try deterministic regex first
    let durationMin = extractDurationFromText(rawText);

    // If regex fails, try LLM extractor if available
    if (durationMin === null && deps.llmDurationExtractor) {
      try {
        durationMin = await deps.llmDurationExtractor(rawText, userId);
      } catch {
        // LLM extraction failed — fall through to no-duration
      }
    }

    if (durationMin === null || durationMin <= 0) {
      // Could not extract duration
      emitLog(deps.logger, buildRedactedEvent(
        "info",
        "kbju-meal-logging",
        C18,
        KPI_EVENT_NAMES.modality_event_persisted,
        requestId,
        userId,
        "no_duration_extracted",
        degrade,
        { modality: "sleep", source: "single" },
      ));
      return { text: MORNING_NO_PAIR_REPLY, persisted: false, sourceLabel: "single" };
    }

    // Sanity check
    if (durationMin < SANITY_FLOOR_MIN) {
      const endTsUtc = eventTsUtc;
      const startTsUtc = new Date(new Date(endTsUtc).getTime() - durationMin * 60_000).toISOString();

      emitLog(deps.logger, buildRedactedEvent(
        "info",
        "kbju-meal-logging",
        C18,
        KPI_EVENT_NAMES.modality_event_persisted,
        requestId,
        userId,
        "sanity_floor_warn",
        degrade,
        { modality: "sleep", source: "single", duration_min: durationMin },
      ));
      return {
        text: SANITY_FLOOR_WARN,
        persisted: false,
        sourceLabel: "single",
        sanityWarn: "floor",
        sanityPending: {
          kind: "floor",
          durationMin,
          startTsUtc,
          endTsUtc,
          isPairedOrigin: false,
        },
      };
    }

    if (durationMin > SANITY_CEILING_MIN) {
      const endTsUtc = eventTsUtc;
      const startTsUtc = new Date(new Date(endTsUtc).getTime() - durationMin * 60_000).toISOString();

      emitLog(deps.logger, buildRedactedEvent(
        "info",
        "kbju-meal-logging",
        C18,
        KPI_EVENT_NAMES.modality_event_persisted,
        requestId,
        userId,
        "sanity_ceiling_warn",
        degrade,
        { modality: "sleep", source: "single", duration_min: durationMin },
      ));
      return {
        text: SANITY_CEILING_WARN,
        persisted: false,
        sourceLabel: "single",
        sanityWarn: "ceiling",
        sanityPending: {
          kind: "ceiling",
          durationMin,
          startTsUtc,
          endTsUtc,
          isPairedOrigin: false,
        },
      };
    }

    // Within bounds — persist
    const endTsUtc = eventTsUtc;
    const startTsUtc = new Date(new Date(endTsUtc).getTime() - durationMin * 60_000).toISOString();
    const isNap = durationMin <= NAP_THRESHOLD_MIN;
    const attributionDateLocal = computeAttributionDateLocal(endTsUtc, userTz);

    const { record_id } = await deps.store.insertSleepRecord(
      userId, startTsUtc, endTsUtc, durationMin,
      attributionDateLocal, userTz, isNap, false, // isPairedOrigin=false
    );

    // Format reply
    const { h, m } = formatDurationHm(durationMin);
    const replyText = SINGLE_EVENT_SUCCESS_REPLY
      .replace("{h}", h)
      .replace("{m}", m);

    emitLog(deps.logger, buildRedactedEvent(
      "info",
      "kbju-meal-logging",
      C18,
      KPI_EVENT_NAMES.modality_event_persisted,
      requestId,
      userId,
      "success",
      degrade,
      { modality: "sleep", source: "single", duration_min: durationMin, is_nap: isNap, attribution_date_local: attributionDateLocal, event_id: record_id },
    ));

    return {
      text: replyText,
      persisted: true,
      durationMin,
      sourceLabel: "single",
    };
  }

  // Should not reach here — defensive
  return { text: MORNING_NO_PAIR_REPLY, persisted: false };
}

/**
 * Confirm a sanity-warned sleep record — user said "да" or confirmed-as-is.
 * Persists the record that was previously blocked by the sanity floor/ceiling.
 */
export async function confirmSanityWarnedSleep(
  userId: string,
  userTz: string,
  pending: {
    kind: "floor" | "ceiling";
    durationMin: number;
    startTsUtc: string;
    endTsUtc: string;
    isPairedOrigin: boolean;
  },
  deps: {
    store: TenantStore;
    settingsService: { getSettings(userId: string): Promise<ModalitySettings | null> };
    metrics: MetricsRegistry;
    logger: OpenClawLogger;
    requestId: string;
    degradeModeEnabled?: boolean;
  },
): Promise<SleepReply> {
  const degrade = deps.degradeModeEnabled ?? false;
  const { durationMin, startTsUtc, endTsUtc, isPairedOrigin } = pending;
  const isNap = durationMin <= NAP_THRESHOLD_MIN;
  const attributionDateLocal = computeAttributionDateLocal(endTsUtc, userTz);

  const { record_id } = await deps.store.insertSleepRecord(
    userId, startTsUtc, endTsUtc, durationMin,
    attributionDateLocal, userTz, isNap, isPairedOrigin,
  );

  // If this was a paired record, delete the pairing state
  if (isPairedOrigin) {
    await deps.store.deleteSleepPairingState(userId);
  }

  const { h, m } = formatDurationHm(durationMin);
  const replyText = isPairedOrigin
    ? PAIRED_SUCCESS_REPLY
        .replace("{h}", h)
        .replace("{m}", m)
        .replace("{start}", formatTimeInTz(startTsUtc, userTz))
        .replace("{end}", formatTimeInTz(endTsUtc, userTz))
    : SINGLE_EVENT_SUCCESS_REPLY
        .replace("{h}", h)
        .replace("{m}", m);

  const sourceLabel: SleepSourceLabel = isPairedOrigin ? "paired" : "single";

  emitLog(deps.logger, buildRedactedEvent(
    "info",
    "kbju-meal-logging",
    C18,
    KPI_EVENT_NAMES.modality_event_persisted,
    deps.requestId,
    userId,
    "success_confirmed",
    degrade,
    { modality: "sleep", source: sourceLabel, duration_min: durationMin, is_nap: isNap, attribution_date_local: attributionDateLocal, event_id: record_id },
  ));

  return {
    text: replyText,
    persisted: true,
    durationMin,
    sourceLabel,
  };
}

/**
 * Re-parse a user's correction text after a sanity warn.
 * E.g. user types "опечатка, 7 часов" after being warned about 10-minute duration.
 * Returns a new SleepReply with the re-parsed duration.
 */
export async function correctSanityWarnedSleep(
  userId: string,
  userTz: string,
  correctionText: string,
  telegramTimestampSec: number,
  deps: {
    store: TenantStore;
    settingsService: { getSettings(userId: string): Promise<ModalitySettings | null> };
    metrics: MetricsRegistry;
    logger: OpenClawLogger;
    requestId: string;
    clock?: Clock;
    llmDurationExtractor?: (rawText: string, userId: string) => Promise<number | null>;
    degradeModeEnabled?: boolean;
  },
): Promise<SleepReply> {
  // Re-parse the correction text as a single_duration event
  return handleSleepEvent(
    {
      userId,
      userTz,
      kind: "single_duration",
      rawText: correctionText,
      telegramTimestampSec,
      requestId: deps.requestId,
      source: "text",
    },
    {
      store: deps.store,
      settingsService: deps.settingsService,
      metrics: deps.metrics,
      logger: deps.logger,
      clock: deps.clock,
      llmDurationExtractor: deps.llmDurationExtractor,
      degradeModeEnabled: deps.degradeModeEnabled,
    },
  );
}
