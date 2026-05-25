/**
 * C19 Workout Validator — deterministic post-validator per ADR-016@0.1.0 §Decision
 * and ADR-006@0.1.0 forced-output guardrail pattern.
 *
 * Pure function: validateWorkout(extracted) → { valid, errors, normalized }.
 * Rejects out-of-enum workout_type, negative numerics, extra keys.
 */

import type { WorkoutTypeEnum } from "../../store/types.js";

// ── Closed enum from schema.sql workout_type ────────────────────────────────

export const WORKOUT_TYPE_ENUM = [
  "strength",
  "running",
  "cycling",
  "swimming",
  "walking",
  "yoga",
  "hiit",
  "other",
] as const;

export type WorkoutType = (typeof WORKOUT_TYPE_ENUM)[number];

const VALID_TYPES = new Set<string>(WORKOUT_TYPE_ENUM);

// ── Allowed keys in extracted JSON (ADR-006 strict-keys) ────────────────────

const ALLOWED_KEYS = new Set([
  "workout_type",
  "duration_min",
  "distance_km",
  "sets",
  "repetitions",
  "confidence",
]);

// ── Input type (raw LLM output) ────────────────────────────────────────────

export interface RawWorkoutExtraction {
  workout_type: string;
  duration_min: number | null;
  distance_km: number | null;
  sets: number | null;
  repetitions: number | null;
  confidence?: number;
  [key: string]: unknown;
}

// ── Normalised output type (ready for persist) ──────────────────────────────

export interface WorkoutEventInput {
  workoutType: WorkoutType;
  durationMin: number | null;
  distanceKm: number | null;
  sets: number | null;
  reps: number | null;
}

// ── Validator result ────────────────────────────────────────────────────────

export interface ValidateWorkoutResult {
  valid: boolean;
  errors: string[];
  normalized: WorkoutEventInput | null;
}

// ── Deterministic validator ────────────────────────────────────────────────

/**
 * Validates a raw LLM extraction output per ADR-016@0.1.0 closed-enum
 * and ADR-006@0.1.0 strict-keys guardrail.
 *
 * Checks:
 * 1. Strict-keys: reject extra keys beyond the allowed set.
 * 2. workout_type ∈ closed enum.
 * 3. All numeric fields ≥ 0 (if present / not null).
 *
 * Returns { valid, errors, normalized } — normalized is null if any check fails.
 */
export function validateWorkout(extracted: RawWorkoutExtraction): ValidateWorkoutResult {
  const errors: string[] = [];

  // 1. Strict-keys check (ADR-006)
  for (const key of Object.keys(extracted)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push(`unexpected key: "${key}"`);
    }
  }

  // 2. workout_type must be in closed enum
  if (!VALID_TYPES.has(extracted.workout_type)) {
    errors.push(`workout_type "${extracted.workout_type}" not in closed enum {${WORKOUT_TYPE_ENUM.join(", ")}}`);
  }

  // 3. Numeric constraints: must be ≥ 0 if present (not null)
  if (extracted.duration_min !== null && extracted.duration_min !== undefined) {
    if (typeof extracted.duration_min !== "number" || extracted.duration_min < 0) {
      errors.push("duration_min must be a number >= 0");
    }
  }
  if (extracted.distance_km !== null && extracted.distance_km !== undefined) {
    if (typeof extracted.distance_km !== "number" || extracted.distance_km < 0) {
      errors.push("distance_km must be a number >= 0");
    }
  }
  if (extracted.sets !== null && extracted.sets !== undefined) {
    if (typeof extracted.sets !== "number" || extracted.sets < 0) {
      errors.push("sets must be a number >= 0");
    }
  }
  if (extracted.repetitions !== null && extracted.repetitions !== undefined) {
    if (typeof extracted.repetitions !== "number" || extracted.repetitions < 0) {
      errors.push("repetitions must be a number >= 0");
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, normalized: null };
  }

  // Build normalized output
  const normalized: WorkoutEventInput = {
    workoutType: extracted.workout_type as WorkoutType,
    durationMin: extracted.duration_min ?? null,
    distanceKm: extracted.distance_km ?? null,
    sets: extracted.sets ?? null,
    reps: extracted.repetitions ?? null,
  };

  return { valid: true, errors: [], normalized };
}
