---
id: ADR-022
title: Provider-agnostic LLM abstraction (OpenAI-compatible HTTP)
status: proposed
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
supersedes: ADR-002
created: 2026-05-25
updated: 2026-05-25
superseded_by: null
---

# ADR-022: Provider-agnostic LLM abstraction (OpenAI-compatible HTTP)

## Context

PRD-001@0.3.0 §7 introduces a hard constraint:

> **LLM / voice / vision provider abstraction (hard constraint).** PO MUST be able to swap
> base URL, API key, model alias, and provider per call-type without touching application
> code and without rebuilding. Contract: OpenAI-compatible HTTP (`chat.completions`,
> `audio.transcriptions`, vision via `image_url`). Concrete examples the abstraction MUST
> support transparently: a self-hosted OmniRoute instance running outside this repo,
> OpenRouter, OpenAI direct, vLLM / LiteLLM / Ollama via OpenAI-compatible shims, and
> arbitrary future providers conforming to the same contract. The Architect's chosen
> default (per the bullet above) is an example-config choice, not an architectural lock;
> superseding that default at deploy or runtime is a configuration edit, not a code change
> or rebuild.

This **supersedes** ADR-002@0.1.0 ("OmniRoute-First LLM Routing"), which made OmniRoute a
first-class architectural element (the Phase 0 Recon, the §3 component descriptions, the
§7 Tech Stack Decisions, and the §9.3 egress policy all named OmniRoute as the LLM
ingress). PRD-001@0.3.0 §7 demotes OmniRoute to a single supported provider example
among many; the operator chooses at deploy time and may swap per-call-type at runtime.

ADR-002@0.1.0 still reflects empirical claims about Fireworks pricing, OpenRouter, OmniRoute's
behaviour, and rejected alternatives (local LLM on a no-GPU VPS, direct provider SDKs).
Its history is preserved verbatim per the supersession discipline (frontmatter `status:
superseded`, `superseded_by: ADR-022`); the body is immutable.

The companion concerns are:

- **Voice transcription** — a separate OpenAI-compatible HTTP surface
  (`audio.transcriptions`); see ADR-023@0.1.0 for the same supersession of ADR-003@0.1.0.
- **Vision** — a sub-case of `chat.completions` with `image_url`; ADR-004@0.2.0 amends
  ADR-004@0.1.0 (Qwen-VL is no longer architecturally fixed).
- **Per-call-type configuration** — the structure of `config/llm.json` and how the
  application consumes it is the subject of ADR-024@0.1.0.

## Options Considered (≥3 real options, no strawmen)

### Option A: Per-provider TypeScript adapter modules

- Description: Keep the `omniRouteClient.ts` style, add a sibling `openRouterClient.ts`,
  `openAiClient.ts`, `vllmClient.ts`, etc. The C16/C17/C19/C20/C22 components and C5
  voice / C7 photo paths import the adapter that matches the configured provider for
  that call-type at boot.
- Pros: Each adapter can use provider-specific SDK features (OpenAI's `tools` parameter
  shape, Anthropic's `system` block, etc.).
- Cons:
  - Violates PRD-001@0.3.0 §7 "without touching application code". Adding a new provider
    means writing a new TS module. The constraint explicitly requires a config edit, not
    a code edit.
  - The contract isn't OpenAI-compatible HTTP; it's "OpenAI-compatible-or-the-other-thing
    we coded for". Future providers conforming to the contract are still rejected at
    runtime because they don't have a TS adapter.
  - Per-provider TS adapters duplicate retry, rate-limit, JSON-mode validation, and
    observability boilerplate.
- Cost / latency / ops burden: high — each new provider needs a dev cycle, a PR, a
  review, and a deploy.

### Option B: Single OpenAI-compatible HTTP client + per-call-type provider map

- Description: One `LlmClient` module that accepts `{baseUrl, apiKey, model}` per call,
  speaks the OpenAI HTTP contract (`POST /v1/chat/completions`,
  `POST /v1/audio/transcriptions`, vision via `image_url`), and lets configuration drive
  which `(baseUrl, apiKey, model)` triple is used per call-type. The model registry
  (ADR-024@0.1.0) holds aliases like `kbju.text` → `(provider: omniroute, model:
  gpt-oss-20b)`; application code asks for the alias, not a provider.
- Pros (concrete):
  - Matches the PRD-001@0.3.0 §7 constraint verbatim: `chat.completions` +
    `audio.transcriptions` + vision via `image_url` is exactly the OpenAI HTTP surface
    every listed provider speaks (OmniRoute, OpenRouter, OpenAI direct, vLLM, LiteLLM,
    Ollama all expose this contract — sources: <https://platform.openai.com/docs/api-reference/chat>,
    <https://openrouter.ai/docs/api-reference/overview>, <https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html>,
    <https://docs.litellm.ai/docs/proxy/quick_start>, <https://github.com/ollama/ollama/blob/main/docs/openai.md>,
    <https://github.com/diegosouzapw/OmniRoute>).
  - Adding a new provider is a `config/llm.json` edit. No code, no rebuild.
  - One retry / rate-limit / JSON-mode / observability code path; one place to harden.
- Cons (concrete):
  - Provider-specific advanced features (extended JSON-schema modes, tool-calling
    variants, prompt-caching headers) are out of reach unless the operator configures a
    provider that exposes them through the OpenAI shape. Acceptable: PRD-001@0.3.0 §7
    explicitly contracts to the OpenAI HTTP surface, so falling outside it is the
    operator's call to a non-conforming provider, not the application's problem.
  - Quality / latency between providers can vary materially; the application must not
    silently swap providers mid-call. Operator-locked per-call-type binding is the
    expected discipline.
- Cost / latency / ops burden: low — one TypeScript module, one config schema, one
  observability surface. Adding a new provider is a config edit + a documented restart
  (no rebuild).

### Option C: Embed LiteLLM / OmniRoute / OpenRouter as the universal abstraction layer

- Description: Pick one of the existing meta-routers and treat it as the only LLM
  surface; application code calls that one URL.
- Pros: All routing / fallback / cost-tracking lives in the chosen router. This is the
  ADR-002@0.1.0 OmniRoute-first model.
- Cons:
  - Violates PRD-001@0.3.0 §7 directly: "swap base URL, API key, model alias and
    provider per call-type without touching application code and without rebuild" cannot
    coexist with "the only LLM surface is one router URL". The router IS the lock-in.
  - LiteLLM / OmniRoute / OpenRouter are themselves OpenAI-compatible. The application
    doesn't gain by knowing about them; the operator points the abstraction at one of
    them when desired.
  - Forks the test surface — the project would have to maintain a router instance for
    CI as well as production.
- Cost / latency / ops burden: medium — adds a runtime hop the operator may not want.

### Option D: Custom protocol over gRPC / REST tailored to the project

- Description: Define an internal contract (`POST /llm/chat`, `POST /llm/audio`, etc.)
  with project-specific fields; bridge each provider behind a sidecar adapter.
- Pros: Maximum control over inputs / outputs / retry semantics.
- Cons: Reintroduces the per-provider adapter problem (Option A) at the sidecar layer
  instead of the application layer. Doesn't match any existing provider contract, so
  every provider needs a custom shim. Violates "OpenAI-compatible HTTP" in PRD-001@0.3.0
  §7. Highest ops burden of the four options.

## Decision

We will use **Option B: a single OpenAI-compatible HTTP client (`src/llm/llmClient.ts`)
that accepts `{baseUrl, apiKey, model}` per call, with per-call-type provider selection
driven by the `config/llm.json` model registry defined in ADR-024@0.1.0**.

The contract is the OpenAI HTTP surface (`POST /v1/chat/completions`,
`POST /v1/audio/transcriptions`, vision messages with `image_url` content blocks). Any
provider that speaks this contract is supported transparently by configuration.

**Concrete bindings for this ArchSpec:**

- The runtime client module is `src/llm/llmClient.ts`. It exports
  `chatCompletion(opts)`, `transcribe(opts)`, `vision(opts)`, and a typed
  `LlmClientConfig`.
- Configuration is read from `config/llm.json` (ADR-024@0.1.0). Application code
  references **call-type aliases** (`kbju.meal_text`, `kbju.summary_recommendation`,
  `kbju.modality_router_classifier`, `kbju.water_volume_extractor`,
  `kbju.sleep_duration_extractor`, `kbju.workout_extractor`, `kbju.mood_inferrer`,
  `kbju.voice_transcription`, `kbju.photo_recognition`), not provider names or model
  IDs.
- Per-call-type provider entries in `config/llm.json` carry `{provider_id, base_url,
  api_key_env, model, fallback_call_type?}`. The operator may set `provider_id` to
  `omniroute`, `openrouter`, `openai`, `vllm`, `litellm`, `ollama`, `fireworks`, or any
  string that is a label for the operator's runtime choice; the application does not
  branch on `provider_id` for behaviour.
- `api_key_env` names a `LLM_*` environment variable (ADR-024@0.1.0 §Secrets). The
  application reads `process.env[api_key_env]` at request time; missing keys fail fast
  with a structured error.
- Existing legacy environment variables `OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY`
  remain wired as one-version backward-compatibility aliases for the default LLM
  provider entry; the deprecation is documented in `.env.example` and removed in the
  next minor bump after v0.7.0.
- C13 Stall Watchdog (ADR-012@0.1.0) wraps the new `llmClient.ts`; the algorithm is
  unchanged. C10 cost / observability emits the `provider_id` and `model` as
  metric labels (no raw keys).
- The reviewer model family vs executor model family separation (CONTRIBUTING.md §LLM
  hygiene) is preserved by the orchestrator's per-cycle pick, NOT by hard-coding model
  IDs in this ADR. The orchestrator is the authority on which alias maps to which model
  at runtime, per the §13 Q5 PO ratification preserved in ARCH-001@0.6.2.

**Why the losers lost:**

- **Option A (per-provider TS adapters):** the constraint is "without touching
  application code"; per-provider TS modules are application code by definition.
- **Option C (embed a router as the only abstraction):** the router is the lock-in the
  PRD §7 constraint expressly forbids; the operator may still choose to point Option B
  at a router, but the architecture must not require it.
- **Option D (custom protocol):** introduces every provider-shim cost of Option A
  without using the OpenAI HTTP surface PRD §7 names as the contract.

## Consequences

**Positive:**

- The PO can swap from OmniRoute to OpenRouter to OpenAI direct (or any future
  OpenAI-compatible provider) by editing `config/llm.json` and one or two `LLM_*`
  environment variables; no rebuild, no `npm run build`.
- The application has one place where retry / timeout / JSON-mode / observability /
  redaction live (`src/llm/llmClient.ts`).
- The model-registry pattern (ADR-024@0.1.0) makes per-call-type override (e.g. "use a
  cheaper model for the C16 router-classifier on this VPS") a config edit, mirroring
  how `config/allowlist.json` (ADR-013@0.1.0) replaced env-var allowlists.
- Existing tests pass without rewrite: the contract shape (request → response) is
  unchanged from ADR-002@0.1.0 + ADR-018@0.1.0 era code; only the indirection layer
  changes.

**Negative / trade-offs accepted:**

- Provider-specific advanced features (Anthropic prompt caching, OpenAI structured
  outputs schema-by-name, etc.) are not first-class. Operators who need them point
  Option B at a router that exposes them through the OpenAI HTTP surface, or accept the
  feature is unavailable until a future ADR opens that path.
- Provider quality varies; the operator owns the choice of provider per call-type. The
  architecture provides the abstraction, not the provider taste.
- ADR-018@0.1.0 historical model picks are no longer authoritative (already noted in
  ARCH-001@0.6.2 §13 Q5). They are illustrative defaults the orchestrator may override
  per cycle; ADR-018@0.1.0 stays in `proposed` for context, not for model identity
  binding.

**Follow-up work:**

- ADR-023@0.1.0 supersedes ADR-003@0.1.0 with the same provider-agnostic discipline for
  voice transcription.
- ADR-024@0.1.0 defines `config/llm.json`'s schema, hot-reload behaviour (or lack
  thereof), validation rules, and consumer API.
- ARCH-001@0.7.0 §3.X adds C23 LLM Gateway as the conceptual home of the abstraction;
  existing C5 / C6 / C7 / C9 / C16..C22 components route through it instead of naming a
  provider.
- TKT-033@0.1.0 implements the `llmClient.ts` refactor and the `LLM_*` env-var rename
  with one-version backward-compat aliasing.
- TKT-035@0.1.0 migrates `config/*.json` extractor manifests onto call-type aliases.
- `infra/omniroute/README.md` is reframed as `docs/architecture/llm-providers.md`
  listing OmniRoute / OpenRouter / OpenAI direct / vLLM / LiteLLM / Ollama as concrete
  examples (TKT-033@0.1.0 cleans up the old infra/ path).

## References

- PRD-001@0.3.0 §7 (provider abstraction hard constraint)
- ADR-002@0.1.0 (superseded — OmniRoute-first; preserved verbatim for empirical claims)
- ADR-003@0.1.0 (superseded by ADR-023@0.1.0 — voice transcription)
- ADR-004@0.1.0 (amended by ADR-004@0.2.0 — vision picks now via registry)
- ADR-012@0.1.0 (C13 Stall Watchdog — wraps the new client)
- ADR-013@0.1.0 (hot-reload config pattern — analogue for the new registry)
- ADR-018@0.1.0 (per-site picks — preserved as illustrative defaults; orchestrator owns
  runtime picks per ARCH-001@0.6.2 §13 Q5)
- ADR-024@0.1.0 (PO-pluggable model registry — defines `config/llm.json`)
- OpenAI Chat Completions reference: <https://platform.openai.com/docs/api-reference/chat>
- OpenAI Audio Transcriptions reference: <https://platform.openai.com/docs/api-reference/audio/createTranscription>
- OpenAI Vision (`image_url` message blocks): <https://platform.openai.com/docs/guides/vision>
- OpenRouter (OpenAI-compatible meta-router): <https://openrouter.ai/docs/api-reference/overview>
- vLLM OpenAI-compatible server: <https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html>
- LiteLLM proxy (OpenAI-compatible): <https://docs.litellm.ai/docs/proxy/quick_start>
- Ollama OpenAI-compatible API: <https://github.com/ollama/ollama/blob/main/docs/openai.md>
- OmniRoute (now one example among many): <https://github.com/diegosouzapw/OmniRoute>
