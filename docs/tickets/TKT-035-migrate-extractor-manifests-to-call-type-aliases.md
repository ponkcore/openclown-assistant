---
id: TKT-035
title: 'Migrate config/*.json extractor manifests to call-type aliases'
status: ready
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: C16 / C17 / C18 / C19 / C20 / C7 manifests
depends_on:
- TKT-033@0.1.0
blocks: []
estimate: S
created: 2026-05-25
updated: 2026-05-25
---

# TKT-035: Migrate config/*.json extractor manifests to call-type aliases

## 1. Goal
Replace the inline model identifiers in `config/water-extractor.json`, `config/workout-extractor-text.json`, `config/workout-extractor-photo.json`, `config/mood-extractor.json`, `config/modality-router.json`, and `config/modality-router-classifier.json` with references to the `kbju.*` call-type aliases registered in `config/llm.json` per ADR-024@0.1.0.

## 2. In Scope
- For each manifest under `config/`, replace any inline `model` / `base_url` / `api_key_env` triple with a single `call_type` field (e.g. `"call_type": "kbju.water_volume_extractor"`).
- Update the consuming code in `src/modality/water/`, `src/modality/sleep/`, `src/modality/workout/`, `src/modality/mood/`, `src/modality/router/`, `src/photo/` (or wherever C7 lives) to look up via `registry.resolve(manifest.call_type)` instead of reading the manifest's old `(base_url, api_key_env, model)` triple directly.
- Keep all extraction *prompts*, *forced-output JSON schemas*, *response validators*, and *seed keyword chains* in the manifest as before — those are extractor-specific, not provider-specific.
- Update each manifest's *example file* (`config/*.example.json` if any exist) similarly.
- Add unit-test fixtures or assertions that prove `manifest.call_type` resolves to a known entry in `config/llm.json`.

## 3. NOT In Scope
- Adding a new call-type alias not already in ADR-024@0.1.0 §Schema example.
- Changing the prompt content of any extractor.
- Changing the JSON-schema shape of any extractor's forced output.
- Removing modality-router-classifier — it stays as the C16 LLM-fallback path (ADR-015@0.1.0 amended).
- Hot-reload of extractor manifests themselves (out of scope; the manifest path is a static load at boot per existing pattern).

## 4. Inputs
- ARCH-001@0.7.0 §3.16..§3.20 (C16/C17/C18/C19/C20 components)
- ADR-022@0.1.0 + ADR-024@0.1.0 (registry contract)
- TKT-033@0.1.0 (depends_on — registry must exist; aliases must be defined)
- Existing manifests in `config/` (the files being migrated)
- Consuming code in `src/modality/{router,water,sleep,workout,mood}/` and `src/photo/` (the call sites)

## 5. Outputs
- [ ] `config/water-extractor.json` migrated to `"call_type": "kbju.water_volume_extractor"`.
- [ ] `config/workout-extractor-text.json` migrated to `"call_type": "kbju.workout_extractor"`.
- [ ] `config/workout-extractor-photo.json` migrated to `"call_type": "kbju.workout_extractor"` (note: same alias for both surfaces; the prompt differs, the model alias does not).
- [ ] `config/mood-extractor.json` migrated to `"call_type": "kbju.mood_inferrer"`.
- [ ] `config/modality-router-classifier.json` migrated to `"call_type": "kbju.modality_router_classifier"`.
- [ ] `config/modality-router.json` — unchanged (this file holds deterministic keyword chains, not LLM call config).
- [ ] Sleep extractor (if a manifest exists) migrated to `"call_type": "kbju.sleep_duration_extractor"`. If no manifest exists, the call-site change is enough.
- [ ] Photo extractor (C7) migrated to `"call_type": "kbju.photo_recognition"`.
- [ ] Consuming `src/` modules updated to call `registry.resolve(manifest.call_type)`.
- [ ] Tests updated to fixture `config/llm.json` with the alias under test and assert resolution.

## 6. Acceptance Criteria
- [ ] `npm test` passes.
- [ ] `npm run lint` clean. `npm run typecheck` clean (strict).
- [ ] No file under `config/` outside `config/llm.json` and `config/llm.example.json` declares a `model:` value with a hard-coded model ID — verifiable with `grep -E '^[^/]*model.*\":\s*\"accounts/' config/` returning nothing.
- [ ] Each migrated manifest's `call_type` value is one of the aliases listed in ADR-024@0.1.0 §Schema example.
- [ ] Smoke test: load every migrated manifest, resolve every `call_type` against a fixture `config/llm.json`, none miss.

## 7. Constraints
- Do NOT introduce new fields to the manifest schema beyond `call_type`. Anything else is the extractor's concern (prompt, schema, validator).
- Do NOT keep both the old `(model, base_url, api_key_env)` AND the new `call_type` field — the migration is a hard cut-over (the manifest's old model identifier is removed; the registry now owns it).
- Manifest comments preserving original model picks are allowed (e.g. `"comment": "previously gpt-oss-20b via Fireworks; see ADR-018"`) for operator context.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->
