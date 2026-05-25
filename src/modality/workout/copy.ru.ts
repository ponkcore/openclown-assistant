/**
 * C19 Russian-language reply copy per ARCH-001@0.6.2 §6.2.2 + PRD-003@0.1.3 §5 US-3.
 *
 * Tone: caring expert nutritionist-friend, «ты» register, no theatrical
 * praise, no filler, no apologies. Per §6.2.1 zero-emoji default: no emoji
 * in reply text.
 *
 * Per ARCH-001@0.6.2 §6.2 persona spec: feminine first-person past tense
 * ("Записала", not "Записал").
 *
 * Strings are CHARACTER-FOR-CHARACTER per ARCH-001@0.6.2 §6.2.2 C19 block.
 */

import type { WorkoutType } from "./validator.js";
import { WORKOUT_TYPE_ENUM } from "./validator.js";

// ── Workout type → Russian label mapping ────────────────────────────────────
// Per ADR-016@0.1.0 §Decision + ARCH-001@0.6.2 §6.2.2 C19 ambiguous-reply buttons.
// Schema enum: {strength, running, cycling, swimming, walking, yoga, hiit, other}

export const WORKOUT_TYPE_RU: Record<WorkoutType, string> = {
  strength: "силовая",
  running: "бег",
  cycling: "велосипед",
  swimming: "плавание",
  walking: "ходьба",
  yoga: "йога",
  hiit: "HIIT",
  other: "другое",
} as const;

// ── Reply templates ─────────────────────────────────────────────────────────

/** Confirmation — full extraction with distance (§6.2.2: «Записала тренировку: бег, 5 км / 32 мин.»). */
export const SUCCESS_REPLY_WITH_DISTANCE = "Записала тренировку: {workout_type_ru}, {distance_km} км / {duration_min} мин.";

/** Confirmation — strength with sets×reps (§6.2.2: «Записала тренировку: жим лёжа, 80 кг × 5 × 5.»). */
export const SUCCESS_REPLY_WITH_SETS = "Записала тренировку: {workout_type_ru}, {sets}×{reps}.";

/** Confirmation — duration only (§6.2.2: «Записала тренировку: йога, 60 мин.»). */
export const SUCCESS_REPLY_DURATION_ONLY = "Записала тренировку: {workout_type_ru}, {duration_min} мин.";

/** Confirmation — type only, no quantifiable fields. */
export const SUCCESS_REPLY_TYPE_ONLY = "Записала тренировку: {workout_type_ru}.";

/** Missing-quantifiable fields (per PRD-003@0.1.3 §5 US-3): «Записать тренировку. Уточни длительность, дистанцию или вес — что-нибудь одно.» */
export const MISSING_FIELDS_REPLY = "Записать тренировку. Уточни длительность, дистанцию или вес — что-нибудь одно.";

/** Type-ambiguous (LLM says "other") per §6.2.2: «Какая тренировка? [силовая] [бег] [велосипед] [плавание] [ходьба] [йога] [HIIT] [другое]» */
export const AMBIGUOUS_REPLY = "Какая тренировка? [силовая] [бег] [велосипед] [плавание] [ходьба] [йога] [HIIT] [другое]";

/** Photo ambiguous — couldn't extract workout type from photo. */
export const PHOTO_AMBIGUOUS_REPLY = "Не разобралась на фото, какая тренировка. Уточни.";

/** Modality OFF — per §6.2.2 "silent". Kept for debug only. */
export const OFF_STATE_REPLY = "Учёт тренировок сейчас выключен.";

// ── Reply builder ───────────────────────────────────────────────────────────

export interface WorkoutReplyParams {
  workoutType: WorkoutType;
  durationMin: number | null;
  distanceKm: number | null;
  sets: number | null;
  reps: number | null;
}

/**
 * Build a Russian confirmation reply based on which fields are present.
 * Follows the reply patterns in ARCH-001@0.6.2 §6.2.2 C19 block.
 */
export function buildWorkoutSuccessReply(params: WorkoutReplyParams): string {
  const typeRu = WORKOUT_TYPE_RU[params.workoutType];

  if (params.distanceKm !== null && params.durationMin !== null) {
    return SUCCESS_REPLY_WITH_DISTANCE
      .replace("{workout_type_ru}", typeRu)
      .replace("{distance_km}", String(params.distanceKm))
      .replace("{duration_min}", String(params.durationMin));
  }

  if (params.sets !== null && params.reps !== null) {
    return SUCCESS_REPLY_WITH_SETS
      .replace("{workout_type_ru}", typeRu)
      .replace("{sets}", String(params.sets))
      .replace("{reps}", String(params.reps));
  }

  if (params.durationMin !== null) {
    return SUCCESS_REPLY_DURATION_ONLY
      .replace("{workout_type_ru}", typeRu)
      .replace("{duration_min}", String(params.durationMin));
  }

  return SUCCESS_REPLY_TYPE_ONLY
    .replace("{workout_type_ru}", typeRu);
}
