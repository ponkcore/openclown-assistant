---
id: ADR-016
title: Workout taxonomy normalization (closed-set with extraction-LLM fallback)
status: proposed
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
source_inputs:
- PRD-003@0.1.3 §2 G3 (workout-type extraction success rate ≥80% on PO-ratified 50-event
  golden set)
- PRD-003@0.1.3 §5 US-3 (workout-by-text/voice/photo with optional duration/distance/intensity)
- PRD-003@0.1.3 §6 K2 (canonical-label-correct ≥80% + per-field accuracy ≥70%)
- ADR-002@0.1.0 OmniRoute extraction LLM (existing primary)
- ADR-006@0.1.0 Summary recommendation guardrails (forced-output-set pattern reused)
created: 2026-05-06
updated: 2026-05-06
---

# ADR-016: Workout taxonomy normalization (closed-set with extraction-LLM fallback)

## Context

PRD-003@0.1.3 G3 ("Workout / exercise tracking enabled") requires that each workout
event records a *canonical workout-type label* drawn from a free-form-but-normalised
taxonomy. PRD-003@0.1.3 §6 K2 sets the bar: ≥80% canonical-label-correct on a manually-curated
50-event golden set + ≥70% per-field accuracy on duration / distance / intensity where
derivable. PRD-003@0.1.3 §5 US-3 + §8 R-acceptance confirms the golden-set composition is
ratified by the Product Owner before sign-off.

The free variables left to the Architect are:

1. **What is the canonical taxonomy?** A closed enum (e.g. {running, walking, cycling,
   strength_training, yoga, swimming, hiking, other})? An open free-form string with a
   normaliser? A hybrid?
2. **Where does normalisation run?** Inside the extraction LLM prompt (single hop), or
   in a post-LLM validator (deterministic mapper that catches the LLM's free-form
   output and snaps it to the closed set)?
3. **How is "other" handled?** Persist as `other` with the raw user phrase, or reject
   with a clarifying reply, or admit a future-ratification path for adding a new
   canonical type?

PRD-001@0.2.0 §5 US-3 + ADR-002@0.1.0 already establish the OmniRoute extraction-LLM
pattern for KBJU; PRD-003@0.1.3 §7 explicitly says "PRD-003@0.1.3 introduces no new external
dependency" and reuses C5 voice + C7 photo + the existing extraction LLM hop. So workout
extraction MUST flow through the existing extraction LLM call; the question is what
the prompt asks the LLM to return and how the sidecar validates.

PRD-003@0.1.3 §5 US-3 5th AC bullet additionally requires recognition success rate ≥80% on the
50-event PO-ratified golden set, with seed types listed: "running, walking, cycling,
strength training, yoga, swimming, hiking". That paragraph fixes the *initial taxonomy*
contents but leaves the openness/closed question.

## Options Considered (≥3 real options, no strawmen)

### Option A: Closed enum with extraction-LLM forced output set + deterministic mapper

- Description: Define a closed enum of canonical workout types, seeded from PRD-003@0.1.3 §5
  US-3: `{ "running", "walking", "cycling", "strength_training", "yoga", "swimming",
  "hiking", "other" }`. The C19 Workout Logger calls the existing OmniRoute extraction
  LLM with a structured prompt that includes the closed set and forces a JSON-mode
  response constrained to one of those eight tokens (forced-output-set, same shape as
  ADR-006@0.1.0 guardrail pattern). On `"other"`, the sidecar persists with a
  `raw_workout_text` field carrying the user's original phrase for future ratification.
- Pros (concrete):
  - K2 measurement is well-defined: against a 50-event golden set, classify each event
    into the closed set; success = label matches gold. No fuzzy matching needed.
  - Forced-output-set + JSON-mode is a *deterministic-on-output* contract: the LLM
    cannot return "jog" or "running 5K" or "běh" instead of `running`. Validation is a
    cheap string equality check at the sidecar boundary.
  - `"other"` is an explicit, accepted bucket; the `raw_workout_text` field gives the
    PO + Architect at the next ratification cycle a real corpus to decide whether
    `"climbing"` or `"rowing"` should be promoted to first-class enum values.
  - Reuses ADR-006@0.1.0 forced-output guardrail pattern; no new component shape.
- Cons (concrete):
  - The closed set is tied to PO ratification per change. Adding `"climbing"` or
    `"rowing"` after PRD-003@0.1.3 ships requires a new ADR or an ADR-016 amendment + PO
    sign-off, not a config push. Acceptable: this is the same shape as ADR-013@0.1.0
    allowlist hot-reload — but the taxonomy lives in code (closed enum), not config,
    because the K2 golden-set pass-criterion depends on the enum definition being stable
    between measurement and reporting.
  - The taxonomy is English-tokens-only at the canonical layer. User-facing summary
    rendering (G6 adaptive summary) MUST translate `running` → "Бег", `cycling` →
    "Велосипед" etc. for the Russian-only UX (PRD-003@0.1.3 §7). That translation lives in
    C22 Adaptive Summary Composer, not in the taxonomy itself. Acceptable: clean
    separation of canonical representation from presentation.
- Cost / latency / ops burden: zero new external cost; adds 30–50 tokens to the
  extraction LLM prompt for the forced-output-set instruction; deterministic validator
  is a cheap string equality check. Latency overhead unmeasurable at the PRD-003@0.1.3 §7 ≤5%
  budget.

### Option B: Open free-form label with post-hoc clustering / fuzzy-match normaliser

- Description: The extraction LLM returns a free-form English label (no constraint).
  C19 Workout Logger runs a fuzzy-match against an internal reference set and snaps to
  the nearest neighbour (Levenshtein, embedding distance, or rule-based stemmer). New
  unique labels are persisted as-is and reviewed in batch every N days; promotion to
  the canonical set happens via clustering offline.
- Pros (concrete):
  - Natural taxonomy growth from the data; fewer "other" buckets.
  - Robust to LLM token drift between provider versions (a new GPT-5 update that prefers
    `"strength training"` over `"strength_training"` is auto-handled by fuzzy-match).
- Cons (concrete):
  - K2 measurement becomes ambiguous. "Did the LLM return the canonical label?" is no
    longer well-defined; "did the fuzzy-match output match the gold label?" introduces
    the matcher as a measurement variable. PRD-003@0.1.3 §6 K2 requires a *concrete* number;
    this option blurs the contract.
  - A clustering / promotion pipeline is a *new permanent ops burden* (review batches,
    periodic re-clustering, drift detection). PRD-003@0.1.3 §7 explicitly says "PRD-003@0.1.3
    introduces no new external dependency" — even an internal pipeline is a new ops
    surface that the PRD does not mandate.
  - LLM-driven taxonomies tend to have the long-tail "rowing", "kayaking", "skiing",
    "barre", "pilates", "hot-yoga" labels. Without a closed set, the PO + Architect
    decide on each label *retroactively* rather than on a stable known set.
  - More complex tests (golden-set replay against fuzzy-match output is brittle).
- Cost / latency / ops burden: adds a fuzzy-match component (small) and a periodic
  clustering job (more substantial). Latency overhead per event small; ops burden
  significant relative to Option A.

### Option C: LLM-driven label-to-canonical mapping (LLM-as-validator)

- Description: Two LLM hops per workout event. First hop extracts a free-form workout
  description. Second hop maps the free-form description to the closed canonical set
  (same set as Option A) using a separate prompt designed for classification. C19 only
  persists if both hops complete successfully; on second-hop failure, fall back to
  `"other"` + raw text.
- Pros (concrete):
  - Robust to any LLM-output drift (the second hop can be tuned independently of the
    extraction prompt).
  - Easy to upgrade the canonical set; only the second-hop classifier prompt changes.
- Cons (concrete):
  - Two LLM calls per workout event. PRD-003@0.1.3 §7 ≤5% latency overhead is at risk: 2 ×
    ~1 s OmniRoute round-trip = 2 s extra on the event-handling latency, vs <0.1 s
    with Option A's deterministic validator. On the PRD-003@0.1.3 §7 voice ≤8 s p95 budget
    that's a 25% overhead.
  - More LLM calls = more spend. PRD-003@0.1.3 §7 has no fixed LLM budget but PRD-002@0.2.1
    §9 OQ-1 still tracks production-runtime spend; Option C doubles the per-workout-event
    cost vs Option A for no measured K2 quality lift (the closed-set forced-output-mode
    of Option A is functionally equivalent to a second-hop classification, at zero
    additional latency / cost).
  - Two LLM hops = two hallucination surfaces; ROADMAP-001@0.1.0 §1.2 disfavours every
    LLM hop that isn't strictly necessary.
- Cost / latency / ops burden: 2× LLM cost per event, 2× hallucination surface, ~1 s
  added latency per event. No measured K2 quality benefit over Option A.

## Decision

We will use **Option A — closed enum with extraction-LLM forced output set + deterministic
mapper** for PRD-003@0.1.3 implementation.

The initial closed taxonomy (this ADR §Decision = PO sign-off shape) is:

```
running
walking
cycling
strength_training
yoga
swimming
hiking
other
```

This set is seeded directly from PRD-003@0.1.3 §5 US-3 5th AC bullet ("running, walking,
cycling, strength training, yoga, swimming, hiking") plus an explicit `other` bucket
(persists with `raw_workout_text` for future ratification).

The C19 Workout Logger uses the existing OmniRoute extraction LLM (no new external
dependency per PRD-003@0.1.3 §7) with a forced-output-set JSON prompt of the shape:

```
You are extracting workout events from a Russian fitness message. Return a JSON object
with keys: type (one of {running, walking, cycling, strength_training, yoga, swimming,
hiking, other}), duration_min (integer or null), distance_km (number or null), intensity
(one of {low, medium, high} or null). Use null when a field is not derivable from the
message.
```

The C19 sidecar validator does cheap string-equality checks on the response: type ∈
closed set, duration_min ∈ ℕ ∪ {null}, distance_km ∈ ℝ ∪ {null}, intensity ∈ {low,
medium, high, null}. Any validator failure is treated as a parse error (handled per
ARCH-001@0.5.0 §11 retry policy).

LLM-pick (the specific OmniRoute primary + fallback chain for the workout extraction
prompt) is *not* a new pick at this ADR; we reuse the ADR-002@0.1.0 OmniRoute primary
+ direct-key fallback chain that is already locked for PRD-001@0.2.0 §5 US-3 KBJU
extraction. No `Q_TO_BUSINESS_N` for this ADR.

## Why the losers lost

- **Option B (open free-form + clustering)**: blurs the K2 measurement contract by
  making the fuzzy-matcher a measurement variable, and adds a periodic clustering /
  promotion ops burden that PRD-003@0.1.3 §7 explicitly prohibits ("PRD-003@0.1.3 introduces no
  new external dependency").
- **Option C (LLM-as-validator)**: pays 2× LLM cost + 2× hallucination surface + ~1 s
  added latency per event for no measurable K2 quality lift over Option A's
  forced-output-set + deterministic validator.

## Consequences

**Positive:**

- K2 (canonical-label-correct ≥80%) becomes a clean, reproducible metric: golden-set
  replay through the extraction LLM forced-output prompt, label compared by string
  equality. No fuzzy-match variable.
- `other` bucket + `raw_workout_text` field gives the PO + Architect a real,
  PII-redacted-at-emit corpus for the first taxonomy expansion (likely after PRD-003@0.1.3
  ships and a few weeks of production data accrue).
- Forced-output-set is a known-good guardrail pattern (ADR-006@0.1.0); no new pattern
  invented for PRD-003@0.1.3.
- The Russian-presentation problem (PRD-003@0.1.3 §7 Russian-only UX) is cleanly separated: the
  taxonomy is an internal English-token enum, and C22 Adaptive Summary Composer renders
  it to Russian for the user. The mapping is a per-token i18n table maintained alongside
  C22.

**Negative / trade-offs accepted:**

- Adding a new canonical type requires either an ADR-016 amendment or a follow-up ADR.
  Acceptable: this is a curated, PO-owned vocabulary, not a runtime config.
- LLMs occasionally drift to slight variants ("running" vs "Running" vs "run"); the
  forced-output-set + JSON mode + lower-cased validation closes this; cases where it
  fails to follow the JSON schema are caught by the ADR-009@0.1.0 observability path
  + ADR-002@0.1.0 OmniRoute fallback retry.
- Per-field accuracy ≥70% (K2) is on the LLM, not on the sidecar — we measure but do
  not gate on it at the C19 boundary. PRD-003@0.1.3 §6 K2 is a metric, not a hard reject.

**Follow-up work:**

- TKT-030@0.1.0 implements C19 Workout Logger including the closed-enum schema, the
  forced-output JSON prompt, the deterministic validator, and the photo-extraction path
  (PRD-003@0.1.3 §5 US-3 photo bullet) reusing C7 photo recognition.
- C22 Adaptive Summary Composer (TKT-027@0.1.0) maintains the workout-type → Russian
  rendering table.
- After PRD-003@0.1.3 ships and a 30-day production window of `other`-bucket data is
  available, a follow-up ADR may promote `climbing`, `rowing`, `pilates`, etc. to
  first-class types with PO sign-off.

## References

- PRD-003@0.1.3 §2 G3, §5 US-3, §6 K2 (workout-type goals + golden-set acceptance)
- ADR-002@0.1.0 OmniRoute extraction LLM (reused without modification)
- ADR-006@0.1.0 Summary recommendation guardrails (forced-output-set pattern reused)
- ADR-009@0.1.0 Observability + redaction (extraction LLM call telemetry already wired)
- ADR-013@0.1.0 Allowlist hot-reload (acceptable parallel for runtime-tunable lists;
  not chosen for taxonomy because measurement contract requires stability)
- `docs/prompts/architect.md` Phase 5 LLM-pick exception (no new pick required here;
  existing OmniRoute pick reused)
- PRD-003@0.1.3 §7 Technical Envelope: "External dependencies … reused for
  sleep-by-voice, workout-by-voice, workout-by-photo, mood-by-voice. PRD-003@0.1.3 introduces
  no new external dependency."
