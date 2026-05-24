/**
 * Tests for src/observability/modalityMisclassificationRate.ts
 * PRD-003@0.1.3 §8 R1 — rolling-30-day modality-misclassification rate telemetry
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ModalityMisclassificationAggregator,
  createModalityInstrumentedRegistry,
} from "../../src/observability/modalityMisclassificationRate.js";
import { createMetricsRegistry } from "../../src/observability/metricsEndpoint.js";
import { PROMETHEUS_METRIC_NAMES } from "../../src/observability/kpiEvents.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Fixed clock starting at 2026-01-01T00:00:00Z */
const BASE_TS = 1735689600000;
let clockMs = BASE_TS;

function advanceClock(ms: number): void {
  clockMs += ms;
}

function resetClock(): void {
  clockMs = BASE_TS;
}

const nowProvider = () => clockMs;

// ── Aggregator unit tests ──────────────────────────────────────────────────

describe("ModalityMisclassificationAggregator", () => {
  let registry: ReturnType<typeof createMetricsRegistry>;
  let aggregator: ModalityMisclassificationAggregator;

  beforeEach(() => {
    resetClock();
    registry = createMetricsRegistry();
    aggregator = new ModalityMisclassificationAggregator(registry, nowProvider);
  });

  it("returns null rates when no events recorded", () => {
    const rates = aggregator.computeRates();
    expect(rates.misclassificationRate).toBeNull();
    expect(rates.llmFallbackRate).toBeNull();
    expect(rates.llmFailureRate).toBeNull();
  });

  it("computes misclassification_rate correctly", () => {
    // 10 routes: 5 deterministic_single, 2 ambiguous_clarified, 3 zero_match_llm_ambiguous
    for (let i = 0; i < 5; i++) aggregator.recordRouteOutcome("deterministic_single");
    for (let i = 0; i < 2; i++) aggregator.recordRouteOutcome("ambiguous_clarified");
    for (let i = 0; i < 3; i++) aggregator.recordRouteOutcome("zero_match_llm_ambiguous");

    const rates = aggregator.computeRates();
    // misclassification = (2 + 3) / 10 = 0.5
    expect(rates.misclassificationRate).toBeCloseTo(0.5);
  });

  it("computes llm_fallback_rate correctly", () => {
    // 10 routes: 3 deterministic_single, 4 deterministic_multi_llm_resolved,
    //            2 zero_match_llm_resolved, 1 zero_match_llm_ambiguous
    for (let i = 0; i < 3; i++) aggregator.recordRouteOutcome("deterministic_single");
    for (let i = 0; i < 4; i++) aggregator.recordRouteOutcome("deterministic_multi_llm_resolved");
    for (let i = 0; i < 2; i++) aggregator.recordRouteOutcome("zero_match_llm_resolved");
    aggregator.recordRouteOutcome("zero_match_llm_ambiguous");

    const rates = aggregator.computeRates();
    // llm_fallback = (4 + 2 + 1) / 10 = 0.7
    expect(rates.llmFallbackRate).toBeCloseTo(0.7);
  });

  it("computes llm_failure_rate correctly", () => {
    // 5 LLM calls: 3 success_default, 1 success_fallback, 1 failure
    for (let i = 0; i < 3; i++) aggregator.recordLLMCallOutcome("success_default");
    aggregator.recordLLMCallOutcome("success_fallback");
    aggregator.recordLLMCallOutcome("failure");

    // Need at least 1 route for rates to be non-null
    aggregator.recordRouteOutcome("deterministic_single");

    const rates = aggregator.computeRates();
    // llm_failure = 1 / 5 = 0.2
    expect(rates.llmFailureRate).toBeCloseTo(0.2);
  });

  it("returns null llm_failure_rate when no LLM calls", () => {
    aggregator.recordRouteOutcome("deterministic_single");
    const rates = aggregator.computeRates();
    expect(rates.llmFailureRate).toBeNull();
  });

  it("expires events older than 30 days", () => {
    aggregator.recordRouteOutcome("ambiguous_clarified");

    // Advance 31 days
    advanceClock(31 * 24 * 60 * 60 * 1000);

    aggregator.recordRouteOutcome("deterministic_single");

    const rates = aggregator.computeRates();
    // Only the deterministic_single event remains (within 30-day window)
    // misclassification = 0 / 1 = 0
    expect(rates.misclassificationRate).toBe(0);
    expect(aggregator.bufferLength).toBe(1);
  });

  it("syncGauges sets gauge values on the registry", () => {
    for (let i = 0; i < 8; i++) aggregator.recordRouteOutcome("deterministic_single");
    for (let i = 0; i < 2; i++) aggregator.recordRouteOutcome("ambiguous_clarified");

    aggregator.syncGauges();

    const samples = registry.getSamples();
    const misclassGauge = samples.find(
      (s) => s.name === PROMETHEUS_METRIC_NAMES.kbju_modality_misclassification_rate
    );
    const fallbackGauge = samples.find(
      (s) => s.name === PROMETHEUS_METRIC_NAMES.kbju_modality_llm_fallback_rate
    );

    expect(misclassGauge).toBeDefined();
    expect(misclassGauge!.value).toBeCloseTo(0.2); // 2/10
    expect(misclassGauge!.labels.period_type).toBe("rolling_30d");
    expect(fallbackGauge).toBeDefined();
  });

  it("syncGauges sets llm_failure_rate gauge", () => {
    for (let i = 0; i < 9; i++) aggregator.recordRouteOutcome("deterministic_single");
    aggregator.recordLLMCallOutcome("success_default");
    aggregator.recordLLMCallOutcome("failure");

    aggregator.syncGauges();

    const samples = registry.getSamples();
    const failureGauge = samples.find(
      (s) => s.name === PROMETHEUS_METRIC_NAMES.kbju_modality_llm_failure_rate
    );

    expect(failureGauge).toBeDefined();
    expect(failureGauge!.value).toBeCloseTo(0.5); // 1/2
    expect(failureGauge!.labels.period_type).toBe("rolling_30d");
  });

  it("syncGauges does NOT emit gauge when rate is null", () => {
    aggregator.syncGauges();

    const samples = registry.getSamples();
    const misclassGauge = samples.find(
      (s) => s.name === PROMETHEUS_METRIC_NAMES.kbju_modality_misclassification_rate
    );
    expect(misclassGauge).toBeUndefined();
  });
});

// ── Instrumented registry wrapper tests ─────────────────────────────────────

describe("createModalityInstrumentedRegistry", () => {
  it("intercepts kbju_modality_route_outcome increments", () => {
    const inner = createMetricsRegistry();
    const { registry, aggregator } = createModalityInstrumentedRegistry(inner);

    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome, {
      component: "C16",
      outcome: "ambiguous_clarified",
    });

    expect(aggregator.bufferLength).toBe(1);
    const rates = aggregator.computeRates();
    expect(rates.misclassificationRate).toBe(1); // 1 ambiguous / 1 total
  });

  it("intercepts kbju_modality_router_llm_call increments", () => {
    const inner = createMetricsRegistry();
    const { registry, aggregator } = createModalityInstrumentedRegistry(inner);

    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call, {
      component: "C16",
      outcome: "failure",
    });
    // Need at least 1 route event for rates to be non-null
    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome, {
      component: "C16",
      outcome: "deterministic_single",
    });

    const rates = aggregator.computeRates();
    expect(rates.llmFailureRate).toBe(1); // 1 failure / 1 LLM call
  });

  it("passes through unrelated metric increments without recording", () => {
    const inner = createMetricsRegistry();
    const { registry, aggregator } = createModalityInstrumentedRegistry(inner);

    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_updates_total, {});
    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_meal_draft_latency_ms_count, {});

    expect(aggregator.bufferLength).toBe(0);
  });

  it("getSamples includes derived gauge values after sync", () => {
    const inner = createMetricsRegistry();
    const { registry, aggregator } = createModalityInstrumentedRegistry(inner);

    // Feed some events
    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome, {
      component: "C16",
      outcome: "ambiguous_clarified",
    });
    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome, {
      component: "C16",
      outcome: "deterministic_single",
    });
    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome, {
      component: "C16",
      outcome: "deterministic_single",
    });

    const samples = registry.getSamples();
    const misclassGauge = samples.find(
      (s) => s.name === PROMETHEUS_METRIC_NAMES.kbju_modality_misclassification_rate
    );
    expect(misclassGauge).toBeDefined();
    expect(misclassGauge!.value).toBeCloseTo(1 / 3);
  });

  it("render includes derived gauge lines", () => {
    const inner = createMetricsRegistry();
    const { registry } = createModalityInstrumentedRegistry(inner);

    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome, {
      component: "C16",
      outcome: "zero_match_llm_ambiguous",
    });
    registry.increment(PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome, {
      component: "C16",
      outcome: "deterministic_single",
    });

    const rendered = registry.render();
    expect(rendered).toContain("kbju_modality_misclassification_rate");
    expect(rendered).toContain("rolling_30d");
  });

  it("set and observe pass through correctly", () => {
    const inner = createMetricsRegistry();
    const { registry } = createModalityInstrumentedRegistry(inner);

    registry.set(PROMETHEUS_METRIC_NAMES.kbju_degrade_mode, { component: "C10" }, 1);
    registry.observe(PROMETHEUS_METRIC_NAMES.kbju_meal_draft_latency_ms, { component: "C4" }, 50);

    const samples = inner.getSamples();
    const degradeGauge = samples.find((s) => s.name === "kbju_degrade_mode");
    expect(degradeGauge).toBeDefined();
    expect(degradeGauge!.value).toBe(1);

    const latencyCount = samples.find((s) => s.name === "kbju_meal_draft_latency_ms_count");
    expect(latencyCount).toBeDefined();
    expect(latencyCount!.value).toBe(1);
  });
});
