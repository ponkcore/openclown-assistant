---
id: ADR-002
title: OmniRoute-First LLM Routing
status: superseded
arch_ref: ARCH-001@0.2.0
created: 2026-04-26
updated: 2026-05-25
superseded_by: ADR-022
---

> **Superseded by ADR-022@0.1.0** as of ARCH-001@0.7.0. PRD-001@0.3.0 §7 demoted
> OmniRoute from "first-class architectural element" to "one supported provider example
> among many". Body preserved verbatim below per the supersession discipline; references
> in newer artefacts should cite ADR-022@0.1.0.

# ADR-002: OmniRoute-First LLM Routing

## Context
ARCH-001@0.2.0 C6, C7, C9, and C10 need cost-capped model calls for food parsing, photo recognition, and summary recommendation generation. PRD-001@0.2.0 G5 caps combined LLM and voice spend at $10/month. PO OBC-3 requires every skill LLM call to go through OmniRoute first, with direct provider keys only as runtime fallback. The repository routing policy in docs/knowledge/llm-routing.md also forbids raw provider keys and hard-coded model URLs in skill code.

## Options Considered (>=3 real options, no strawmen)
### Option A: OmniRoute-first Fireworks pool with role-specific models
- Description: Skill code calls one OpenAI-compatible OmniRoute endpoint. Router config maps meal text parsing and recommendations to cheap structured-output text models, photo recognition to the chosen vision model in ADR-004@0.1.0, and fallback to direct provider keys only inside the runtime failover path.
- Pros (concrete): Matches PO's existing approximately 30 Fireworks accounts x $50 quota topology from OBC-3. OmniRoute advertises smart routing, load balancing, retries, fallbacks, rate limits, caching, and observability behind one endpoint (<https://github.com/diegosouzapw/OmniRoute>). Fireworks lists low-cost text models such as OpenAI `gpt-oss-120b` at $0.15/M input and $0.60/M output, and Qwen3 VL 30B at $0.15/M input and $0.60/M output (<https://fireworks.ai/models>).
- Cons (concrete, with sources): OmniRoute becomes a local dependency whose outage affects all model-backed paths. Provider/model names and prices can change; C10 must treat unknown cost events as worst-case until reconciled.
- Cost / latency / ops burden: With per-call budgets of 1,500 input tokens and 600 output tokens for meal parsing, one `gpt-oss-120b` call costs about $0.000585 at listed Fireworks prices; 240 meal calls/month is about $0.14 before router overhead. Ops burden is medium because router config and spend reconciliation are required.

### Option B: Direct provider SDK/API calls from each skill
- Description: Each skill calls Fireworks/OpenAI/Gemini/etc. directly with provider keys and local fallback logic.
- Pros: Fewer moving pieces for the first implementation; direct access to provider-specific features.
- Cons: Violates PO OBC-3 and docs/knowledge/llm-routing.md hard rules. It duplicates retries and cost logic across skills and increases secret leakage risk.
- Cost / latency / ops burden: Similar raw model cost to Option A, but higher implementation and review burden; every provider change touches skill code.

### Option C: OpenRouter free/low-cost models first
- Description: Route calls through OpenRouter free-tier or low-cost models before paid Fireworks models.
- Pros: OpenRouter exposes a public model marketplace and free-model filter (<https://openrouter.ai/models?fmt=cards&order=newest&q=free>). It could reduce spend if free capacity is reliable.
- Cons: Free-tier availability, latency, and model identity are less predictable for a daily logging UX. It does not match PO's existing Fireworks-quota topology, so it adds another account and billing source.
- Cost / latency / ops burden: Potentially $0 model cost during availability windows; uncertain p95 latency and quota; medium-to-high ops due extra provider.

### Option D: Self-host local LLM on the VPS
- Description: Run a local model with vLLM/Ollama on the 6 vCPU / 7.6 GiB RAM VPS.
- Pros: No per-token provider bill; maximum local control over prompts and data after deployment.
- Cons: PO Q2 states no GPU and asks any component needing more than 5 GB sustained RAM to default remote. A useful Russian/vision model would exceed v0.1 steady resource limits or latency budgets.
- Cost / latency / ops burden: $0 provider cost but high RAM/CPU pressure; likely violates <=2 GB steady RAM and p95 CPU envelope in PRD-001@0.2.0 §7.

## Decision
We will use **Option A: OmniRoute-first Fireworks pool with role-specific models**.

The initial model policy is:
- Text meal parsing and summary recommendation: Fireworks `gpt-oss-120b` through OmniRoute, fallback to a configured GLM/Qwen text model, then deterministic/manual fallback.
- Photo recognition: the vision model selected in ADR-004@0.1.0 through OmniRoute.
- No skill reads raw provider keys; fallback keys are runtime secrets outside skill business logic.
- Each LLM call declares `max_input_tokens`, `max_output_tokens`, timeout, and estimated worst-case cost; C10 blocks calls when monthly trend approaches $10.

Why the losers lost:
- Option B: It violates the explicit OmniRoute-first topology and scatters secret/cost logic.
- Option C: Free models are useful as an emergency degrade path, but not as the primary pilot path because UX KPIs depend on predictable latency.
- Option D: Local inference does not fit the no-GPU VPS floor and <=2 GB steady RAM envelope.

## Consequences
- Positive: One routing boundary simplifies cost accounting, token budgets, provider failover, and review for raw-key leaks.
- Negative / trade-offs accepted: Router misconfiguration is a single point of model failure; C10 must expose router health and fallback reason in logs.
- Follow-up work: ARCH-001@0.2.0 Phase 7 must define `llm_call_started`, `llm_call_finished`, budget-blocked, and degrade-mode events with model alias, not raw prompt text.

## References
- docs/knowledge/llm-routing.md
- OmniRoute README: <https://github.com/diegosouzapw/OmniRoute>
- Fireworks model library and pricing: <https://fireworks.ai/models>
- OpenRouter free-model filter: <https://openrouter.ai/models?fmt=cards&order=newest&q=free>
