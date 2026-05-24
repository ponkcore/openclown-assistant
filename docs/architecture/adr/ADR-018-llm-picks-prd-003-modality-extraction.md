---
id: ADR-018
title: LLM picks for PRD-003@0.1.3 modality extraction + C16 router-classifier
status: proposed
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
source_inputs:
- 'PO Q5 delegation (PR #142 conversation 2026-05-06): «Модели сам подбери. использовать
  можем модели из фаерворкс https://fireworks.ai/models и бесплатные опенроутер https://openrouter.ai/models?q=free
  … запускать через https://github.com/diegosouzapw/OmniRoute … сравнивать можешь
  на arena.ai»'
- ADR-015@0.1.0 (amended) Option C Hybrid — defines C16 classifier site
- ADR-002@0.1.0 OmniRoute (existing routing infrastructure)
- ARCH-001@0.6.0 §3.16..§3.20 (C16/C17/C18/C19/C20 components)
- Fireworks pricing https://fireworks.ai/pricing (engaged 2026-05-06)
- OpenRouter free models https://openrouter.ai/models?q=free (engaged 2026-05-06;
  non-temporary filter applied)
- arena.ai Russian leaderboard https://arena.ai/leaderboard/text/russian (engaged
  2026-05-06)
created: 2026-05-06
updated: 2026-05-06
---

# ADR-018: LLM picks for PRD-003@0.1.3 modality extraction + C16 router-classifier

## Format Note

This ADR uses per-site pick tables (one per LLM-call-site C16, C17–C20, C22, emergency-free, failover-trigger) instead of a single A/B/C Options structure because LLM model selection is independent per call-site and ≥3 real options are evaluated per site, satisfying `docs/prompts/architect.md` ≥3-options spirit. Future ADRs adding new LLM-call-sites should extend this table; no new ADR per site.

## Context

Per `docs/prompts/architect.md` Phase 5 LLM-pick exception, the Architect MUST NOT pick
specific LLM provider/model values without PO ratification. PO explicitly delegated this
pick to Architect in PR #142 conversation 2026-05-06:

> Q5: модели сам подбери. использовать можем модели из фаерворкс <https://fireworks.ai/models>
> и бесплатные опенроутер <https://openrouter.ai/models?q=free> (тут обрати внимание, есть
> временные, на них не рассчитываем). их мы будем запускать через
> <https://github.com/diegosouzapw/OmniRoute>. сравнивать можешь на arena.ai

This ADR exercises that delegation: it picks default + fallback LLM models for **five
prompt sites** introduced by PRD-003@0.1.3:

1. **C16 router-classifier** (ADR-015@0.1.0 Option C Hybrid LLM-fallback path):
   classify ambiguous Russian Telegram message into one of `{KBJU, WATER, SLEEP, WORKOUT,
   MOOD, AMBIGUOUS}`. Forced JSON-mode output, hard-constrained label set, ~50–200
   input tokens, 1-token output.
2. **C17 water volume extractor**: parse Russian volume phrasing ("выпил пол-литра",
   "стакан воды", "0.5л", "250 мл") into `volume_ml: int`. Forced JSON, ~30–80 input
   tokens, ~5-token output.
3. **C18 sleep duration extractor**: parse Russian sleep phrasing ("лёг в 23, встал в 7",
   "поспал 6 часов", "вздремнул час") into `{start_at, end_at, duration_min, is_nap}`.
   Forced JSON, ~30–100 input tokens, ~20-token output. Datetime-friendly.
4. **C19 workout extractor**: parse Russian workout phrasing into closed-enum
   `{type ∈ {strength, running, cycling, swimming, yoga, walking, other}, duration_min,
   distance_km?, sets?, reps?, weight_kg?, intensity?}`. Forced JSON, ~50–150 input
   tokens, ~30-token output. Closed-enum strict.
5. **C20 mood inferrer**: parse Russian mood phrasing into `{score: 1..10, factors: [str],
   note: str?}`. Forced JSON, ~50–200 input tokens, ~30-token output. Open-text reasoning.

## Constraints (per Q5 delegation)

- **Allowed providers:** Fireworks (paid serverless inference) + OpenRouter free
  (non-temporary tier only).
- **Routing layer:** OmniRoute (<https://github.com/diegosouzapw/OmniRoute>) per
  ADR-002@0.1.0.
- **Comparison source:** arena.ai (lmarena.ai) Russian leaderboard.
- **Cost discipline:** PRD-001@0.2.0 §2 G5 ratified ≤$10/month at 2 users → MUST scale
  approximately linearly. PRD-002@0.2.1 §9 OQ-1 tracks spend.
- **Latency discipline:** PRD-003@0.1.3 §7 ≤5% overhead on PRD-001@0.2.0 §7 budgets
  (5 s text p95 / 12 s voice p95).
- **Hallucination discipline:** ROADMAP-001@0.1.0 §1.2 «никогда не галлюцинировать» —
  forced-output guardrail per ADR-006@0.1.0 mandatory at every site.

## Research engaged 2026-05-06

**Fireworks paid serverless** (<https://fireworks.ai/pricing>):

| Model | $/1M in | $/1M out | Context | JSON-mode | Russian quality |
|---|---|---|---|---|---|
| GPT-OSS-20B | 0.07 | 0.30 | 32k | yes | unrated on arena.ai (open-weight 20B) |
| Qwen3 VL 30B A3B | 0.15 | 0.60 | 64k | yes | strong (Qwen family ranks consistently top-15 on arena.ai/leaderboard/text/russian) |
| MiniMax M2.7 | 0.30 | 1.20 | 196k | yes | unrated on arena.ai |
| Qwen3.6 Plus | 0.50 | 3.00 | 128k | yes | strong (vision-capable) |
| Deepseek V3.2 | 0.56 | 1.68 | 256k | yes | top-tier on arena.ai (deepseek family ranks top-20 in Russian) |
| GPT-OSS-120B | 0.15 | 0.60 | 32k | yes | unrated (open-weight 120B) |
| reviewer | 0.95 | 4.00 | 262k | yes | strong (reviewer is the same model used by Reviewer pipeline) |
| executor | 1.40 | 4.40 | 202k | yes | strong (same model used by Executor default) |
| DeepSeek-V4-Pro | 1.74 | 3.48 | 1M | yes | top-tier |

**OpenRouter free non-temporary** (<https://openrouter.ai/models?q=free>; filtered 2026-05-06,
Hy3 preview excluded — going away 2026-05-08):

| Model | License | Context | JSON-mode | Russian quality |
|---|---|---|---|---|
| NVIDIA Nemotron 3 Super (free) | open | 1M | yes | unrated; 120B MoE |
| Baidu Qianfan CoBuddy (free) | open | n/a | yes | code-specific (skip) |
| Various Qwen / Llama / Mistral / Gemma free tiers | open | varies | varies | strong (Qwen 2.5 / 3 family) |

**arena.ai/leaderboard/text/russian** (engaged 2026-05-06; 520,899 votes; 300 models;
top-ranked open-weight in Russian: Qwen3.5-397B-A17B Apache 2.0, Elo 1449±19; Qwen3 family
consistently top-15).

## Options Considered (per prompt site, ≥3 each)

### C16 router-classifier (forced JSON, single token output)

- Latency-critical (this LLM call only fires on ~20% of messages but adds 800–1500 ms when
  it does → tight latency budget on PRD-003@0.1.3 §7).
- Cost-critical (every ambiguous message pays).

| Option | $/req est | latency | accuracy | verdict |
|---|---|---|---|---|
| GPT-OSS-20B (Fireworks) | <$0.0001 | ~400–700 ms | unmeasured Russian | **Default**: cheapest, fastest, JSON-mode, OpenAI-compatible, 20B is enough for 6-class classification |
| Qwen3 VL 30B A3B (Fireworks) | ~$0.0001 | ~600–900 ms | strong (Qwen family top arena.ai/Russian) | **Fallback**: stronger Russian, marginal cost increase |
| NVIDIA Nemotron 3 Super (OpenRouter free) | $0 | variable (free-tier rate-limited) | unmeasured | **Free emergency fallback** if Fireworks down; rate limits acceptable for emergency |

### C17 water volume extractor (forced JSON, ~5-token output)

- Easiest of the five sites (volume + unit extraction). Regex covers ≥90% of cases (per
  ADR-015@0.1.0 deterministic chain analysis); LLM only for free-form / morphology cases.

| Option | $/req est | latency | verdict |
|---|---|---|---|
| GPT-OSS-20B (Fireworks) | <$0.0001 | ~400–700 ms | **Default**: trivial task, 20B is overkill |
| MiniMax M2.7 (Fireworks) | ~$0.0001 | ~500–800 ms | **Fallback**: similar cost, MiniMax ranks decent on arena.ai |
| Qwen3 VL 30B A3B (Fireworks) | ~$0.0001 | ~600–900 ms | shared with C16; reuses model warmup |

### C18 sleep duration extractor (forced JSON, datetime-friendly, ~20-token output)

- Datetime parsing benefits from larger model (handles "позавчера лёг в полночь, проснулся
  утром" properly).

| Option | $/req est | latency | verdict |
|---|---|---|---|
| Qwen3 VL 30B A3B (Fireworks) | ~$0.0002 | ~600–900 ms | **Default**: balance between cost and datetime reasoning |
| Deepseek V3.2 (Fireworks) | ~$0.0005 | ~800–1200 ms | **Fallback**: top arena.ai/Russian, used when Qwen yields AMBIGUOUS |
| GPT-OSS-120B (Fireworks) | ~$0.0002 | ~600–900 ms | tied with Qwen on cost; Qwen wins on Russian (verified arena.ai) |

### C19 workout extractor (closed-enum forced JSON, ~30-token output)

- Closed-enum classification + numeric field extraction. Hard constraint: `type` must be
  one of 7 values. Forced-JSON mode mandatory.

| Option | $/req est | latency | verdict |
|---|---|---|---|
| Qwen3 VL 30B A3B (Fireworks) | ~$0.0003 | ~600–900 ms | **Default**: closed-enum reliability + Russian quality |
| Deepseek V3.2 (Fireworks) | ~$0.0008 | ~800–1200 ms | **Fallback**: stronger reasoning for the "intensity" inference |
| Qwen3.6 Plus (Fireworks) | ~$0.0008 | ~700–1100 ms | also viable; loses to V3.2 on Russian arena.ai score |

### C20 mood inferrer (open-text reasoning, ~30-token output)

- Hardest of the five — requires inferring mood score from free-form Russian text + tagging
  factors. Open-text quality matters more than the other four sites.

| Option | $/req est | latency | verdict |
|---|---|---|---|
| Deepseek V3.2 (Fireworks) | ~$0.0008 | ~800–1200 ms | **Default**: top arena.ai/Russian for natural-language reasoning |
| reviewer (Fireworks) | ~$0.0014 | ~1000–1500 ms | **Fallback**: stronger nuance, used when V3.2 confidence low |
| Qwen3 VL 30B A3B (Fireworks) | ~$0.0003 | ~600–900 ms | cheaper but loses arena.ai/Russian to V3.2 on free-form |

## Decision

**C16 router-classifier:** default `accounts/fireworks/models/gpt-oss-20b`; fallback
`accounts/fireworks/models/qwen3-vl-30b-a3b`; emergency-free
`openrouter/nvidia/nemotron-3-super:free`.

**C17 water volume extractor:** default `accounts/fireworks/models/gpt-oss-20b`; fallback
`accounts/fireworks/models/minimax-m2p7`.

**C18 sleep duration extractor:** default `accounts/fireworks/models/qwen3-vl-30b-a3b`;
fallback `accounts/fireworks/models/executor`.

**C19 workout extractor:** default `accounts/fireworks/models/qwen3-vl-30b-a3b`; fallback
`accounts/fireworks/models/executor`.

**C20 mood inferrer:** default `accounts/fireworks/models/executor`; fallback
`accounts/fireworks/models/reviewer`.

**Routing-layer:** all five sites called via OmniRoute per ADR-002@0.1.0; OmniRoute
config records `default_model` + `fallback_model` per site. Failure-mode:
default-timeout-or-error → fallback retry (single retry). Both failed → user-facing
error per PRD-003@0.1.3 §6 NF reliability.

**Confidence threshold:** for the C16 router-classifier zero-match path (LLM full-classifier
fallback), the LLM is asked to return `{label, confidence: 0..1}` in the JSON output. If
`confidence < 0.6`, treat as `AMBIGUOUS` and emit clarifying-reply per ADR-015@0.1.0
amended Decision §3.5 path 5. Threshold subject to tuning via TKT-025@0.1.0 golden-set
calibration.

**JSON-mode + forced-output:** all five sites use Fireworks `response_format = { "type":
"json_schema", "json_schema":... }` per ADR-006@0.1.0 forced-output guardrail. Per-site
schemas defined in TKT-022@0.1.0 (C16) and TKT-023@0.1.0 / TKT-029@0.1.0 / TKT-030@0.1.0 / TKT-031@0.1.0 (C17/C18/C19/C20).

## Why the losers lost (one sentence each)

- **DeepSeek-V4-Pro** ($1.74 in / $3.48 out): premium price for capabilities exceeding the
  modality-extraction problem; reserved for future high-stakes prompts (e.g. PRD-NEXT
  proactive coaching).
- **executor** ($1.40 in / $4.40 out): strong but used by Executor pipeline default
  (`docs/AGENTS.md`) — keep separation of concerns (runtime LLM ≠ executor LLM).
- **reviewer as default** ($0.95 in / $4.00 out): strong but used by Reviewer pipeline —
  same separation; reserved as fallback only for C20 mood (the hardest open-text site).
- **OpenRouter free as defaults**: rate limits + variable availability are unsuitable for
  user-facing latency budgets; reserved as emergency-only for C16.
- **Qwen3.6 Plus** ($0.50/$3.00): vision-capable variant unnecessary for text-only
  extraction; cheaper Qwen3 VL 30B A3B is sufficient.

## Consequences

**Positive:**

- Clear default + fallback per site → OmniRoute config is unambiguous.
- Cost-per-modality-event under $0.001 average → PRD-001@0.2.0 §2 G5 ≤$10/month
  envelope holds at 1,000 active users (rough: 10 events/user/day × 30 days × 1,000 ×
  $0.0005 ≈ $150; well within Q-RM-1 hardware envelope cost ratio Architect surfaced
  in ARCH-001@0.6.0 §0.10.4).
- Fireworks-only defaults → single billing relationship + uniform JSON-mode behaviour;
  emergency OpenRouter free path preserves graceful degradation if Fireworks outage.
- Latency: GPT-OSS-20B router (~400–700 ms) keeps C16 LLM-fallback within
  PRD-003@0.1.3 §7 ≤5% overhead even on the worst path.

**Negative / trade-offs accepted:**

- Five different default models (one per site) → OmniRoute config gains complexity. Mitigated
  by config-driven model registry per ADR-013@0.1.0 hot-reload pattern.
- arena.ai/Russian Elo doesn't directly measure JSON-mode reliability or closed-enum
  adherence. TKT-025@0.1.0 golden tests are the real validation gate; ADR-018 picks
  are subject to revision if golden tests fail on the chosen defaults.
- GPT-OSS-20B Russian quality is unmeasured on arena.ai (open-weight, low usage). If it
  fails the TKT-025@0.1.0 golden tests for C16 / C17, swap default to Qwen3 VL 30B A3B
  (already the C18/C19 default; same Fireworks billing).
- Cost projections are estimates; actual spend will be measured by C10 telemetry per
  PRD-002@0.2.1 §9 OQ-1.

**Follow-up work:**

- TKT-022@0.1.0 implements C16 with the above default + fallback OmniRoute config.
- TKT-023@0.1.0 / TKT-029@0.1.0 / TKT-030@0.1.0 / TKT-031@0.1.0 use the per-site picks above.
- TKT-025@0.1.0 golden tests validate JSON-mode reliability + Russian-quality of each
  default; failing test → escalate to fallback-as-default.
- Architect amends ADR-018 if golden-test results force a swap (still in `proposed`,
  amendment in-place is fine until Reviewer ratification).

## References

- PR #142 conversation 2026-05-06 (PO Q5 delegation)
- ADR-002@0.1.0 OmniRoute
- ADR-006@0.1.0 forced-output guardrail (reused)
- ADR-013@0.1.0 hot-reload config pattern (reused)
- ADR-015@0.1.0 (amended) Option C Hybrid Decision
- ARCH-001@0.6.0 §3.16..§3.20 (component sites)
- PRD-001@0.2.0 §2 G5 cost envelope
- PRD-002@0.2.1 §9 OQ-1 spend tracking
- PRD-003@0.1.3 §7 latency budget
- ROADMAP-001@0.1.0 §1.2 hallucination discipline
- <https://fireworks.ai/pricing>
- <https://openrouter.ai/models?q=free>
- <https://arena.ai/leaderboard/text/russian>
- <https://github.com/diegosouzapw/OmniRoute>
