/**
 * TKT-026: PRD-003@0.1.3 audit-helper tests.
 *
 * Covers K8 (overall modality redaction) and K4 (mood-comment redaction)
 * sample-audit helpers with synthetic datasets.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  auditPrd003TelemetryRolling7d,
  auditMoodCommentRedaction,
  PRD003_FORBIDDEN_FIELDS,
  type AuditableEvent,
} from "../../src/observability/prd003AuditHelper.js";

// ── Fixture helpers ─────────────────────────────────────────────────────

let eventCounter = 0;

/** Create a fully-redacted PRD-003 event (all forbidden fields null). */
function makeRedactedEvent(modality: string = "mood"): AuditableEvent {
  eventCounter++;
  return {
    event_id: `evt-redacted-${eventCounter}`,
    modality,
    event_outcome: "persisted",
    mood_comment_text: null,
    workout_text: null,
    workout_raw_description: null,
    sleep_text_input: null,
    sleep_voice_transcript: null,
  };
}

/** Create an event with one specific unredacted forbidden field. */
function makeEventWithLeak(
  leakedField: string,
  modality: string = "mood",
): AuditableEvent {
  eventCounter++;
  const base = makeRedactedEvent(modality);
  return {
    ...base,
    event_id: `evt-leak-${eventCounter}`,
    [leakedField]: "unredacted PII value",
  };
}

/** Generate N fully-redacted events. */
function generateRedactedEvents(n: number, modality: string = "mood"): AuditableEvent[] {
  const events: AuditableEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push(makeRedactedEvent(modality));
  }
  return events;
}

/** Generate N events with one specific field leaked in exactly one event. */
function generateEventsWithSingleLeak(
  n: number,
  leakedField: string,
  leakIndex: number = 0,
  modality: string = "mood",
): AuditableEvent[] {
  const events = generateRedactedEvents(n, modality);
  if (leakIndex < n) {
    events[leakIndex] = makeEventWithLeak(leakedField, modality);
  }
  return events;
}

// Reset counter between describe blocks
beforeEach(() => {
  eventCounter = 0;
});

// ── K8: overall PRD-003 modality redaction audit ────────────────────────

describe("auditPrd003TelemetryRolling7d (K8 — overall modality redaction)", () => {
  it("returns compliant=true for N=100 all-redacted events", () => {
    const events = generateRedactedEvents(100);
    const result = auditPrd003TelemetryRolling7d(events);
    expect(result.compliant).toBe(true);
    expect(result.total).toBe(100);
    expect(result.violations).toEqual([]);
  });

  it("returns compliant=false for N=100 with 1 unredacted mood_comment_text", () => {
    const events = generateEventsWithSingleLeak(100, "mood_comment_text", 42);
    const result = auditPrd003TelemetryRolling7d(events);
    expect(result.compliant).toBe(false);
    expect(result.total).toBe(100);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].field_name).toBe("mood_comment_text");
    expect(result.violations[0].event_id).toBe(events[42].event_id);
    expect(result.violations[0].severity).toBe("critical");
  });

  it("returns compliant=false for N=100 with 1 unredacted workout_text", () => {
    const events = generateEventsWithSingleLeak(100, "workout_text", 7);
    const result = auditPrd003TelemetryRolling7d(events);
    expect(result.compliant).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].field_name).toBe("workout_text");
  });

  it("returns compliant=false for N=100 with 1 unredacted workout_raw_description", () => {
    const events = generateEventsWithSingleLeak(100, "workout_raw_description", 13);
    const result = auditPrd003TelemetryRolling7d(events);
    expect(result.compliant).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].field_name).toBe("workout_raw_description");
  });

  it("returns compliant=false for N=100 with 1 unredacted sleep_text_input", () => {
    const events = generateEventsWithSingleLeak(100, "sleep_text_input", 55);
    const result = auditPrd003TelemetryRolling7d(events);
    expect(result.compliant).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].field_name).toBe("sleep_text_input");
  });

  it("returns compliant=false for N=100 with 1 unredacted sleep_voice_transcript", () => {
    const events = generateEventsWithSingleLeak(100, "sleep_voice_transcript", 99);
    const result = auditPrd003TelemetryRolling7d(events);
    expect(result.compliant).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].field_name).toBe("sleep_voice_transcript");
  });

  it("returns compliant=false when sample size < minSampleSize even if all redacted", () => {
    const events = generateRedactedEvents(50);
    const result = auditPrd003TelemetryRolling7d(events);
    expect(result.compliant).toBe(false);
    expect(result.total).toBe(50);
    expect(result.violations).toEqual([]);
  });

  it("returns compliant=true when sample size < minSampleSize but minSampleSize overridden to match", () => {
    const events = generateRedactedEvents(50);
    const result = auditPrd003TelemetryRolling7d(events, { minSampleSize: 50 });
    expect(result.compliant).toBe(true);
  });

  it("violation does not carry raw_value (no PII leak in violation report)", () => {
    const events = generateEventsWithSingleLeak(100, "mood_comment_text", 0);
    const result = auditPrd003TelemetryRolling7d(events);
    const violation = result.violations[0];
    expect(violation).not.toHaveProperty("raw_value");
    // Only event_id, field_name, severity
    const keys = Object.keys(violation);
    expect(keys.sort()).toEqual(["event_id", "field_name", "severity"].sort());
  });

  it("multiple violations across different fields are all reported", () => {
    const events = generateRedactedEvents(100);
    events[0] = makeEventWithLeak("mood_comment_text");
    events[1] = makeEventWithLeak("workout_text");
    const result = auditPrd003TelemetryRolling7d(events);
    expect(result.compliant).toBe(false);
    expect(result.violations.length).toBe(2);
  });

  it("handles empty events array", () => {
    const result = auditPrd003TelemetryRolling7d([]);
    expect(result.compliant).toBe(false);
    expect(result.total).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it("considers [REDACTED] string as compliant", () => {
    eventCounter++;
    const events: AuditableEvent[] = generateRedactedEvents(99);
    events.push({
      event_id: `evt-redacted-string-${eventCounter}`,
      modality: "mood",
      event_outcome: "persisted",
      mood_comment_text: "[REDACTED]",
      workout_text: "[REDACTED]",
      workout_raw_description: "[REDACTED]",
      sleep_text_input: "[REDACTED]",
      sleep_voice_transcript: "[REDACTED]",
    });
    const result = auditPrd003TelemetryRolling7d(events);
    expect(result.compliant).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

// ── K4: mood-comment-specific redaction audit ───────────────────────────

describe("auditMoodCommentRedaction (K4 — mood-comment redaction)", () => {
  it("returns compliant=true for N=100 mood events all redacted", () => {
    const events = generateRedactedEvents(100, "mood");
    const result = auditMoodCommentRedaction(events);
    expect(result.compliant).toBe(true);
    expect(result.total).toBe(100);
    expect(result.violations).toEqual([]);
  });

  it("returns compliant=false for N=100 with 1 unredacted mood_comment_text", () => {
    const events = generateEventsWithSingleLeak(100, "mood_comment_text", 33);
    const result = auditMoodCommentRedaction(events);
    expect(result.compliant).toBe(false);
    expect(result.total).toBe(100);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].field_name).toBe("mood_comment_text");
    expect(result.violations[0].event_id).toBe(events[33].event_id);
    expect(result.violations[0].severity).toBe("critical");
  });

  it("does NOT flag workout_text violations (K4 only checks mood_comment_text)", () => {
    const events = generateEventsWithSingleLeak(100, "workout_text", 0);
    const result = auditMoodCommentRedaction(events);
    // workout_text is unredacted but K4 only audits mood_comment_text
    expect(result.compliant).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("returns compliant=false when sample size < minSampleSize", () => {
    const events = generateRedactedEvents(50, "mood");
    const result = auditMoodCommentRedaction(events);
    expect(result.compliant).toBe(false);
    expect(result.total).toBe(50);
  });

  it("returns compliant=true when sample size < minSampleSize but overridden", () => {
    const events = generateRedactedEvents(50, "mood");
    const result = auditMoodCommentRedaction(events, { minSampleSize: 50 });
    expect(result.compliant).toBe(true);
  });

  it("considers null mood_comment_text as compliant", () => {
    const events = generateRedactedEvents(100, "mood");
    const result = auditMoodCommentRedaction(events);
    expect(result.compliant).toBe(true);
  });

  it("considers [REDACTED] mood_comment_text as compliant", () => {
    const events: AuditableEvent[] = generateRedactedEvents(99, "mood");
    eventCounter++;
    events.push({
      event_id: `evt-mood-redacted-str-${eventCounter}`,
      mood_comment_text: "[REDACTED]",
    });
    const result = auditMoodCommentRedaction(events);
    expect(result.compliant).toBe(true);
  });

  it("violation does not carry raw_value (no PII leak)", () => {
    const events = generateEventsWithSingleLeak(100, "mood_comment_text", 0);
    const result = auditMoodCommentRedaction(events);
    const violation = result.violations[0];
    expect(violation).not.toHaveProperty("raw_value");
  });

  it("handles empty events array", () => {
    const result = auditMoodCommentRedaction([]);
    expect(result.compliant).toBe(false);
    expect(result.total).toBe(0);
  });
});

// ── PRD003_FORBIDDEN_FIELDS constant coverage ───────────────────────────

describe("PRD003_FORBIDDEN_FIELDS constant", () => {
  it("lists exactly the five PRD-003 forbidden fields", () => {
    expect(PRD003_FORBIDDEN_FIELDS).toEqual([
      "mood_comment_text",
      "workout_text",
      "workout_raw_description",
      "sleep_text_input",
      "sleep_voice_transcript",
    ]);
  });
});
