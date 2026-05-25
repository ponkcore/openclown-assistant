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
import type { PeriodType } from "../shared/types.js";
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
}

// ── Section renderers ────────────────────────────────────────────────────

function renderWaterSection(events: WaterEventRow[]): string {
  const totalMl = events.reduce((sum, e) => sum + e.volume_ml, 0);
  const count = events.length;
  // ARCH-001@0.6.2 §6.2.2 C22: "Вода: 1500 мл за день."
  // But the ticket's critical implementation notes say: "Вода: {N} мл (за {M} приёмов)"
  // §6.2.2 verbatim: "Вода: 1500 мл за день." — use that form for daily,
  // but for weekly/monthly we need "за неделю" / "за месяц".
  // Simplify: use the §6.2.2 form "N мл за день" but keep it generic per period.
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
  // §6.2.2: "Тренировка: бег, 5 км / 32 мин." or list up to 3 events compactly
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
  // §6.2.2: "Настроение: 7/10." or "Настроение: средне 7/10 (3 записи)."
  if (events.length === 1) {
    return `${MOOD_HEADING} ${events[0].score}/10`;
  }
  const avg = events.reduce((sum, e) => sum + e.score, 0) / events.length;
  const avgRounded = Math.round(avg * 10) / 10;
  return `${MOOD_HEADING} средне ${avgRounded}/10 (${events.length} запис${events.length === 1 ? "ь" : events.length < 5 ? "и" : "ей"})`;
}

// ── Main composer ────────────────────────────────────────────────────────

/**
 * Compose an adaptive summary by reading modality settings and events,
 * then appending active sections to the existing C9 KBJU summary text.
 *
 * Deterministic ordering: KBJU → water → sleep → workout → mood.
 * Zero-event suppression: skip sections with zero events even if ON.
 * OFF-modality suppression: skip sections for OFF modalities.
 */
export async function composeAdaptiveSummary(
  input: AdaptiveComposerInput,
  deps: AdaptiveComposerDeps,
): Promise<AdaptiveComposerOutput> {
  const { userId, startUtc, endUtc, timezone } = input;

  // 1. Read modality settings via C21 service (getSettings)
  const settingsService = createModalitySettingsService(deps.settingsDb);
  const settings = await settingsService.getSettings(userId);

  // Fall back to all-ON if settings read fails (ARCH-001@0.6.2 §3.22 failure mode b)
  const effectiveSettings: ModalitySettings = settings ?? {
    waterOn: true,
    sleepOn: true,
    workoutOn: true,
    moodOn: true,
  };

  // 2. Build the list of active modalities (ON) for which we need to query events
  //    Run all 4 queries in parallel (Promise.all) to stay within ≤105% latency budget
  const [waterEvents, sleepRecords, workoutEvents, moodEvents] = await Promise.all([
    effectiveSettings.waterOn
      ? deps.store.getWaterEventsInWindow(userId, startUtc, endUtc)
      : Promise.resolve([] as WaterEventRow[]),
    effectiveSettings.sleepOn
      ? deps.store.getSleepRecordsInWindow(userId, startUtc, endUtc)
      : Promise.resolve([] as SleepRecordRow[]),
    effectiveSettings.workoutOn
      ? deps.store.getWorkoutEventsInWindow(userId, startUtc, endUtc)
      : Promise.resolve([] as WorkoutEventRow[]),
    effectiveSettings.moodOn
      ? deps.store.getMoodEventsInWindow(userId, startUtc, endUtc)
      : Promise.resolve([] as MoodEventRow[]),
  ]);

  // 3. Compose sections in deterministic order, suppressing:
  //    - OFF modalities (already handled by not querying them)
  //    - Zero-event modalities (US-6 4th AC bullet)
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
