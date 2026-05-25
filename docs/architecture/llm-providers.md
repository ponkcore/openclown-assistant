---
id: ARCH-PROVIDERS-001
title: LLM / voice / vision provider setup guide
version: 0.1.0
status: draft
prd_ref: PRD-001@0.3.0
owner: '@po'
created: 2026-05-25
updated: 2026-05-25
---

# LLM / voice / vision provider setup guide

> Architect-authored as part of ARCH-001@0.7.0. Operator-edited as the example pool
> grows. The frontmatter exists so `validate_docs.py` can typecheck cross-references;
> the body is operator reference material — not a contract — and may be re-versioned
> independently of ARCH-001@0.7.0 when example coverage changes.

This guide replaces the v0.5.0 `infra/omniroute/README.md`. Under PRD-001@0.3.0 §7, the
project is provider-agnostic: the operator chooses base URL, API key, model alias, and
provider per call-type via `config/llm.json` (ADR-024@0.1.0). The application contract
is the OpenAI-compatible HTTP surface (`POST /v1/chat/completions`,
`POST /v1/audio/transcriptions`, vision via `image_url` content blocks); any provider
that speaks this contract is supported transparently by configuration.

## How the registry works

Application code references **call-type aliases**, never provider names or model IDs:

```ts
// application code asks for an alias
const reply = await llmClient.chatCompletion({
  call_type: "kbju.modality_router_classifier",
  messages: [...],
  response_format: { type: "json_schema", json_schema: {...} },
});
```

`config/llm.json` (ADR-024@0.1.0) holds the per-call-type binding:

```jsonc
{
  "version": 1,
  "providers": {
    "<provider_id>": { "base_url": "...", "api_key_env": "LLM_<UPPER>_API_KEY" }
  },
  "call_types": {
    "<alias>": { "provider": "<provider_id>", "model": "<model-id>" }
  }
}
```

Switching providers is a `config/llm.json` edit + (if the env-var name changes)
exporting the new `LLM_*` env var and `docker compose up -d` to refresh the
container. Hot-reload picks up file edits within ≤2 s; env-var changes need a
container restart.

## Call-type aliases the application uses

| Alias | Surface | Used by | Notes |
|---|---|---|---|
| `kbju.meal_text` | chat.completions | C6 KBJU Estimator | text meal parsing, summary recommendation support |
| `kbju.summary_recommendation` | chat.completions | C9 Summary Recommendation Service | KBJU-only daily / weekly / monthly recommendation |
| `kbju.modality_router_classifier` | chat.completions | C16 Modality Router | forced JSON, hard-constrained label set; cheapest model OK |
| `kbju.water_volume_extractor` | chat.completions | C17 Water Logger | forced JSON, ~5-token output |
| `kbju.sleep_duration_extractor` | chat.completions | C18 Sleep Logger | forced JSON, datetime-friendly |
| `kbju.workout_extractor` | chat.completions | C19 Workout Logger | closed-enum forced JSON |
| `kbju.mood_inferrer` | chat.completions | C20 Mood Logger | open-text reasoning + score-range guardrail |
| `kbju.voice_transcription` | audio.transcriptions | C5 Voice Transcription Provider | multipart `file` upload, Russian language hint |
| `kbju.photo_recognition` | chat.completions (vision) | C7 Photo Recognition Provider | image_url content block, structured JSON output |

Adding a call-type alias is a code change (the application has to know to ask for
it). Repointing an existing alias to a different provider is a config edit.

## Concrete provider examples

The operator picks one provider per call-type. The default `config/llm.example.json`
ships with a Fireworks-backed setup (matches the v0.5.0 baseline plus ADR-018@0.1.0 picks);
the operator may copy and edit. Below are minimal config snippets per provider; merge
into `config/llm.json` as needed.

### 1. OmniRoute (self-hosted, was the v0.5.0 default)

OmniRoute is a self-hosted OpenAI-compatible meta-router (<https://github.com/diegosouzapw/OmniRoute>)
the PO operates outside this repo with ~30 Fireworks accounts × $50 quota. Useful as
a single-key boundary if the operator is already running it.

```jsonc
"providers": {
  "omniroute": {
    "base_url": "http://omniroute:8000/v1",
    "api_key_env": "LLM_OMNIROUTE_API_KEY"
  }
},
"call_types": {
  "kbju.meal_text":              { "provider": "omniroute", "model": "gpt-oss-120b" },
  "kbju.summary_recommendation": { "provider": "omniroute", "model": "gpt-oss-120b" }
}
```

Env: `LLM_OMNIROUTE_API_KEY=...`. For one minor version (v0.7.0), the legacy
`OMNIROUTE_API_KEY` and `OMNIROUTE_BASE_URL` names are aliased to
`LLM_OMNIROUTE_API_KEY` / `LLM_OMNIROUTE_BASE_URL` and emit a deprecation warning at
boot; remove in v0.8.0.

### 2. OpenRouter (hosted meta-router with free models)

OpenRouter (<https://openrouter.ai/docs/api-reference/overview>) speaks the OpenAI
HTTP contract directly. Useful for "pay one bill, route across many providers"
without self-hosting.

```jsonc
"providers": {
  "openrouter": {
    "base_url": "https://openrouter.ai/api/v1",
    "api_key_env": "LLM_OPENROUTER_API_KEY"
  }
},
"call_types": {
  "kbju.modality_router_classifier": {
    "provider": "openrouter",
    "model": "nvidia/nemotron-3-super:free"
  }
}
```

OpenRouter free-tier models have rate limits and may go away (`:free` suffix is
non-stable across the catalogue); the operator picks paid models for production
sites and reserves free tiers for emergency fallback (ADR-018@0.1.0 §C16 emergency-free).

### 3. OpenAI direct

```jsonc
"providers": {
  "openai": {
    "base_url": "https://api.openai.com/v1",
    "api_key_env": "LLM_OPENAI_API_KEY"
  }
},
"call_types": {
  "kbju.voice_transcription": { "provider": "openai", "model": "whisper-1" },
  "kbju.meal_text":           { "provider": "openai", "model": "gpt-4o-mini" }
}
```

OpenAI's `whisper-1` runs at $0.006/min audio per <https://openai.com/api/pricing/>
and supports Russian; this is the second-paid-provider fallback called out in
ADR-003@0.1.0 (now superseded by ADR-023@0.1.0). `gpt-4o-mini` ($0.15/1M in,
$0.60/1M out as of 2026-05-25 — verify at <https://openai.com/api/pricing/>) is the
cheapest current OpenAI text-class model with reasonable Russian quality.

### 4. Fireworks direct (no router in front)

Fireworks (<https://fireworks.ai/pricing>) is OpenAI-compatible at
`https://api.fireworks.ai/inference/v1`. Useful if the operator wants to pay
Fireworks directly (no OmniRoute hop).

```jsonc
"providers": {
  "fireworks": {
    "base_url": "https://api.fireworks.ai/inference/v1",
    "api_key_env": "LLM_FIREWORKS_API_KEY"
  }
},
"call_types": {
  "kbju.voice_transcription":       { "provider": "fireworks", "model": "whisper-v3-turbo" },
  "kbju.modality_router_classifier":{ "provider": "fireworks", "model": "accounts/fireworks/models/gpt-oss-20b" },
  "kbju.workout_extractor":         { "provider": "fireworks", "model": "accounts/fireworks/models/qwen3-vl-30b-a3b" },
  "kbju.photo_recognition":         { "provider": "fireworks", "model": "accounts/fireworks/models/qwen3-vl-30b-a3b" }
}
```

This is the default in `config/llm.example.json` (ADR-018@0.1.0 picks preserved as
illustrative defaults).

### 5. vLLM self-hosted (OpenAI-compatible server)

vLLM (<https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html>) runs an
OpenAI-compatible HTTP server in front of any HuggingFace model. Useful when the
operator has a GPU box and wants no per-token cost.

```jsonc
"providers": {
  "vllm": {
    "base_url": "http://vllm-server:8000/v1",
    "api_key_env": "LLM_VLLM_API_KEY"
  }
},
"call_types": {
  "kbju.meal_text": { "provider": "vllm", "model": "Qwen/Qwen2.5-7B-Instruct" }
}
```

vLLM accepts a dummy API key when launched without `--api-key`; set
`LLM_VLLM_API_KEY=any-non-empty-string` so the application's key validation passes.

### 6. LiteLLM proxy (universal shim)

LiteLLM (<https://docs.litellm.ai/docs/proxy/quick_start>) is a Docker-deployable
OpenAI-compatible proxy that fronts 100+ providers. Useful when the operator wants a
"single base URL, multiple back-end providers, one observability layer" without
adopting OmniRoute.

```jsonc
"providers": {
  "litellm": {
    "base_url": "http://litellm:4000/v1",
    "api_key_env": "LLM_LITELLM_API_KEY"
  }
},
"call_types": {
  "kbju.meal_text":           { "provider": "litellm", "model": "claude-haiku-4.5" },
  "kbju.voice_transcription": { "provider": "litellm", "model": "whisper-1" }
}
```

LiteLLM's own `config.yaml` then fans out to the actual provider (Anthropic, OpenAI,
self-hosted, etc.); the application doesn't see that layer.

### 7. Ollama self-hosted (OpenAI-compatible API)

Ollama (<https://github.com/ollama/ollama/blob/main/docs/openai.md>) exposes
`http://localhost:11434/v1` with OpenAI-compatible chat completions. Useful for
local-only experimentation.

```jsonc
"providers": {
  "ollama": {
    "base_url": "http://ollama:11434/v1",
    "api_key_env": "LLM_OLLAMA_API_KEY"
  }
},
"call_types": {
  "kbju.modality_router_classifier": { "provider": "ollama", "model": "qwen2.5:7b" }
}
```

Ollama doesn't enforce auth by default; `LLM_OLLAMA_API_KEY=ollama` is the convention.
Ollama on the v0.1 VPS will compete for the §10.3 RAM envelope — keep it for
non-production experimentation unless the VPS has a GPU.

### 8. Voice-only: faster-whisper-server (self-hosted)

`faster-whisper-server` (<https://github.com/fedirz/faster-whisper-server>) wraps
faster-whisper with an OpenAI-compatible `audio.transcriptions` endpoint. Useful for
operators who want raw audio to never leave the VPS.

```jsonc
"providers": {
  "fwspeech": {
    "base_url": "http://fwspeech:8000/v1",
    "api_key_env": "LLM_FWSPEECH_API_KEY"
  }
},
"call_types": {
  "kbju.voice_transcription": { "provider": "fwspeech", "model": "Systran/faster-whisper-large-v3" }
}
```

`LLM_FWSPEECH_API_KEY=any-non-empty-string`. The base image is ~3.5 GB; large-v3
needs ~3 GiB RAM at inference. Plan VPS sizing accordingly (this exceeds the v0.1
2 GiB envelope share for transcription).

### 9. Voice-only: Groq Whisper (OpenAI-compatible)

Groq (<https://console.groq.com/docs/speech-text>) hosts Whisper at very low latency
through an OpenAI-compatible endpoint.

```jsonc
"providers": {
  "groq": {
    "base_url": "https://api.groq.com/openai/v1",
    "api_key_env": "LLM_GROQ_API_KEY"
  }
},
"call_types": {
  "kbju.voice_transcription": { "provider": "groq", "model": "whisper-large-v3-turbo" }
}
```

## Per-provider notes on the OpenAI-compatible contract

- **Authentication header:** every provider above uses `Authorization: Bearer <key>`
  except where noted. If a provider needs a different header (e.g. Deepgram's
  `Authorization: Token <key>`), the registry entry can carry a future
  `auth_header_template` knob (ADR-023@0.1.0 §Cons); not all providers need this.
- **JSON-mode / structured output:** OpenAI's `response_format = { "type":
  "json_schema", "json_schema": {...} }` is supported by Fireworks, OpenRouter,
  OpenAI, vLLM, LiteLLM. Self-hosted small models on Ollama may degrade to
  free-form output and need post-validator handling (ADR-006@0.1.0).
- **Vision:** OpenAI's `image_url` content block (`{ "type": "image_url",
  "image_url": { "url": "data:image/jpeg;base64,..." } }`) is supported by
  Fireworks Qwen3-VL, OpenRouter (model-dependent), OpenAI, and vLLM-with-VLM. Some
  text-only providers reject vision messages; the operator should not bind
  `kbju.photo_recognition` to a text-only model.
- **Audio:** the multipart-form `audio.transcriptions` surface is more variable than
  chat. Test the exact provider with a 1-second sample before wiring it in.

## Spend reconciliation

C10 emits per-call cost events with `provider_alias` and `model_alias` labels (the
registry's `provider_id` and `model` values). Spend is reconciled per provider
against billing surfaces (Fireworks invoice, OpenRouter dashboard, OpenAI invoice,
self-hosted = $0). The $10/month ceiling (PRD-001@0.3.0 §7) is enforced project-
wide, not per-provider.

## Secret-handling reminder

`config/llm.json` MUST NOT contain raw API keys. It carries `api_key_env` names; the
application reads the value from `process.env[<name>]` at call time. Real values
live on the VPS in `.env.production` (or the operator's secret store) and are never
committed.

## Where to add a new provider example

If you wire up a new OpenAI-compatible provider that other operators may want, add
a new section to this file with:

- One-paragraph description.
- One config snippet.
- Source URL for the provider's OpenAI-compatible endpoint documentation.

This is operator reference material; no validate_docs gate, no version pin.
