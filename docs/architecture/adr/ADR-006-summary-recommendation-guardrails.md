---
id: ADR-006
title: Summary Recommendation Guardrails
status: proposed
arch_ref: ARCH-001@0.2.0
created: 2026-04-26
updated: 2026-04-26
superseded_by: null
---

# ADR-006: Summary Recommendation Guardrails

## Context
ARCH-001@0.2.0 C9 generates Russian daily/weekly/monthly summaries. PRD-001@0.2.0 US-5 allows short personalized recommendations only about calories and macronutrient balance relative to targets. PRD-001@0.2.0 NG6/NG7 prohibit vitamins, supplements, hydration, glycemic index, meal timing, micronutrients, and clinical/medical advice. PO OBC-2 requires the prohibition list to be system-prompt-enforced inside the recommendation generator.

## Options Considered (>=3 real options, no strawmen)
### Option A: System prompt only
- Description: Put the allowed scope and forbidden topics in the C9 system prompt and trust the model output.
- Pros (concrete): Lowest latency and cost; meets the literal OBC-2 requirement that restrictions live in the system prompt.
- Cons (concrete, with sources): OWASP states prompt injection can cause models to violate guidelines and recommends constrained behavior plus output validation/filtering rather than relying on prompts alone (<https://genai.owasp.org/llmrisk/llm01-prompt-injection/>).
- Cost / latency / ops burden: One LLM call; no validator cost; high compliance risk.

### Option B: System prompt plus deterministic output validator and deterministic fallback
- Description: C9 uses a system prompt that enumerates allowed and forbidden recommendation scope. After generation, deterministic code validates structured JSON fields, checks forbidden-topic stems in Russian and English, rejects clinical/supplement/drug/hydration/micronutrient wording, and sends a deterministic numeric KBJU-only sentence if validation fails. No retry on suspicious output.
- Pros (concrete): Satisfies OBC-2 while adding a code-enforced last line of defense. OWASP recommends defining expected output formats and validating outputs with deterministic code (<https://genai.owasp.org/llmrisk/llm01-prompt-injection/>). It avoids an extra model call and prevents retry-amplified prompt injection.
- Cons (concrete, with sources): Lexical validators can false-positive on harmless words and miss paraphrases. The fallback recommendation is less personalized.
- Cost / latency / ops burden: One LLM call plus local validation; near-zero extra latency; low recurring cost; medium test burden for forbidden term fixtures.

### Option C: System prompt plus LLM-as-judge validator
- Description: Generate recommendation, then ask a second model to classify whether it violates PRD-001@0.2.0 NG6/NG7/F-M2 restrictions.
- Pros: Better semantic coverage than lexical rules and can catch paraphrases.
- Cons: Doubles model calls for every non-empty summary and makes safety depend on another LLM that is itself prompt-injectable. OWASP LLM Top 10 lists prompt injection, improper output handling, misinformation, and unbounded consumption as separate risks to control (<https://genai.owasp.org/llm-top-10/>).
- Cost / latency / ops burden: About 2x LLM cost for summaries; still small in dollars, but unnecessary for v0.1.

### Option D: Deterministic templates only, no LLM recommendation
- Description: Always generate summaries and recommendations from numeric rules without an LLM.
- Pros: Strongest compliance, lowest cost, deterministic tests.
- Cons: PRD-001@0.2.0 US-5 asks for a short personalized recommendation and the PO provided a curated persona source. Pure templates are likely repetitive and underuse the allowed C9 LLM path.
- Cost / latency / ops burden: $0 LLM cost; low ops; lower UX quality.

## Decision
We will use **Option B: System prompt plus deterministic output validator and deterministic fallback**.

The system prompt must include the exact forbidden categories: medical/clinical advice, vitamins, supplements, drugs/medications, hydration, glycemic index, meal timing, micronutrients, diagnoses, treatment, and exercise/fitness recommendations. The model receives only numeric aggregates, targets, previous-period deltas, and the PO persona loaded via `PERSONA_PATH`; it does not receive raw meal text unless needed for a numeric correction note. The validator blocks both Russian and English forbidden stems and any output not matching the summary JSON schema.

Why the losers lost:
- Option A: Prompt-only enforcement is too weak for a safety-critical non-goal boundary.
- Option C: A judge model adds cost/latency and another prompt-injection surface when local rules cover the explicit prohibition list.
- Option D: Fully deterministic summaries are safer but too bland for the PRD's personalized recommendation requirement.

## Consequences
- Positive: The PRD prohibition list is enforced in both prompt and code, and failures degrade to a safe KBJU-only numeric sentence.
- Negative / trade-offs accepted: Some valid Russian wording may be blocked; the fallback must not be treated as a product failure if it preserves safety.
- Follow-up work: Tickets must include a fixture list with forbidden Russian/English terms and acceptance tests proving no blocked topic reaches a Telegram summary.

## References
- OWASP LLM01 Prompt Injection: <https://genai.owasp.org/llmrisk/llm01-prompt-injection/>
- OWASP Top 10 for LLMs and Gen AI Apps 2025: <https://genai.owasp.org/llm-top-10/>
- PRD-001@0.2.0 US-5 and NG6/NG7
- PO OBC-2 in the Phase 2 gap report for ARCH-001@0.2.0
