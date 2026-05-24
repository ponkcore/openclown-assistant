---
id: ADR-004
title: Qwen VL Photo Recognition
status: proposed
arch_ref: ARCH-001@0.2.0
created: 2026-04-26
updated: 2026-04-26
superseded_by: null
---

# ADR-004: Qwen VL Photo Recognition

## Context
ARCH-001@0.2.0 C7 must convert Telegram meal photos into candidate food items, portions, and a confidence score for mandatory user review. PRD-001@0.2.0 US-4 requires a visible low-confidence label below an Architect-set numeric threshold and forbids auto-save for photo logs. PRD-001@0.2.0 §7 sets photo round-trip latency at <=12 seconds p95 and <=45 seconds p100.

## Options Considered (>=3 real options, no strawmen)
### Option A: Fireworks Qwen3 VL 30B A3B Instruct through OmniRoute
- Description: Route one downscaled meal image plus a strict JSON schema prompt through OmniRoute to Qwen3 VL 30B A3B Instruct. Require model output fields: `items[]`, `portion_text`, `confidence_0_1`, `uncertainty_reasons[]`, and `needs_user_confirmation=true`.
- Pros (concrete): Fireworks lists Qwen3 VL 30B A3B Instruct as a vision model at $0.15/M input and $0.60/M output with 262,144 context (<https://fireworks.ai/models>). It keeps photo calls in the same OmniRoute/Fireworks accounting path as ADR-002@0.1.0 and avoids a GPU requirement.
- Cons (concrete, with sources): Vision-language models can be prompt-injected by image content; OWASP identifies multimodal prompt injection as a specific risk (<https://genai.owasp.org/llmrisk/llm01-prompt-injection/>). Portion estimation from a single image is inherently uncertain, so every result must remain a draft.
- Cost / latency / ops burden: With a conservative 6,000 image/input tokens and 800 output tokens, listed model cost is about $0.00138/photo; 120 photos/month is about $0.17. Ops burden is medium due schema validation and photo deletion.

### Option B: Fireworks reviewer vision model
- Description: Use reviewer for meal photo understanding.
- Pros: Fireworks lists reviewer as a vision-capable model with 262,144 context (<https://fireworks.ai/models>). It may produce stronger reasoning for ambiguous multi-item plates.
- Cons: Listed pricing is $0.95/M input and $4/M output, about 6.3x to 6.7x Option A for comparable token volumes. It is overkill when photo logs are always confirmation-gated.
- Cost / latency / ops burden: Same 6,000 + 800 token call costs about $0.0089/photo; 120 photos/month is about $1.07.

### Option C: Direct Gemini image model inspired by Phase 0 `google-gemini-media`
- Description: Use Gemini image understanding directly, borrowing request-shape ideas from the audited `google-gemini-media` skill reference in ARCH-001@0.2.0 §0.2 Capability C.
- Pros: Real multimodal provider option and a source-backed Phase 0 reference exists.
- Cons: Direct provider calls would bypass the OmniRoute-first rule unless routed through OmniRoute. Google pricing/model documentation fetches were unreliable during research, so this option cannot be accepted with the same cost confidence.
- Cost / latency / ops burden: Unknown exact current cost from fetched sources; medium ops burden due separate provider credentials and quota.

### Option D: Local open-source vision model on the VPS
- Description: Run a small local VLM such as a Qwen/LLaVA-class model on CPU.
- Pros: Keeps photo bytes local after Telegram download; no per-call provider cost.
- Cons: No GPU is available, and PO Q2 explicitly rules remote/managed defaults for components likely to exceed 5 GB sustained RAM. CPU VLM inference risks missing the <=12 second p95 photo budget.
- Cost / latency / ops burden: $0 provider cost; high RAM/CPU; high deployment and model-update burden.

## Decision
We will use **Option A: Fireworks Qwen3 VL 30B A3B Instruct through OmniRoute**.

The low-confidence threshold is **`confidence_0_1 < 0.70`**. Below that threshold, C7 must attach the Russian label `низкая уверенность`; above it, C4 still requires user confirmation before persistence.

Why the losers lost:
- Option B: Higher-capability vision is not worth the 6x+ token price while all photo results are drafts.
- Option C: It is a valid future fallback, but cost/provider evidence was not strong enough and direct use conflicts with OBC-3.
- Option D: Local VLMs do not fit the no-GPU, <=2 GB steady RAM v0.1 floor.

## Consequences
- Positive: Photo cost stays far below the monthly ceiling and remains visible to C10 as part of the same router spend path.
- Negative / trade-offs accepted: Confidence is model-reported and not calibrated; user confirmation is the real safety gate.
- Follow-up work: ARCH-001@0.2.0 Phase 6 must store `photo_confidence`, `low_confidence_label_shown`, and user correction deltas so K7 can compare pre-confirmation estimates against corrected records.

## References
- Fireworks model library and vision model prices: <https://fireworks.ai/models>
- OWASP LLM01 prompt injection and multimodal prompt-injection risk: <https://genai.owasp.org/llmrisk/llm01-prompt-injection/>
- Phase 0 photo-skill audit in ARCH-001@0.2.0 §0.2 Capability C
