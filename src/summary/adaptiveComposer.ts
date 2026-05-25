/**
 * C22 Adaptive Summary Composer — per ARCH-001@0.6.2 §3.22 + PRD-003@0.1.3 §5 US-6.
 *
 * Wraps the existing C9 Summary Recommendation Service output,
 * appending modality sections in deterministic order:
 *   KBJU → water → sleep → workout → mood
 * with zero-event suppression and OFF-modality suppression.
 */

import type { TenantStore, WaterEventRow, SleepRecordRow, WorkoutEventRow, MoodEventRow } from "../store/types.js";
import type { ModalitySettings } from "../modality/settings/service.js";
import { createModalitySettingsService, type SettingsDb } from "../modality/settings/service.js";
import {
  WATER_HEADING,
  SLEEP_HEADING,
  WORKOUT_HEADING,
  MOOD_HEADING,
  WORKOUT_TYPE_RU,
  renderNapDecomposition,
} from "./copy.ru.js";
import type { PeriodType, OpenClawLogger } from "../shared/types.js";
import type { AuditableModality } from "./auditHelper.js";

// ── Public types ─────────────────────────────────────────────────────────

/** Which modality sections were rendered (for K6 audit). */
export type SectionSet = AuditableModality[];

/** Input for the adaptive composer. */
export interface AdaptiveComposerInput {
  userId: string;
  /** Period bounds (UTC timestamps). */
  startUtc: string;
  endUtc: string;
  /** Period type — used to derive attribution-date bounds for sleep. */
  periodType: PeriodType;
  /** User's IANA timezone — needed for sleep attribution-date conversion. */
  timezone: string;
  /** The existing C9 KBJU summary text (passed in by caller). */
  kbjuSummaryText: string;
}

/** Output of the adaptive composer. */
export interface AdaptiveComposerOutput {
  /** Full composed summary text (KBJU + active modality sections). */
  text: string;
  /** Which modality sections were rendered (for K6 audit). */
  sections: SectionSet;
}

/** Dependencies the composer needs (for testability). */
export interface AdaptiveComposerDeps {
  store: TenantStore;
  settingsDb: SettingsDb;
  logger: OpenClawLogger;
}

// ── Section renderers ────────────────────────────────────────────────────

function renderWaterSection(events: WaterEventRow[]): string {
  const totalMl = events.reduce((sum, e) => sum + e.volume_ml, 0);
  const count = events.length;
  return `${WATER_HEADING} ${totalMl} мл за ${count} приём${count === 1 ? "" : count < 5 ? "а" : "ов"}`;
}

function formatDuration(min: number): string {
  const hours = Math.floor(min / 60);
  const mins = min % 60;
  if (hours === 0) return `${mins} мин`;
  if (mins === 0) return `${hours} ч`;
  return `${hours} ч ${mins} мин`;
}

function renderSleepSection(records: SleepRecordRow[]): string {
  const nightRecords = records.filter((r) => !r.is_nap);
  const napRecords = records.filter((r) => r.is_nap);

  const totalMin = records.reduce((sum, r) => sum + r.duration_min, 0);
  const durationStr = formatDuration(totalMin);

  const napPhrase = renderNapDecomposition(nightRecords.length, napRecords.length);

  if (napPhrase) {
    return `${SLEEP_HEADING} ${durationStr} (${napPhrase})`;
  }
  return `${SLEEP_HEADING} ${durationStr}`;
}

function renderWorkoutSection(events: WorkoutEventRow[]): string {
  const displayEvents = events.slice(0, 3);
  const parts = displayEvents.map((e) => {
    const typeRu = WORKOUT_TYPE_RU[e.type] ?? e.type;
    const segments: string[] = [typeRu];
    if (e.distance_km != null) segments.push(`${e.distance_km} км`);
    if (e.duration_min != null) segments.push(`${e.duration_min} мин`);
    if (e.sets != null && e.reps != null) segments.push(`${e.sets}×${e.reps}`);
    return segments.join(", ");
  });

  let body = parts.join("; ");
  if (events.length > 3) {
    body += ` +${events.length - 3}`;
  }
  return `${WORKOUT_HEADING} ${body}`;
}

function renderMoodSection(events: MoodEventRow[]): string {
  if (events.length === 1) {
    return `${MOOD_HEADING} ${events[0].score}/10`;
  }
  const avg = events.reduce((sum, e) => sum + e.score, 0) / events.length;
  const avgRounded = Math.round(avg * 10) / 10;
  return `${MOOD_HEADING} средне ${avgRounded}/10 (${events.length} запис${events.length === 1 ? "ь" : events.length < 5 ? "и" : "ей"})`;
}

// ── Helper for allSettled result extraction ───────────────────────────────

const MODALITY_NAMES = ["water", "sleep", "workout", "mood"] as const;

function settledValue<T>(result: PromiseSettledResult<T>, modality: string, logger: OpenClawLogger, fallback: T): T {
  if (result.status === "fulfilled") {
    return result.value;
  }
  // ARCH-001@0.6.2 §3.22 failure mode (a): modality table read failure →
  // emit empty section + observability counter; do NOT block KBJU summary delivery.
  const reason = result.reason;
  const errorName = reason instanceof Error ? reason.name : String(reason);
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  logger.warn("c22_modality_query_failed", {
    modality,
    error_name: errorName,
    error_message: errorMessage,
  });
  return fallback;
}

// ── Main composer ────────────────────────────────────────────────────────

/**
 * Compose an adaptive summary by reading modality settings and events,
 * then appending active sections to the existing C9 KBJU summary text.
 *
 * Deterministic ordering: KBJU → water → sleep → workout → mood.
 * Zero-event suppression: skip sections with zero events even if ON.
 * OFF-modality suppression: skip sections for OFF modalities.
 * Graceful degradation: a single modality query failure suppresses that
 * section only; KBJU and other modality sections are still delivered
 * (ARCH-001@0.6.2 §3.22 failure mode (a)).
 */
export async function composeAdaptiveSummary(
  input: AdaptiveComposerInput,
  deps: AdaptiveComposerDeps,
): Promise<AdaptiveComposerOutput> {
  const { userId, startUtc, endUtc, timezone } = input;
  const { store, settingsDb, logger } = deps;

  // 1. Read modality settings via C21 service (getSettings)
  const settingsService = createModalitySettingsService(settingsDb);
  const settings = await settingsService.getSettings(userId);

  // Fall back to all-ON if settings read fails (ARCH-001@0.6.2 §3.22 failure mode b)
  const effectiveSettings: ModalitySettings = settings ?? {
    waterOn: true,
    sleepOn: true,
    workoutOn: true,
    moodOn: true,
  };

  // 2. Run all 4 modality queries in parallel via Promise.allSettled so
  //    that a single query failure does NOT block KBJU delivery
  //    (ARCH-001@0.6.2 §3.22 failure mode (a)).
  //    Rejected queries fall back to [] (empty events), which triggers
  //    zero-event suppression for that modality section.
  const results = await Promise.allSettled([
    effectiveSettings.waterOn
      ? store.getWaterEventsInWindow(userId, startUtc, endUtc)
      : Promise.resolve([] as WaterEventRow[]),
    effectiveSettings.sleepOn
      ? store.getSleepRecordsInWindow(userId, startUtc, endUtc)
      : Promise.resolve([] as SleepRecordRow[]),
    effectiveSettings.workoutOn
      ? store.getWorkoutEventsInWindow(userId, startUtc, endUtc)
      : Promise.resolve([] as WorkoutEventRow[]),
    effectiveSettings.moodOn
      ? store.getMoodEventsInWindow(userId, startUtc, endUtc)
      : Promise.resolve([] as MoodEventRow[]),
  ]);

  const waterEvents = settledValue(results[0], MODALITY_NAMES[0], logger, [] as WaterEventRow[]);
  const sleepRecords = settledValue(results[1], MODALITY_NAMES[1], logger, [] as SleepRecordRow[]);
  const workoutEvents = settledValue(results[2], MODALITY_NAMES[2], logger, [] as WorkoutEventRow[]);
  const moodEvents = settledValue(results[3], MODALITY_NAMES[3], logger, [] as MoodEventRow[]);

  // 3. Compose sections in deterministic order, suppressing:
  //    - OFF modalities (already handled by not querying them)
  //    - Zero-event modalities (US-6 4th AC bullet)
  //    - Failed-query modalities (fell back to [], also suppressed)
  const sections: SectionSet = [];
  const sectionTexts: string[] = [];

  // KBJU is always present (US-6 1st AC bullet, NG6)
  sectionTexts.push(input.kbjuSummaryText);

  // Water section
  if (effectiveSettings.waterOn && waterEvents.length > 0) {
    sections.push("water");
    sectionTexts.push(renderWaterSection(waterEvents));
  }

  // Sleep section
  if (effectiveSettings.sleepOn && sleepRecords.length > 0) {
    sections.push("sleep");
    sectionTexts.push(renderSleepSection(sleepRecords));
  }

  // Workout section
  if (effectiveSettings.workoutOn && workoutEvents.length > 0) {
    sections.push("workout");
    sectionTexts.push(renderWorkoutSection(workoutEvents));
  }

  // Mood section
  if (effectiveSettings.moodOn && moodEvents.length > 0) {
    sections.push("mood");
    sectionTexts.push(renderMoodSection(moodEvents));
  }

  // 4. Join sections with newlines
  const text = sectionTexts.join("\n");

  return { text, sections };
}
