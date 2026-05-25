---
id: ADR-024
title: PO-pluggable model registry (config/llm.json)
status: proposed
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
created: 2026-05-25
updated: 2026-05-25
superseded_by: null
---

# ADR-024: PO-pluggable model registry (config/llm.json)

## Context

ADR-022@0.1.0 (provider-agnostic LLM) and ADR-023@0.1.0 (provider-agnostic voice) both
defer to "the model registry defined in ADR-024" for the per-call-type
`(provider, base_url, api_key_env, model)` mapping. PRD-001@0.3.0 §7 makes this a hard
constraint:

> PO MUST be able to swap base URL, API key, model alias and provider per call-type
> without touching application code and without rebuild.

This ADR closes:

1. **What `config/llm.json` looks like** — schema, invariants, file location.
2. **How the application consumes it** — the lookup contract, alias namespace,
   missing-alias behaviour, validation rules at boot.
3. **Hot-reload behaviour or lack thereof** — propagation latency expectations and
   what changes survive without restart.
4. **Integration with existing observability and cost guards** — labels, redaction,
   spend reconciliation against per-`provider_id` invoices.
5. **Backward compatibility with `OMNIROUTE_*` env vars** — one-version deprecation
   with documented removal target.

The closest precedent is ADR-013@0.1.0 (`config/allowlist.json` hot-reload). The
allowlist pattern is the analogue: file at `config/`, JSON, hot-reloadable via
`fs.watchFile`, atomic write (`tmp` then rename), in-memory snapshot rebuilt on each
reload, observability counter on reload.

## Options Considered (≥3 real options, no strawmen)

### Option A: Single JSON registry file with hot-reload (the ADR-013@0.1.0 pattern)

- Description: One `config/llm.json` file. Schema:
  `{ "version": 1, "providers": {...}, "call_types": {...} }`. Hot-reloaded via
  `fs.watchFile`, atomic write, in-memory `Map` rebuilt on each reload. Application
  asks `registry.resolve("kbju.meal_text")` → `{ base_url, api_key_env, model,
  provider_id }`; client module reads `process.env[api_key_env]` at call time.
- Pros (concrete):
  - Mirrors ADR-013@0.1.0 — same operational model, same reload semantics, same
    observability shape (`kbju_llm_registry_reload`).
  - O(1) lookup at any size; thousands of call-types work fine.
  - JSON is git-diffable and operator-editable on the VPS without a rebuild.
  - Atomic file write avoids partial reads.
  - Hot-reload propagation ≤2 s on the same VPS (matches ADR-013@0.1.0 §3); no restart
    required to swap a provider per call-type.
- Cons (concrete):
  - JSON has no comments. The schema reserves a `comment` field per call-type for
    operator notes (analogous to allowlist.json's `comment` key).
  - The file holds references to environment variable names, not the values. An
    operator who renames an env var must restart the process (env-var changes don't
    propagate via `fs.watchFile`); reload picks up the rename in the file but the new
    `LLM_FOO_API_KEY` isn't in `process.env` until restart.
- Cost / latency / ops burden: low — one new module, one config file, identical to
  ADR-013@0.1.0.

### Option B: TypeScript module of typed config objects

- Description: `src/config/llm.ts` exports the registry as a typed const object;
  callers `import { llmRegistry } from "src/config/llm"`.
- Pros: type-safe at compile time.
- Cons:
  - Violates PRD-001@0.3.0 §7: "without touching application code … and without
    rebuild". A code edit + `npm run build` + container rebuild is exactly what the
    constraint forbids.
- Cost / latency / ops burden: low at compile time; medium ops (every change is a
  release).

### Option C: Postgres-backed registry table

- Description: `kbju_llm_registry` table with rows `(call_type, provider_id, base_url,
  api_key_env, model, fallback_call_type)`. Application reads at boot; refreshes via
  cron or admin UI.
- Pros: queryable; auditable via DB tooling; supports multi-VPS replication for free.
- Cons:
  - Adds a Postgres round-trip to LLM dispatch; can be cached, but then we're back to
    in-memory + reload semantics (Option A) plus a new schema migration.
  - Editing requires either an admin UI (out of v0.1 scope per PRD-001@0.3.0 §3 NG5)
    or `psql` (operator burden).
  - PRD-002@0.2.1 §3 NG explicitly rejects new admin DB tables for non-essential infra.
- Cost / latency / ops burden: medium-high — adds a migration and an admin path the
  PRD doesn't ask for.

### Option D: Environment variables only (no registry file)

- Description: One env var per `(call_type, attribute)` pair, e.g.
  `LLM_KBJU_MEAL_TEXT_BASE_URL`, `LLM_KBJU_MEAL_TEXT_MODEL`,
  `LLM_KBJU_MEAL_TEXT_API_KEY_ENV`.
- Pros: no new file format.
- Cons:
  - 9 call-types × 4 attributes = 36 env vars before fallback chains; unwieldy.
  - Env-var changes require process restart; PRD-001@0.3.0 §7 says "without rebuild"
    but the operator-facing experience of "restart container to swap one model" is
    inferior to ADR-013@0.1.0-style hot-reload.
  - Validation at boot is awkward (how does the operator declare "alias 'kbju.meal_text'
    is required to exist" when the answer is "look at process.env keyspace"?).
- Cost / latency / ops burden: medium — env-var sprawl is operator-hostile.

## Decision

We will use **Option A: a single `config/llm.json` registry file with hot-reload**,
mirroring ADR-013@0.1.0's `config/allowlist.json` pattern.

### Schema

```jsonc
{
  "version": 1,
  "providers": {
    "omniroute":  { "base_url": "http://omniroute:8000/v1",        "api_key_env": "LLM_OMNIROUTE_API_KEY"  },
    "openrouter": { "base_url": "https://openrouter.ai/api/v1",    "api_key_env": "LLM_OPENROUTER_API_KEY" },
    "openai":     { "base_url": "https://api.openai.com/v1",       "api_key_env": "LLM_OPENAI_API_KEY"     },
    "fireworks":  { "base_url": "https://api.fireworks.ai/inference/v1", "api_key_env": "LLM_FIREWORKS_API_KEY" }
  },
  "call_types": {
    "kbju.meal_text":                 { "provider": "omniroute", "model": "gpt-oss-120b" },
    "kbju.summary_recommendation":    { "provider": "omniroute", "model": "gpt-oss-120b" },
    "kbju.modality_router_classifier":{ "provider": "fireworks", "model": "accounts/fireworks/models/gpt-oss-20b",
                                        "fallback_call_type": "kbju.modality_router_classifier_fallback" },
    "kbju.modality_router_classifier_fallback":
                                      { "provider": "fireworks", "model": "accounts/fireworks/models/qwen3-vl-30b-a3b" },
    "kbju.water_volume_extractor":    { "provider": "fireworks", "model": "accounts/fireworks/models/gpt-oss-20b" },
    "kbju.sleep_duration_extractor":  { "provider": "fireworks", "model": "accounts/fireworks/models/qwen3-vl-30b-a3b" },
    "kbju.workout_extractor":         { "provider": "fireworks", "model": "accounts/fireworks/models/qwen3-vl-30b-a3b" },
    "kbju.mood_inferrer":             { "provider": "fireworks", "model": "accounts/fireworks/models/executor" },
    "kbju.voice_transcription":       { "provider": "fireworks", "model": "whisper-v3-turbo" },
    "kbju.photo_recognition":         { "provider": "fireworks", "model": "accounts/fireworks/models/qwen3-vl-30b-a3b" },
    "comment": "PO edits this file; sidecar picks up within 30 s. No restart for provider/model swaps."
  }
}
```

**Frozen invariants:**

1. `version` is an integer; the application rejects unknown major versions at boot
   with a structured error. Schema bumps are MAJOR (breaking) or stay at `1`
   (additive).
2. Every alias used by application code MUST exist in `call_types`. Missing alias →
   structured error at registry-resolve time → C10 emits `kbju_llm_registry_miss` →
   the calling component fails the request with a Russian generic-recovery copy
   (PRD-001@0.3.0 §5 US-7 fallback path).
3. Every `call_types[*].provider` MUST resolve to an entry in `providers`. Dangling
   provider reference → boot-time validation error.
4. Every `providers[*].api_key_env` is a name, not a value. Application reads
   `process.env[api_key_env]` at call time; missing env var → structured error and
   manual-entry fallback (US-7).
5. `call_types[*].fallback_call_type` is optional; when present, it must point at
   another entry in `call_types` (no chains beyond depth 2 for v0.7.0 — the client
   refuses `A → B → C` to avoid infinite loops; B's `fallback_call_type` is ignored).
6. `comment` keys are allowed at any object level and ignored by the loader.
7. The illustrative example values above are written into the seed `config/llm.example.json`
   so a fresh deploy works without operator authoring; the actual `config/llm.json`
   may be copied from the example or seeded by `install.sh` (TKT-040@0.1.0).

### Lookup contract

```ts
// src/llm/registry.ts (new module — TKT-033@0.1.0 owns)
type Resolved = { provider_id: string; base_url: string; api_key_env: string;
                  model: string; fallback?: Resolved };
export function resolve(callType: string): Resolved   // throws on miss
export function reload(): void                         // re-reads file; idempotent
```

The C16 / C17 / C18 / C19 / C20 / C5 / C6 / C7 / C9 / C22 components reference call-type
aliases; they never reference provider names or model IDs in code.

### Hot-reload behaviour

- Same as ADR-013@0.1.0: `fs.watchFile(path, { interval: 1000 })`.
- Atomic write expected: write `config/llm.json.tmp` then `fs.rename`.
- On reload failure (JSON parse error, schema-validation error), the in-memory
  registry is **NOT** replaced; the old snapshot continues to serve. The reload
  failure emits `kbju_llm_registry_reload_failed{reason}`; severity `error`.
- On reload success, emits `kbju_llm_registry_reload{call_type_count, provider_count}`.
- Propagation latency target: ≤30 s end-to-end (matches PRD-001@0.3.0 §7 expectation;
  the hot-reload pattern's ~2 s fs-watchFile poll is well inside).

### What is NOT hot-reloadable

- `LLM_*` environment variables. An operator who edits `config/llm.json` to introduce
  a new `api_key_env` MUST also export the new variable in the container's
  environment; that requires `docker compose up -d` to re-create the container with
  fresh env. The hot-reload path picks up the new key reference; the value is read
  from `process.env` at call time and will fail until the env is set.
- Schema `version`. A v1 → v2 schema migration is an operator-coordinated change with
  a release; the loader rejects unknown majors and starts the failure path on every
  request until `version: 1` is restored.

### Integration with C10 cost / observability

- `cost_events.provider_alias` (existing column, ARCH-001@0.7.0 §5) is set to the
  registry's `provider_id` for the call.
- `cost_events.model_alias` is set to the registry's `model` value.
- C10 reconciles spend per `provider_id` across the project's billing surfaces; the
  $10/month ceiling (PRD-001@0.3.0 §7) is enforced project-wide as it is today, not
  per-provider.
- Logs and metrics labels MUST NOT include raw `api_key_env` values; the env-var
  *name* is fine to log (it's not a secret).

### Backward compatibility (`OMNIROUTE_*` deprecation)

For one minor version (v0.7.0 only), the registry's `omniroute` provider entry MAY
read `OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY` if `LLM_OMNIROUTE_BASE_URL` /
`LLM_OMNIROUTE_API_KEY` are unset. The fallback emits a one-shot warn-level log
`kbju_llm_legacy_env_in_use{var}` so operators see they need to migrate.

The deprecation removal is scheduled for v0.8.0 (next minor bump after this one).
TKT-033@0.1.0 carries the alias logic; a follow-up ticket in v0.8.0 removes it.
`.env.example` documents both names with the legacy ones marked DEPRECATED.

## Why the losers lost

- **Option B (TS module of typed config):** rebuild required — kills the PRD §7
  constraint.
- **Option C (Postgres-backed registry):** adds a migration and a query path the PRD
  doesn't ask for; reload semantics still need a cache layer that ends up looking
  like Option A anyway.
- **Option D (env-vars only):** sprawls to dozens of variables and forces a restart
  on every model swap; inferior operator UX vs Option A's hot-reload.

## Consequences

**Positive:**

- The PO swaps OmniRoute for OpenRouter (or anything else) with a single edit to
  `config/llm.json`. No rebuild, no `npm run build`. Same operational pattern they
  already know from `config/allowlist.json`.
- Per-call-type override is a config edit. "Use a cheaper model for the C16 router on
  this VPS for the next 2 weeks" is a one-line change and a kept-warm rollback
  (`git diff config/llm.json`).
- The registry surface lives in one place (`src/llm/registry.ts`) and is testable
  without network calls.

**Negative / trade-offs accepted:**

- JSON has no comments. The schema reserves `comment` keys at every object level;
  operators may also keep notes in a side-by-side `config/llm.notes.md` if needed.
- Provider quality varies; the registry only routes, it does not compare. Operator
  owns the choice; the architecture only owns the swap mechanism.
- A misconfigured registry (missing alias, dangling provider, unset env var) produces
  user-facing errors via the US-7 manual-entry fallback path; this is acceptable
  because the `config/llm.json` schema is small and the validation runs at boot.
- Hot-reload introduces a brief inconsistency window during operator edits (≤2 s)
  where some calls use the old snapshot and some use the new. Acceptable: no operation
  is mid-LLM-call when a fresh resolve happens; per-call-type binding is read at call
  start.

**Follow-up work:**

- TKT-033@0.1.0: implement `src/llm/registry.ts`, `src/llm/llmClient.ts`, env-var
  rename + backward-compat alias, the new `config/llm.example.json`, and migrate the
  existing call sites off `omniRouteClient.ts`.
- TKT-034@0.1.0: implement `src/voice/voiceClient.ts` (or whatever path TKT-034@0.1.0 picks)
  using the same registry; supersedes the existing voice client.
- TKT-035@0.1.0: migrate `config/water-extractor.json`, `config/workout-extractor-*.json`,
  `config/mood-extractor.json`, and `config/modality-router-classifier.json` so they
  reference call-type aliases instead of inline model IDs.
- TKT-046@0.1.0 / `docs/incidents/`: the `/diag` command surface (ADR-021@0.1.0 §C2)
  emits the active `provider_id` and `model` per call-type.
- ADR-022@0.1.0 + ADR-023@0.1.0: depend on this ADR for their lookup contract.

## References

- PRD-001@0.3.0 §7 (provider abstraction hard constraint)
- ADR-013@0.1.0 (`config/allowlist.json` hot-reload pattern — the closest precedent)
- ADR-022@0.1.0 (LLM provider-agnostic abstraction — consumes this registry)
- ADR-023@0.1.0 (voice provider-agnostic abstraction — consumes this registry)
- ADR-018@0.1.0 (per-site model picks — preserved as illustrative defaults; the
  registry's example values are seeded from this ADR)
- OpenAI Chat Completions reference: <https://platform.openai.com/docs/api-reference/chat>
- OpenAI Audio Transcriptions reference: <https://platform.openai.com/docs/api-reference/audio/createTranscription>
