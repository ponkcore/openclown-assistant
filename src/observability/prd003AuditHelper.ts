/**
 * PRD-003@0.1.3 redaction-compliance audit helpers.
 *
 * Pure functions over in-memory event arrays. The caller is responsible for
 * providing the events (e.g. from a DB rolling-7-day window query).
 *
 * Covers PRD-003@0.1.3 §6 K8 (overall modality redaction) and
 * K4 (mood-comment-specific redaction).
 *
 * ARCH-001@0.6.1 §10.7 emit-boundary policy; ADR-009@0.1.0.
 */

import { LOG_FORBIDDEN_FIELDS } from "./kpiEvents.js";

// ── PRD-003-specific forbidden fields ──────────────────────────────────

/**
 * The five free-text fields introduced by PRD-003@0.1.3 that must be
 * redacted at every emit boundary (structured logs, metric labels, alerts).
 * Subset of LOG_FORBIDDEN_FIELDS; listed here so the audit helpers can
 * iterate only the PRD-003 surface without walking the full list.
 */
export const PRD003_FORBIDDEN_FIELDS: readonly string[] = [
  "mood_comment_text",
  "workout_text",
  "workout_raw_description",
  "sleep_text_input",
  "sleep_voice_transcript",
] as const;

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Minimal event record the audit helpers expect.
 * `event_id` is required for violation traceability.
 * All other keys are arbitrary; the helpers only inspect
 * the PRD003_FORBIDDEN_FIELDS keys.
 */
export interface AuditableEvent {
  event_id: string;
  [key: string]: unknown;
}

/**
 * A single redaction violation found by an audit helper.
 * Deliberately does NOT carry `raw_value` — the violation record
 * must not itself leak the PII it is reporting.
 */
export interface AuditViolation {
  event_id: string;
  field_name: string;
  severity: "critical";
}

export interface AuditResult {
  compliant: boolean;
  total: number;
  violations: AuditViolation[];
}

export interface AuditOptions {
  /** Minimum sample size for compliance (default 100, per K4/K8). */
  minSampleSize?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Returns true when `value` is considered unredacted for a forbidden field.
 *
 * A value is compliant (redacted) if it is:
 *  - `undefined` / absent
 *  - `null`
 *  - exactly the string `"[REDACTED]"`
 *  - the number `0` (numeric scores are allowed per §7 Constraints)
 *
 * Anything else (non-empty string, non-zero number, object, array) is
 * a violation.
 */
function isUnredacted(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (value === "[REDACTED]") return false;
  if (value === 0) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

// ── K8: overall PRD-003 modality redaction audit ───────────────────────

/**
 * Audit PRD-003 telemetry events for redaction compliance (K8).
 *
 * Iterates the five PRD-003 forbidden fields across all supplied events
 * and asserts none carries an unredacted value.
 *
 * @param events  - In-memory event array (caller injects from DB query).
 * @param options - Audit configuration.
 * @returns AuditResult with compliant flag, total count, and violations.
 */
export function auditPrd003TelemetryRolling7d(
  events: readonly AuditableEvent[],
  options?: AuditOptions,
): AuditResult {
  const minSampleSize = options?.minSampleSize ?? 100;
  const violations: AuditViolation[] = [];

  for (const event of events) {
    for (const field of PRD003_FORBIDDEN_FIELDS) {
      if (isUnredacted(event[field])) {
        violations.push({
          event_id: event.event_id,
          field_name: field,
          severity: "critical",
        });
      }
    }
  }

  return {
    compliant: events.length >= minSampleSize && violations.length === 0,
    total: events.length,
    violations,
  };
}

// ── K4: mood-comment-specific redaction audit ──────────────────────────

const MOOD_FORBIDDEN_FIELDS: readonly string[] = ["mood_comment_text"];

/**
 * Audit mood events specifically for mood-comment redaction compliance (K4).
 *
 * Only checks `mood_comment_text` (the mood-specific PII surface).
 * Same shape as the K8 audit but scoped to mood events.
 *
 * @param events  - In-memory mood-event array (caller injects from DB query).
 * @param options - Audit configuration.
 * @returns AuditResult with compliant flag, total count, and violations.
 */
export function auditMoodCommentRedaction(
  events: readonly AuditableEvent[],
  options?: AuditOptions,
): AuditResult {
  const minSampleSize = options?.minSampleSize ?? 100;
  const violations: AuditViolation[] = [];

  for (const event of events) {
    for (const field of MOOD_FORBIDDEN_FIELDS) {
      if (isUnredacted(event[field])) {
        violations.push({
          event_id: event.event_id,
          field_name: field,
          severity: "critical",
        });
      }
    }
  }

  return {
    compliant: events.length >= minSampleSize && violations.length === 0,
    total: events.length,
    violations,
  };
}
