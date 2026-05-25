import { describe, it, expect } from "vitest";
import { auditAdaptiveSummaryRolling7d, type AuditSummaryEntry, type AuditResult } from "../../src/summary/auditHelper.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeEntry(overrides: Partial<AuditSummaryEntry> = {}): AuditSummaryEntry {
  return {
    userId: USER_A,
    ts_generated: "2026-05-25T08:00:00Z",
    sections: [],
    settings_at_generation: {
      water_on: true,
      sleep_on: true,
      workout_on: true,
      mood_on: true,
    },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("auditAdaptiveSummaryRolling7d", () => {
  it("empty summaries returns compliant with zero violations", () => {
    const result = auditAdaptiveSummaryRolling7d([]);
    expect(result.compliant).toBe(true);
    expect(result.total).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it("100% match — all sections match ON modalities", () => {
    const summaries: AuditSummaryEntry[] = [
      makeEntry({ sections: ["water", "sleep", "workout", "mood"] }),
      makeEntry({ sections: ["water", "sleep"] }),
      makeEntry({ sections: [] }), // all ON but zero events = legitimate suppression
    ];
    const result = auditAdaptiveSummaryRolling7d(summaries);
    expect(result.compliant).toBe(true);
    expect(result.total).toBe(3);
    expect(result.violations).toHaveLength(0);
  });

  it("single violation: rendered water section but water_on was false", () => {
    const summaries: AuditSummaryEntry[] = [
      makeEntry({
        sections: ["water"],
        settings_at_generation: {
          water_on: false,
          sleep_on: true,
          workout_on: true,
          mood_on: true,
        },
      }),
    ];
    const result = auditAdaptiveSummaryRolling7d(summaries);
    expect(result.compliant).toBe(false);
    expect(result.total).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].reason).toBe("rendered water section but water_on was false");
    expect(result.violations[0].userId).toBe(USER_A);
  });

  it("multiple violations across different users", () => {
    const summaries: AuditSummaryEntry[] = [
      makeEntry({
        userId: USER_A,
        ts_generated: "2026-05-19T08:00:00Z",
        sections: ["workout"],
        settings_at_generation: { water_on: true, sleep_on: true, workout_on: false, mood_on: true },
      }),
      makeEntry({
        userId: USER_B,
        ts_generated: "2026-05-20T08:00:00Z",
        sections: ["mood"],
        settings_at_generation: { water_on: true, sleep_on: true, workout_on: true, mood_on: false },
      }),
    ];
    const result = auditAdaptiveSummaryRolling7d(summaries);
    expect(result.compliant).toBe(false);
    expect(result.total).toBe(2);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0].reason).toContain("workout_on was false");
    expect(result.violations[1].reason).toContain("mood_on was false");
  });

  it("zero-event suppression is NOT flagged as a violation", () => {
    const summaries: AuditSummaryEntry[] = [
      makeEntry({
        sections: [], // all ON but zero events
        settings_at_generation: { water_on: true, sleep_on: true, workout_on: true, mood_on: true },
      }),
    ];
    const result = auditAdaptiveSummaryRolling7d(summaries);
    expect(result.compliant).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("7-day synthetic fixture with mixed scenarios", () => {
    const summaries: AuditSummaryEntry[] = [
      // Day 1: fully compliant (all ON, all present)
      makeEntry({ ts_generated: "2026-05-19T08:00:00Z", sections: ["water", "sleep", "workout", "mood"] }),
      // Day 2: compliant (some ON, zero-event suppression on mood)
      makeEntry({ ts_generated: "2026-05-20T08:00:00Z", sections: ["water", "sleep"] }),
      // Day 3: violation — workout rendered but OFF
      makeEntry({
        ts_generated: "2026-05-21T08:00:00Z",
        sections: ["water", "workout"],
        settings_at_generation: { water_on: true, sleep_on: false, workout_on: false, mood_on: false },
      }),
      // Day 4: compliant
      makeEntry({ ts_generated: "2026-05-22T08:00:00Z", sections: ["sleep", "mood"] }),
      // Day 5: compliant (all OFF, no sections)
      makeEntry({
        ts_generated: "2026-05-23T08:00:00Z",
        sections: [],
        settings_at_generation: { water_on: false, sleep_on: false, workout_on: false, mood_on: false },
      }),
      // Day 6: compliant
      makeEntry({ ts_generated: "2026-05-24T08:00:00Z", sections: ["water"] }),
      // Day 7: violation — mood rendered but OFF
      makeEntry({
        ts_generated: "2026-05-25T08:00:00Z",
        sections: ["water", "sleep", "mood"],
        settings_at_generation: { water_on: true, sleep_on: true, workout_on: true, mood_on: false },
      }),
    ];
    const result = auditAdaptiveSummaryRolling7d(summaries);
    expect(result.compliant).toBe(false);
    expect(result.total).toBe(7);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0].reason).toContain("workout_on was false");
    expect(result.violations[1].reason).toContain("mood_on was false");
  });

  it("multiple OFF-modality violations on a single summary", () => {
    const summaries: AuditSummaryEntry[] = [
      makeEntry({
        sections: ["water", "sleep", "workout", "mood"],
        settings_at_generation: { water_on: false, sleep_on: false, workout_on: false, mood_on: false },
      }),
    ];
    const result = auditAdaptiveSummaryRolling7d(summaries);
    expect(result.compliant).toBe(false);
    expect(result.violations).toHaveLength(4);
  });
});
