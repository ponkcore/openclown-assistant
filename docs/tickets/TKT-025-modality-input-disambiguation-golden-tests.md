---
id: TKT-025
title: Modality-input disambiguation golden tests + R1 misclassification telemetry
version: 0.1.0
status: done
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
component: C16+observability
depends_on:
- TKT-022@0.1.0
blocks: []
estimate: S
created: 2026-05-06
updated: 2026-05-06
---

# TKT-025: Modality-input disambiguation golden tests + R1 misclassification telemetry

## 1. Goal
Land the PRD-003@0.1.3 §8 R1 rolling-30-day modality-misclassification rate telemetry plus the PO-ratified ambiguity-clarifying-reply golden test set.

## 2. In Scope
- New telemetry view / aggregation that exposes a 30-day rolling rate from the `kbju_modality_route_outcome` counter (TKT-022@0.1.0 amended Option C labels) — specifically:
  - `misclassification_rate = (zero_match_llm_ambiguous + ambiguous_clarified) / total_routes`
  - `llm_fallback_rate = (deterministic_multi_llm_resolved + zero_match_llm_resolved + zero_match_llm_ambiguous) / total_routes`
  - both over a rolling 30-day window.
- LLM-call observability: aggregate `kbju_modality_router_llm_call` (TKT-022@0.1.0 amended) into
  `llm_failure_rate = failure / total_calls` for ADR-018@0.1.0 fallback-chain quality monitoring.
- The views are exposed in the existing local-only observability surface (Prometheus / scrapeable endpoint) per ADR-009@0.1.0; no new dashboards in this ticket.
- **Expanded golden test set covering both routing paths per ADR-015@0.1.0 amended Option C:**
  - **Path 1 (deterministic single)**: ≥15 cases asserting deterministic-chain unique match → correct dispatch, no LLM call.
  - **Path 2 (deterministic multi-match → LLM tie-breaker)**: ≥10 cases with mocked OmniRoute responses asserting candidate-set-constrained classifier returns expected label and routes correctly.
  - **Path 3 (zero-match → LLM full-classifier high confidence)**: ≥5 cases with mocked OmniRoute high-confidence (≥0.6) responses.
  - **Path 4 (zero-match → LLM full-classifier low confidence → AMBIGUOUS)**: ≥5 cases with mocked OmniRoute confidence < 0.6.
  - **Path 5 (clarifying-reply fired)**: ≥5 cases asserting copy + keyboard structure per ARCH-001@0.6.0 §6.2.2 verbatim.
- Documentation note: ARCH-001@0.6.0 §8 (Observability) already lists the rolling-30-day misclassification rate metric in the new §12.2 R13 entry; this ticket does NOT modify the ArchSpec, only the emitter + aggregator + golden test set.

## 3. NOT In Scope
- The C16 Modality Router itself (TKT-022@0.1.0 owns the chain + LLM-classifier wiring).
- ADR-018@0.1.0 LLM-pick selection — this ticket consumes the picks via OmniRoute mock; ADR-018@0.1.0 owns the picks themselves.
- Action-able alerting on the 30-day rates (informational metric only per PRD-003@0.1.3 §8 R1 — "rolling-30-day modality-misclassification rate tracked as informational telemetry").
- Live-LLM golden tests against actual Fireworks endpoints — mocks-only in CI; live-LLM smoke is an Operator-runbook concern, not a CI test.

## 4. Inputs
- ARCH-001@0.6.0 §3.16 (C16 spec) + §6.2 (Voice/Tone profile + concrete reply strings) + §8 (Observability)
- ADR-015@0.1.0 amended §Decision (verbatim contract for both routing paths)
- ADR-018@0.1.0 (LLM picks consumed via OmniRoute mock harness)
- ADR-009@0.1.0 (observability + redaction patterns)
- TKT-022@0.1.0 modules `src/modality/router.ts` + `src/modality/router-classifier.ts`
- PRD-003@0.1.3 §8 R1 (verbatim mitigation paragraph for the metric definition)
- Existing `src/observability/kpiEvents.ts`
- Existing `src/llm/omniroute.ts` mock harness (precedent in `tests/llm/omniroute.test.ts`)

## 5. Outputs
- [ ] `src/observability/modalityMisclassificationRate.ts` exporting the 30-day rolling misclassification + LLM-fallback + LLM-failure rate aggregations.
- [ ] `tests/modality/router.golden.full.test.ts` covering all 5 paths (≥ 15+10+5+5+5 = 40 cases, extension via JSON files under `tests/fixtures/modality/`).
- [ ] `tests/fixtures/modality/deterministic-single.json` (≥15 cases) — inline-default, JSON-extensible.
- [ ] `tests/fixtures/modality/multi-match-llm-resolved.json` (≥10 cases with mocked LLM responses).
- [ ] `tests/fixtures/modality/zero-match-high-confidence.json` (≥5 cases).
- [ ] `tests/fixtures/modality/zero-match-low-confidence.json` (≥5 cases).
- [ ] `tests/fixtures/modality/clarifying-reply-copy.json` (≥5 cases asserting verbatim Russian copy per ARCH-001@0.6.0 §6.2.2).
- [ ] No production-code changes outside `src/observability/`.

## 6. Acceptance Criteria
- [ ] `npm test -- tests/modality/router.golden.full.test.ts` passes (all 5 paths, ≥40 cases).
- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean (strict).
- [ ] The three metric views (misclassification_rate, llm_fallback_rate, llm_failure_rate) are queryable via the existing local Prometheus surface; manual scrape returns non-empty values after a smoke run exercising all 5 routing paths.
- [ ] `python3 scripts/validate_docs.py` clean.

## 7. Constraints
- Do NOT change the ADR-015@0.1.0 amended contract — observability is on top of, not inside, the router.
- Do NOT call live LLM endpoints in CI tests — mock OmniRoute via `tests/llm/omniroute.test.ts` precedent.
- Do NOT emit raw user text into the metric labels (per ARCH-001@0.5.0 §8.1 redaction allowlist).
- Do NOT add new dashboards or alert rules — informational only per PRD-003@0.1.3 §8 R1.
- The 30-day rolling windows MUST be computed over the existing metric retention; if the existing retention is shorter than 30 days, the metric returns `null` until enough data accrues (do not fabricate values).
- Clarifying-reply copy in path-5 fixtures MUST match ARCH-001@0.6.0 §6.2.2 verbatim — character-equality assertion, not approximate.
- `assigned_executor: "executor"` justified: ~80 LoC of metric-aggregation + 5-fixture-set golden test runner + extension hooks; representative GLM workload.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body.
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
- 2026-05-25T00:00:00Z opencode-executor: started
- 2026-05-25T00:21:00Z opencode-executor: in_review; tests 62 pass (47 golden-full + 15 aggregator); lint clean; typecheck clean
- 2026-05-25T00:39:00Z opencode-executor iter2: addressed F-M1 (wrapped registry in metricsEndpoint.ts:214-215 via createModalityInstrumentedRegistry), F-M2 (added end-to-end integration test tests/observability/modalityRouterAggregator.integration.test.ts proving AC line 68); F-L1 noted — status change was not in separate commit, no rebase to avoid rewriting pushed history. All changes within src/observability/ only per TKT-025@0.1.0 §5 Output 8.
- 2026-05-25T01:12:00Z opencode-executor iter3: wired createMetricsRegistry into src/sidecar/factory.ts (line 176-177: replaced createNullMetricsRegistry with createMetricsRegistry + createModalityInstrumentedRegistry) and src/deployment/healthCheck.ts (added setMetricsRegistry setter + registry-driven /metrics render) and src/main.ts (added setMetricsRegistry(deps.metricsRegistry) call in startServer) to satisfy AC68 (PO-authorised carve-out of TKT-025@0.1.0 §5 Output 8 for metrics wiring path). Added production-deps integration test proving all 3 gauges present with non-null values after exercising all 5 routing paths. F-L1 noted — no rebase.
- 2026-05-24T22:22:00Z opencode-orchestrator: merged in commit 526293a (PR #7); RV-CODE-003 verdict iter3=pass after iter2=fail (F-H1 closed by iter3 production wiring)
