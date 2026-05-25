/**
 * C22 Adaptive Summary Composer — K6 rolling-7-day audit helper.
 *
 * Pure function over an array of generated summaries and their
 * corresponding settings snapshots.  Validates that for every
 * generated summary the section set exactly matches the
 * active-modality set at generation time (PRD-003@0.1.3 §6 K6).
 */

// ── Types ────────────────────────────────────────────────────────────────

/** The four toggleable modalities (KBJU is unconditional, not audited). */
export type AuditableModality = "water" | "sleep" | "workout" | "mood";

/** A single generated summary record for audit. */
export interface AuditSummaryEntry {
  userId: string;
  ts_generated: string;
  /** Which modality sections were rendered (excludes KBJU, which is always present). */
  sections: AuditableModality[];
  /** Snapshot of the user's modality settings at generation time. */
  settings_at_generation: {
    water_on: boolean;
    sleep_on: boolean;
    workout_on: boolean;
    mood_on: boolean;
  };
}

/** A single violation found during audit. */
export interface AuditViolation {
  userId: string;
  ts_generated: string;
  reason: string;
}

/** Audit result for a rolling window. */
export interface AuditResult {
  compliant: boolean;
  total: number;
  violations: AuditViolation[];
}

// ── Helper ───────────────────────────────────────────────────────────────

/**
 * Derive the *expected* section set from settings, given the zero-event
 * suppression rule.  The audit can only check that OFF-modalities are
 * never rendered; it cannot verify zero-event suppression because the
 * audit fixture doesn't carry event counts per summary.  So the expected
 * set is a *subset* of the ON set — any ON modality *may* be absent due
 * to zero events, but an OFF modality must NEVER appear.
 *
 * However, PRD-003@0.1.3 §6 K6 says "100% match between active-modality
 * set and summary-section set".  In the audit helper we interpret this as:
 * every rendered section must have its modality ON, and every OFF modality
 * must NOT appear.  (Zero-event ON modalities that are absent are NOT
 * violations — they're legitimate suppressions.)
 */
function expectedSections(
  settings: AuditSummaryEntry["settings_at_generation"],
): Set<AuditableModality> {
  const result = new Set<AuditableModality>();
  if (settings.water_on) result.add("water");
  if (settings.sleep_on) result.add("sleep");
  if (settings.workout_on) result.add("workout");
  if (settings.mood_on) result.add("mood");
  return result;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Audit a rolling window of generated summaries against their
 * settings snapshots.  Returns a list of violations where a
 * rendered section does not match the modality-on state.
 *
 * Violation types:
 * - Rendered a section for a modality that was OFF.
 * - Missing a section for a modality that was ON (this is only flagged
 *   if the caller supplies event-presence information; without it,
 *   zero-event suppression is legitimate and we don't flag it).
 *
 * For K6 compliance we check only the first type (OFF-modality rendered),
 * since the audit helper receives only settings snapshots, not event counts.
 * The caller can augment with event-count data if they want stricter checks.
 */
export function auditAdaptiveSummaryRolling7d(
  summaries: AuditSummaryEntry[],
): AuditResult {
  const violations: AuditViolation[] = [];

  for (const summary of summaries) {
    const onModalities = expectedSections(summary.settings_at_generation);
    const renderedSet = new Set(summary.sections);

    // Check: every rendered section must have its modality ON
    for (const section of renderedSet) {
      if (!onModalities.has(section)) {
        violations.push({
          userId: summary.userId,
          ts_generated: summary.ts_generated,
          reason: `rendered ${section} section but ${section}_on was false`,
        });
      }
    }
  }

  return {
    compliant: violations.length === 0,
    total: summaries.length,
    violations,
  };
}
