---
id: ADR-023
title: Provider-agnostic voice transcription
status: proposed
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
supersedes: ADR-003
created: 2026-05-25
updated: 2026-05-25
superseded_by: null
---

# ADR-023: Provider-agnostic voice transcription

## Context

PRD-001@0.3.0 §7 makes provider abstraction a hard constraint across LLM, voice, AND
vision call-types (see ADR-022@0.1.0 for the LLM half). Voice transcription must speak
the OpenAI-compatible `POST /v1/audio/transcriptions` HTTP surface so that the operator
can swap base URL, API key, model alias, and provider per call-type without touching
application code and without rebuilding.

This **supersedes** ADR-003@0.1.0 ("Fireworks Whisper Voice Transcription"), which
locked Fireworks Whisper V3 Turbo as the v0.1 voice provider through the
OmniRoute/audio path. Under PRD-001@0.3.0 §7, Fireworks Whisper V3 Turbo is no longer
architecturally fixed; it is now an **example default** the operator may keep, replace
with OpenAI Whisper, replace with a self-hosted faster-whisper proxy, replace with
Deepgram via an OpenAI-compatible shim, or replace with any future provider conforming
to the contract.

ADR-003@0.1.0's empirical claims (Fireworks Whisper V3 Turbo at $0.0009/audio minute,
Streaming ASR v2 at $0.0035/audio minute, Deepgram pricing, AssemblyAI pricing, the
no-GPU local-faster-whisper trade-off) remain useful as reference; the supersession
preserves the body verbatim and updates only the frontmatter (`status: superseded`,
`superseded_by: ADR-023`).

The PRD-001@0.3.0 §7 latency / failure UX commitments survive unchanged: voice clips
≤15 s, soft ≤8 s p95 / hard ≤30 s p100 voice round-trip, raw audio deleted immediately
after extraction, "Не расслышал, напиши текстом" first-failure copy, manual KBJU entry
on second consecutive voice failure (PRD-001@0.3.0 §5 US-7).

## Options Considered (≥3 real options, no strawmen)

### Option A: Per-provider TypeScript voice adapters

- Description: One adapter module per concrete provider (Fireworks, OpenAI, Deepgram,
  AssemblyAI, faster-whisper sidecar, etc.). Application code imports the adapter that
  matches the operator's choice at boot.
- Pros: Each adapter could exploit provider-specific extensions (Deepgram's diarization,
  AssemblyAI's speaker labels, etc.).
- Cons:
  - Violates PRD-001@0.3.0 §7 "without touching application code". A new provider needs
    a TS module, not a config edit.
  - The OpenAI `audio.transcriptions` surface already covers the common case
    (multipart `file` upload + `model` + `language` + JSON response with `text`),
    rendering most provider-specific extensions unnecessary for our latency / cost
    envelope.
  - Multiplies the test surface for every provider that gets added.
- Cost / latency / ops burden: high — each new provider needs a dev cycle.

### Option B: Single OpenAI-compatible HTTP voice client + per-call-type provider map

- Description: One `voiceClient.ts` module that speaks `POST /v1/audio/transcriptions`
  multipart-form-data with a `file` field, a `model` field, and optional `language` /
  `prompt` / `temperature` fields, and a JSON response with at minimum `text`.
  Configuration drives `(baseUrl, apiKey, model)` per call. Reuses the
  `config/llm.json` registry (ADR-024@0.1.0); the call-type alias is
  `kbju.voice_transcription`.
- Pros (concrete):
  - Matches PRD-001@0.3.0 §7 verbatim. The OpenAI audio API is the de-facto standard
    OpenAI-compatible providers implement (sources: <https://platform.openai.com/docs/api-reference/audio/createTranscription>,
    OpenRouter does not yet host audio in 2026-05 — but Whisper deployments on
    Fireworks (<https://docs.fireworks.ai/api-reference/audio-transcriptions>),
    Groq (<https://console.groq.com/docs/speech-text>), Deepgram OpenAI-compatible
    shim (<https://developers.deepgram.com/docs/openai-sdk-migration>),
    self-hosted faster-whisper-server (<https://github.com/fedirz/faster-whisper-server>),
    and OpenAI direct all expose this contract).
  - Adding a new provider is a config edit, not code.
  - One retry / latency / observability code path; one place to enforce the
    raw-audio-delete obligation.
- Cons (concrete):
  - Provider-specific advanced features (word-level timestamps with non-OpenAI shapes,
    speaker diarization, language-detection nuances) are out of reach. Acceptable: PRD
    contracts to the OpenAI surface; we don't lose anything we use today.
  - Some providers behind shims may require additional headers (e.g. Deepgram's
    `Authorization: Token <key>` instead of `Bearer`). The client must support a
    per-provider `auth_header_template` config knob; this is a config-driven knob,
    not application code.
- Cost / latency / ops burden: low — one TypeScript module, one schema, one ops surface.

### Option C: Embed a single audio router as the only voice surface

- Description: Like ADR-022@0.1.0 Option C, embed one router (LiteLLM-audio,
  OmniRoute-audio, or similar) and treat it as the only voice surface.
- Pros: Concentrates retry / fallback in one place.
- Cons: Same lock-in objection as ADR-022@0.1.0 Option C; PRD-001@0.3.0 §7 explicitly
  rejects this. Audio router ecosystem is also less mature than the LLM router
  ecosystem; LiteLLM-audio coverage in 2026-05 is partial (sources:
  <https://docs.litellm.ai/docs/audio_transcription>).
- Cost / latency / ops burden: medium-to-high — adds a runtime hop the operator may not
  want.

### Option D: Local faster-whisper sidecar as the only path

- Description: Run faster-whisper inside a Docker Compose service, expose it on the
  internal network, and bind every voice call to it.
- Pros: No per-minute provider cost; raw audio never leaves the VPS.
- Cons:
  - Violates PRD-001@0.3.0 §7 "without touching application code" only by *direction*
    (the application has to know about a local sidecar); but more importantly,
    PRD-001@0.3.0 §7 requires the operator to be able to swap to a hosted provider
    without code changes. A local-only architecture is the lock the constraint forbids.
  - Faster-whisper steady RAM is 0.8–1.5 GiB on a no-GPU VPS (per ADR-003@0.1.0 §Option
    D analysis), which would consume most of the §10.3 2 GiB envelope share.
  - The provider-agnostic abstraction itself is the *enabler* for Option D — an
    operator who wants to run a local faster-whisper sidecar (e.g. via
    `faster-whisper-server`'s OpenAI-compatible shim) configures `kbju.voice_transcription`
    to point at it. So D-as-architecture is wrong; D-as-deployment-choice is supported
    by Option B for free.

## Decision

We will use **Option B: a single OpenAI-compatible voice client (`src/voice/voiceClient.ts`
or whatever path TKT-034@0.1.0 picks) with per-call-type provider selection driven by
`config/llm.json`'s `kbju.voice_transcription` alias (ADR-024@0.1.0)**.

**Concrete bindings:**

- `kbju.voice_transcription` is a first-class call-type alias in `config/llm.json`.
- Default operator example config maps `kbju.voice_transcription` to `(provider:
  fireworks, base_url: https://api.fireworks.ai/inference/v1, api_key_env:
  LLM_FIREWORKS_API_KEY, model: whisper-v3-turbo)`. This preserves the v0.1 default
  without locking it.
- `docs/architecture/llm-providers.md` documents alternative voice-provider snippets
  (OpenAI direct, Deepgram OpenAI-compatible shim, Groq Whisper, faster-whisper-server
  self-hosted), each as a `kbju.voice_transcription` config entry.
- The voice client wraps the existing C5 contract (transcript text + duration metadata
  + raw-audio deletion obligation). C13 Stall Watchdog wraps it identically to the LLM
  client (ADR-022@0.1.0).
- C10 cost / observability emits `provider_id` and `model` as labels (not as raw
  values); spend is reconciled per provider per ADR-024@0.1.0 §Cost.
- `OMNIROUTE_BASE_URL` / `OMNIROUTE_API_KEY` are deprecated in favour of `LLM_*`
  variables (ADR-024@0.1.0 §Secrets); one-version backward-compat alias documented in
  `.env.example`.

**Why the losers lost:**

- **Option A (per-provider TS adapters):** the constraint is "without touching
  application code"; per-provider TS modules are application code.
- **Option C (audio router as only surface):** lock-in PRD §7 forbids; operator may
  still choose to point Option B at LiteLLM-audio if they want.
- **Option D (local faster-whisper as architecture):** local deployment is supported by
  Option B for free; mandating it is an architectural lock the constraint forbids.

## Consequences

**Positive:**

- Voice provider becomes a config edit. `kbju.voice_transcription` repoints at OpenAI
  Whisper, faster-whisper-server, Groq, or any future provider without a rebuild.
- Existing tests pass: the C5 contract shape (transcript text + duration + raw-audio
  delete) is unchanged.
- Per-call retry / latency / observability stays in one place; one surface to harden
  for prompt-injection-via-audio (a low-priority risk; mitigation is already at the
  meal-text LLM boundary).

**Negative / trade-offs accepted:**

- Word-level diarization and speaker labels remain unsupported. Acceptable per PRD
  scope (15-s clips, single-speaker assumption).
- Voice quality on Russian conversational speech varies by provider. The operator owns
  the choice; the architecture provides the swap mechanism.
- Some providers behind shims need a `auth_header_template` config knob (e.g.
  Deepgram's `Authorization: Token <key>`). The client supports it; documented in
  `docs/architecture/llm-providers.md` (TKT-033@0.1.0).

**Follow-up work:**

- TKT-034@0.1.0 implements the `voiceClient.ts` refactor against the existing C5
  surface; preserves test surface; updates `OMNIROUTE_*` env-var names to `LLM_*` with
  one-version backward-compat aliasing.
- ADR-024@0.1.0 codifies `kbju.voice_transcription` as a registered call-type and
  documents the `auth_header_template` knob.
- `docs/architecture/llm-providers.md` (TKT-033@0.1.0) lists ≥3 voice-provider examples
  (Fireworks Whisper, OpenAI Whisper direct, Groq Whisper, faster-whisper-server).
- ADR-003@0.1.0's empirical content remains the source for cost / latency / privacy
  trade-off comparisons; new providers should be added to `docs/architecture/llm-providers.md`
  with sourced cost / latency notes, not in this ADR.

## References

- PRD-001@0.3.0 §7 (provider abstraction hard constraint; voice / LLM / vision)
- ADR-003@0.1.0 (superseded — Fireworks Whisper V3 Turbo; preserved for empirical
  comparison)
- ADR-022@0.1.0 (LLM half of the same abstraction)
- ADR-024@0.1.0 (PO-pluggable model registry; `kbju.voice_transcription` alias)
- ADR-012@0.1.0 (C13 Stall Watchdog; wraps the voice client identically)
- OpenAI Audio Transcriptions reference: <https://platform.openai.com/docs/api-reference/audio/createTranscription>
- Fireworks audio transcriptions: <https://docs.fireworks.ai/api-reference/audio-transcriptions>
- Groq Whisper (OpenAI-compatible): <https://console.groq.com/docs/speech-text>
- Deepgram OpenAI SDK migration: <https://developers.deepgram.com/docs/openai-sdk-migration>
- Self-hosted faster-whisper-server (OpenAI-compatible): <https://github.com/fedirz/faster-whisper-server>
- LiteLLM audio transcription proxy: <https://docs.litellm.ai/docs/audio_transcription>
