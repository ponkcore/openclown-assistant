/**
 * C22 Adaptive Summary Composer — Russian copy strings.
 *
 * Section headings per ARCH-001@0.6.2 §6.2.2 C22 spec.
 * Workout-type rendering map per ADR-016@0.1.0 §Consequences.
 * Sleep nap-decomposition phrases per ADR-017@0.1.0 §Consequences.
 */

// ── Section headings (no emoji per §6.2.1; ARCH-001 §6.2.2 C22 verbatim) ──

export const WATER_HEADING = "Вода:";
export const SLEEP_HEADING = "Сон:";
export const WORKOUT_HEADING = "Тренировка:";
export const MOOD_HEADING = "Настроение:";

// ── Workout-type → Russian rendering map (ADR-016@0.1.0 §Consequences) ──
// Schema enum keys: strength, running, cycling, swimming, walking, yoga, hiit, other
// ADR-016 §Consequences specifies the Russian presentation; schema uses 'strength' and 'hiit'
// (per BACKLOG-001 schema-vs-ADR drift).

import type { WorkoutTypeEnum } from "../store/types.js";

export const WORKOUT_TYPE_RU: Record<WorkoutTypeEnum, string> = {
  running: "Бег",
  walking: "Ходьба",
  cycling: "Велосипед",
  swimming: "Плавание",
  strength: "Силовая",
  yoga: "Йога",
  hiit: "HIIT",
  other: "Тренировка",
} as const;

// ── Sleep nap-class decomposition phrases (ADR-017@0.1.0 §Consequences) ──
// "1 ночной сон, 2 дневных" when both present
// Only nap: "2 дневных"
// Only night: "1 ночной сон"

/**
 * Render sleep nap-class decomposition in Russian.
 * @param nightCount - number of night-sleep records (is_nap=false)
 * @param napCount   - number of nap records (is_nap=true)
 * @returns Russian phrase or empty string if both zero
 */
export function renderNapDecomposition(nightCount: number, napCount: number): string {
  if (nightCount === 0 && napCount === 0) return "";
  const parts: string[] = [];
  if (nightCount > 0) {
    parts.push(`${nightCount} ночной сон`);
  }
  if (napCount > 0) {
    // Russian inflection: 1 дневной, 2-4 дневных, 5+ дневных
    if (napCount === 1) {
      parts.push("1 дневной");
    } else {
      parts.push(`${napCount} дневных`);
    }
  }
  return parts.join(", ");
}
