/**
 * PRD-003@0.1.3 §8 R1 — rolling-30-day modality-misclassification rate telemetry.
 *
 * Aggregation strategy: in-memory ring buffer (option a) because the existing
 * Prometheus surface (`src/observability/metricsEndpoint.ts`) exposes raw
 * counters and gauges via a simple renderer — it has no PromQL engine or
 * query-time `rate()` / `increase()` support.  The three derived gauges must
 * be materialised in-process so that a scrape of `/metrics` returns concrete
 * values.  Events are lost on process restart; if the buffer covers < 30 days
 * the gauges return `null` (no sample emitted).
 *
 * Gauge definitions:
 *   misclassification_rate = (zero_match_llm_ambiguous + ambiguous_clarified)
 *                            / total_routes   (rolling 30-day)
 *   llm_fallback_rate      = (deterministic_multi_llm_resolved
 *                            + zero_match_llm_resolved
 *                            + zero_match_llm_ambiguous)
 *                            / total_routes   (rolling 30-day)
 *   llm_failure_rate       = failure / total_calls (rolling 30-day)
 */

import type { MetricsRegistry, MetricSample } from "./metricsEndpoint.js";
import { PROMETHEUS_METRIC_NAMES } from "./kpiEvents.js";

// ── Closed-enum outcome labels (mirror src/modality/router.ts ROUTE_OUTCOMES) ──

const ROUTE_OUTCOMES = [
  "deterministic_single",
  "deterministic_multi_llm_resolved",
  "zero_match_llm_resolved",
  "zero_match_llm_ambiguous",
  "ambiguous_clarified",
] as const;

const LLM_CALL_OUTCOMES = [
  "success_default",
  "success_fallback",
  "success_emergency",
  "failure",
] as const;

// ── Ring-buffer event types ────────────────────────────────────────────────

interface RouteOutcomeEvent {
  kind: "route_outcome";
  timestamp: number; // epoch-ms
  outcome: (typeof ROUTE_OUTCOMES)[number];
}

interface LLMCallOutcomeEvent {
  kind: "llm_call";
  timestamp: number;
  outcome: (typeof LLM_CALL_OUTCOMES)[number];
}

type AggregatorEvent = RouteOutcomeEvent | LLMCallOutcomeEvent;

// ── Computed rates ─────────────────────────────────────────────────────────

export interface ModalityRateSnapshot {
  /** (zero_match_llm_ambiguous + ambiguous_clarified) / total_routes  or null */
  misclassificationRate: number | null;
  /** (deterministic_multi_llm_resolved + zero_match_llm_resolved
   *  + zero_match_llm_ambiguous) / total_routes  or null */
  llmFallbackRate: number | null;
  /** failure / total_llm_calls  or null */
  llmFailureRate: number | null;
}

// ── Aggregator class ───────────────────────────────────────────────────────

const ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class ModalityMisclassificationAggregator {
  private buffer: AggregatorEvent[] = [];
  private registry: MetricsRegistry;
  private nowProvider: () => number;

  constructor(registry: MetricsRegistry, nowProvider?: () => number) {
    this.registry = registry;
    this.nowProvider = nowProvider ?? Date.now;
  }

  // ── Recording methods (called on every router event) ────────────────────

  /** Record a route-outcome event from C16 Modality Router. */
  recordRouteOutcome(outcome: (typeof ROUTE_OUTCOMES)[number]): void {
    this.buffer.push({
      kind: "route_outcome",
      timestamp: this.nowProvider(),
      outcome,
    });
  }

  /** Record an LLM-call outcome event from C16 Modality Router. */
  recordLLMCallOutcome(outcome: (typeof LLM_CALL_OUTCOMES)[number]): void {
    this.buffer.push({
      kind: "llm_call",
      timestamp: this.nowProvider(),
      outcome,
    });
  }

  // ── Rate computation ────────────────────────────────────────────────────

  /** Compute the three rates over the rolling 30-day window. */
  computeRates(): ModalityRateSnapshot {
    const cutoff = this.nowProvider() - ROLLING_WINDOW_MS;

    // Prune expired entries
    this.buffer = this.buffer.filter((e) => e.timestamp >= cutoff);

    const routeEvents = this.buffer.filter(
      (e): e is RouteOutcomeEvent => e.kind === "route_outcome"
    );
    const llmCallEvents = this.buffer.filter(
      (e): e is LLMCallOutcomeEvent => e.kind === "llm_call"
    );

    const totalRoutes = routeEvents.length;
    const totalLLMCalls = llmCallEvents.length;

    if (totalRoutes === 0) {
      return {
        misclassificationRate: null,
        llmFallbackRate: null,
        llmFailureRate: null,
      };
    }

    // misclassification numerator
    const misclassificationCount = routeEvents.filter(
      (e) =>
        e.outcome === "zero_match_llm_ambiguous" ||
        e.outcome === "ambiguous_clarified"
    ).length;

    // llm fallback numerator
    const llmFallbackCount = routeEvents.filter(
      (e) =>
        e.outcome === "deterministic_multi_llm_resolved" ||
        e.outcome === "zero_match_llm_resolved" ||
        e.outcome === "zero_match_llm_ambiguous"
    ).length;

    const misclassificationRate = misclassificationCount / totalRoutes;
    const llmFallbackRate = llmFallbackCount / totalRoutes;
    const llmFailureRate =
      totalLLMCalls === 0
        ? null
        : llmCallEvents.filter((e) => e.outcome === "failure").length /
          totalLLMCalls;

    return { misclassificationRate, llmFallbackRate, llmFailureRate };
  }

  // ── Sync gauges into the Prometheus registry ────────────────────────────

  /** Compute rates and set gauge values on the registry. */
  syncGauges(): void {
    const rates = this.computeRates();
    const labels = { component: "C16", period_type: "rolling_30d" };

    if (rates.misclassificationRate !== null) {
      this.registry.set(
        PROMETHEUS_METRIC_NAMES.kbju_modality_misclassification_rate,
        labels,
        rates.misclassificationRate
      );
    }
    if (rates.llmFallbackRate !== null) {
      this.registry.set(
        PROMETHEUS_METRIC_NAMES.kbju_modality_llm_fallback_rate,
        labels,
        rates.llmFallbackRate
      );
    }
    if (rates.llmFailureRate !== null) {
      this.registry.set(
        PROMETHEUS_METRIC_NAMES.kbju_modality_llm_failure_rate,
        labels,
        rates.llmFailureRate
      );
    }
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  /** Expose buffer length (for testing). */
  get bufferLength(): number {
    return this.buffer.length;
  }

  /** Clear the ring buffer (for testing). */
  clearBuffer(): void {
    this.buffer = [];
  }
}

// ── Instrumented registry wrapper ──────────────────────────────────────────

/**
 * Wraps a `MetricsRegistry` so that every `increment` call for the two C16
 * metric families also feeds the aggregator's ring buffer.  The wrapper
 * delegates all other methods to the inner registry.  Call `syncGauges()`
 * before `render()` / `getSamples()` to materialise the derived gauges.
 *
 * Usage:
 *   const inner = createMetricsRegistry();
 *   const { registry, aggregator } = createModalityInstrumentedRegistry(inner);
 *   // pass `registry` to the router; aggregator is available for sync
 */
export function createModalityInstrumentedRegistry(
  inner: MetricsRegistry
): {
  registry: MetricsRegistry;
  aggregator: ModalityMisclassificationAggregator;
} {
  const aggregator = new ModalityMisclassificationAggregator(inner);

  const registry: MetricsRegistry = {
    increment(name, labels = {}, delta = 1) {
      inner.increment(name, labels, delta);
      // Intercept C16 modality events
      if (
        name === PROMETHEUS_METRIC_NAMES.kbju_modality_route_outcome &&
        labels.outcome
      ) {
        if (
          (ROUTE_OUTCOMES as readonly string[]).includes(labels.outcome)
        ) {
          aggregator.recordRouteOutcome(
            labels.outcome as (typeof ROUTE_OUTCOMES)[number]
          );
        }
      }
      if (
        name === PROMETHEUS_METRIC_NAMES.kbju_modality_router_llm_call &&
        labels.outcome
      ) {
        if (
          (LLM_CALL_OUTCOMES as readonly string[]).includes(labels.outcome)
        ) {
          aggregator.recordLLMCallOutcome(
            labels.outcome as (typeof LLM_CALL_OUTCOMES)[number]
          );
        }
      }
    },

    set(name, labels, value) {
      inner.set(name, labels, value);
    },

    observe(name, labels, valueMs) {
      inner.observe(name, labels, valueMs);
    },

    getSamples(): MetricSample[] {
      aggregator.syncGauges();
      return inner.getSamples();
    },

    render(): string {
      aggregator.syncGauges();
      return inner.render();
    },
  };

  return { registry, aggregator };
}
