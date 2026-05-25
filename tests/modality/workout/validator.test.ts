import { describe, it, expect } from "vitest";
import {
  validateWorkout,
  WORKOUT_TYPE_ENUM,
  type RawWorkoutExtraction,
} from "../../../src/modality/workout/validator.js";

describe("validateWorkout", () => {
  // ── Each valid enum value passes ────────────────────────────────────────

  describe("valid workout_type values", () => {
    for (const type of WORKOUT_TYPE_ENUM) {
      it(`accepts workout_type="${type}"`, () => {
        const input: RawWorkoutExtraction = {
          workout_type: type,
          duration_min: 30,
          distance_km: null,
          sets: null,
          repetitions: null,
          confidence: 0.9,
        };
        const result = validateWorkout(input);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.normalized).not.toBeNull();
        expect(result.normalized!.workoutType).toBe(type);
      });
    }
  });

  // ── Out-of-enum rejection ───────────────────────────────────────────────

  it("rejects out-of-enum workout_type", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "jogging",
      duration_min: 30,
      distance_km: null,
      sets: null,
      repetitions: null,
      confidence: 0.9,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("jogging");
    expect(result.normalized).toBeNull();
  });

  it("rejects workout_type='strength_training' (old ADR name, not in schema enum)", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "strength_training",
      duration_min: 30,
      distance_km: null,
      sets: null,
      repetitions: null,
      confidence: 0.9,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("strength_training"))).toBe(true);
  });

  it("rejects workout_type='hiking' (old ADR name, not in schema enum)", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "hiking",
      duration_min: 30,
      distance_km: null,
      sets: null,
      repetitions: null,
      confidence: 0.9,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(false);
  });

  // ── Negative numeric rejection ──────────────────────────────────────────

  it("rejects negative duration_min", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "running",
      duration_min: -5,
      distance_km: null,
      sets: null,
      repetitions: null,
      confidence: 0.9,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("duration_min"))).toBe(true);
  });

  it("rejects negative distance_km", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "running",
      duration_min: null,
      distance_km: -3.2,
      sets: null,
      repetitions: null,
      confidence: 0.9,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("distance_km"))).toBe(true);
  });

  it("rejects negative sets", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "strength",
      duration_min: null,
      distance_km: null,
      sets: -1,
      repetitions: 10,
      confidence: 0.9,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("sets"))).toBe(true);
  });

  it("rejects negative repetitions", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "strength",
      duration_min: null,
      distance_km: null,
      sets: 3,
      repetitions: -5,
      confidence: 0.9,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("repetitions"))).toBe(true);
  });

  // ── Zero is accepted for all numerics ────────────────────────────────────

  it("accepts zero duration_min", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "running",
      duration_min: 0,
      distance_km: null,
      sets: null,
      repetitions: null,
      confidence: 0.9,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(true);
  });

  it("accepts zero distance_km", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "running",
      duration_min: null,
      distance_km: 0,
      sets: null,
      repetitions: null,
      confidence: 0.9,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(true);
  });

  it("accepts zero sets and repetitions", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "strength",
      duration_min: null,
      distance_km: null,
      sets: 0,
      repetitions: 0,
      confidence: 0.9,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(true);
  });

  // ── Null is accepted for all optional numerics ──────────────────────────

  it("accepts null for all optional fields", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "yoga",
      duration_min: null,
      distance_km: null,
      sets: null,
      repetitions: null,
      confidence: 0.8,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(true);
    expect(result.normalized!.durationMin).toBeNull();
    expect(result.normalized!.distanceKm).toBeNull();
    expect(result.normalized!.sets).toBeNull();
    expect(result.normalized!.reps).toBeNull();
  });

  // ── Strict-keys rejection ──────────────────────────────────────────────

  it("rejects extra keys in output", () => {
    const input = {
      workout_type: "running",
      duration_min: 30,
      distance_km: null,
      sets: null,
      repetitions: null,
      confidence: 0.9,
      extra_field: "should fail",
    } as RawWorkoutExtraction;
    const result = validateWorkout(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("extra_field"))).toBe(true);
  });

  // ── Multiple errors reported at once ────────────────────────────────────

  it("reports multiple errors simultaneously", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "invalid_type",
      duration_min: -10,
      distance_km: -5,
      sets: -1,
      repetitions: -2,
      confidence: 0.9,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  // ── Normalized output structure ─────────────────────────────────────────

  it("maps repetitions→reps in normalized output", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "strength",
      duration_min: 45,
      distance_km: null,
      sets: 4,
      repetitions: 12,
      confidence: 0.85,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(true);
    expect(result.normalized!.workoutType).toBe("strength");
    expect(result.normalized!.durationMin).toBe(45);
    expect(result.normalized!.sets).toBe(4);
    expect(result.normalized!.reps).toBe(12);
    expect(result.normalized!.distanceKm).toBeNull();
  });

  it("maps workout_type→workoutType in normalized output", () => {
    const input: RawWorkoutExtraction = {
      workout_type: "cycling",
      duration_min: 60,
      distance_km: 20.5,
      sets: null,
      repetitions: null,
      confidence: 0.7,
    };
    const result = validateWorkout(input);
    expect(result.valid).toBe(true);
    expect(result.normalized!.workoutType).toBe("cycling");
    expect(result.normalized!.distanceKm).toBe(20.5);
  });
});
