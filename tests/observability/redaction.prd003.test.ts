/**
 * TKT-026: PRD-003@0.1.3 redaction allowlist extension tests.
 *
 * Covers all five new forbidden fields for:
 *  - Structured-log emit-boundary redaction (buildRedactedEvent / emitLog).
 *  - Metric-label rejection (createMetricsRegistry).
 *  - No regression on TKT-015@0.1.0 hardening (existing forbidden fields).
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildRedactedEvent,
  emitLog,
  type ObservabilityEvent,
} from "../../src/observability/events.js";
import {
  KPI_EVENT_NAMES,
  LOG_FORBIDDEN_FIELDS,
  FORBIDDEN_METRIC_LABELS,
} from "../../src/observability/kpiEvents.js";
import {
  createMetricsRegistry,
  renderMetricsToText,
  type MetricsRegistry,
} from "../../src/observability/metricsEndpoint.js";
import { PROMETHEUS_METRIC_NAMES } from "../../src/observability/kpiEvents.js";
import type { ComponentId, MetricOutcome } from "../../src/shared/types.js";

// ── Parameterised forbidden fields ──────────────────────────────────────

const PRD003_FORBIDDEN_FIELDS = [
  "mood_comment_text",
  "workout_text",
  "workout_raw_description",
  "sleep_text_input",
  "sleep_voice_transcript",
] as const;

const SYNTHETIC_PII_VALUES: Record<string, string> = {
  mood_comment_text: "устал но в целом норм",
  workout_text: "жал 80×5×5",
  workout_raw_description: "присед 100кг 3×10",
  sleep_text_input: "спал 7 часов",
  sleep_voice_transcript: "лёг в одиннадцать встал в семь",
};

// ── Helpers ─────────────────────────────────────────────────────────────

function makePrd003Event(
  extra: Record<string, unknown> = {},
): ObservabilityEvent {
  return buildRedactedEvent(
    "info",
    "kbju-modality-logging",
    "C10" as ComponentId,
    KPI_EVENT_NAMES.modality_route_outcome,
    "req-prd003-001",
    "user-hash-abc",
    "success" as MetricOutcome,
    false,
    extra,
  );
}

function makeMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
}

// ── Structured-log redaction (buildRedactedEvent) ──────────────────────

describe("PRD-003 structured-log redaction (buildRedactedEvent)", () => {
  it.each(PRD003_FORBIDDEN_FIELDS)(
    "drops %s from extra (not in ALLOWED_EXTRA_KEYS, redacted by allowlist)",
    (field) => {
      const event = makePrd003Event({ [field]: SYNTHETIC_PII_VALUES[field] });
      expect(event[field]).toBeUndefined();
    },
  );

  it.each(PRD003_FORBIDDEN_FIELDS)(
    "LOG_FORBIDDEN_FIELDS safety-net redacts %s to [REDACTED] when injected into event",
    (field) => {
      const event = makePrd003Event({});
      (event as Record<string, unknown>)[field] = SYNTHETIC_PII_VALUES[field];
      // Re-run the buildLogEvent safety net path:
      // The event already went through buildRedactedEvent. The direct mutation
      // simulates a producer bypass. The emitLog boundary must redact.
      const logger = makeMockLogger();
      emitLog(logger, event);
      const meta = logger.info.mock.calls[0][1] as Record<string, unknown>;
      expect(meta[field]).toBe("[REDACTED]");
    },
  );
});

// ── emitLog emit-boundary redaction ────────────────────────────────────

describe("PRD-003 emitLog emit-boundary redaction", () => {
  it.each(PRD003_FORBIDDEN_FIELDS)(
    "emitLog drops %s from metadata when passed via extra",
    (field) => {
      const event = makePrd003Event({ [field]: SYNTHETIC_PII_VALUES[field] });
      const logger = makeMockLogger();
      emitLog(logger, event);
      const meta = logger.info.mock.calls[0][1] as Record<string, unknown>;
      expect(meta[field]).toBeUndefined();
    },
  );
});

// ── Metric-label rejection ─────────────────────────────────────────────

describe("PRD-003 metric-label rejection", () => {
  it.each(PRD003_FORBIDDEN_FIELDS)(
    "metric output contains no %s label (rejected by FORBIDDEN_METRIC_LABELS)",
    (field) => {
      const registry = createMetricsRegistry();
      registry.increment(PROMETHEUS_METRIC_NAMES.kbju_updates_total, {
        component: "C10",
        [field]: SYNTHETIC_PII_VALUES[field],
      });
      const output = renderMetricsToText(registry);
      expect(output).not.toContain(field);
      expect(output).not.toContain(SYNTHETIC_PII_VALUES[field]);
    },
  );
});

// ── No regression on TKT-015 forbidden fields ──────────────────────────

describe("TKT-015 regression: existing forbidden fields still redacted", () => {
  const existingForbiddenFields = [
    "raw_prompt",
    "raw_transcript",
    "raw_audio",
    "raw_photo",
    "telegram_bot_token",
    "provider_key",
    "username",
    "first_name",
    "last_name",
    "callback_payload_meal_text",
    "provider_response_raw",
  ] as const;

  it("all existing forbidden fields remain in LOG_FORBIDDEN_FIELDS", () => {
    for (const field of existingForbiddenFields) {
      expect(LOG_FORBIDDEN_FIELDS).toContain(field);
    }
  });

  it("all existing forbidden fields remain in FORBIDDEN_METRIC_LABELS where applicable", () => {
    const metricForbiddenFields = [
      "telegram_id",
      "user_id",
      "username",
      "meal_text",
      "error_text",
      "chat_id",
      "first_name",
      "last_name",
    ] as const;
    for (const field of metricForbiddenFields) {
      expect(FORBIDDEN_METRIC_LABELS).toContain(field);
    }
  });

  it("buildRedactedEvent still drops raw_prompt from extra", () => {
    const event = makePrd003Event({ raw_prompt: "secret" });
    expect(event.raw_prompt).toBeUndefined();
  });

  it("metric output still rejects meal_text label", () => {
    const reg = createMetricsRegistry();
    reg.increment(PROMETHEUS_METRIC_NAMES.kbju_updates_total, {
      component: "C4",
      meal_text: "пирог",
    });
    const output = renderMetricsToText(reg);
    expect(output).not.toContain("meal_text");
  });
});
