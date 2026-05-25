---
id: TKT-034
title: 'Provider-agnostic voice transcription client (audio.transcriptions)'
status: done
arch_ref: ARCH-001@0.7.1
prd_ref: PRD-001@0.3.0
component: C5 Voice Transcription Provider
depends_on:
- TKT-033@0.1.0
blocks: []
estimate: M
created: 2026-05-25
updated: 2026-05-26
closed_at: 2026-05-25
closed_by: orchestrator (PO-delegated)
review_ref: RV-CODE-020
---

# TKT-034: Provider-agnostic voice transcription client (audio.transcriptions)

## 1. Goal
Refactor the existing C5 Voice Transcription Provider client into a generic `src/voice/voiceClient.ts` that consumes the model registry from TKT-033@0.1.0 and speaks the OpenAI `POST /v1/audio/transcriptions` HTTP surface per ADR-023@0.1.0.

## 2. In Scope
- New module `src/voice/voiceClient.ts` (path may differ if executor finds an existing C5 layout — keep it consistent) exporting `transcribe({audio_buffer, language?, prompt?, temperature?})`. Resolves `(base_url, api_key, model)` from `registry.resolve("kbju.voice_transcription")` per ADR-024@0.1.0.
- Multipart-form-data request body: `file` (audio buffer with correct MIME), `model`, `language` (default `"ru"` for the v0.1 envelope; configurable per call), optional `prompt` and `temperature`.
- Response parsing: read `text` from JSON body; preserve any provider-specific extra fields under a typed-but-loose `provider_extras` object for telemetry only (never returned to the application's transcript path).
- `auth_header_template` knob in registry: if `providers[*].auth_header_template` is set, use it instead of the default `Authorization: Bearer <key>` (handles e.g. Deepgram's `Authorization: Token <key>` shim). Default is the OpenAI Bearer pattern.
- C13 Stall Watchdog (ADR-012@0.1.0) wraps the new `voiceClient.transcribe` identically to the LLM client; same `STALL_THRESHOLD_MS` env config.
- C10 cost / observability emits `provider_alias` and `model_alias` labels for `kbju_voice_transcription_total` and `kbju_voice_roundtrip_latency_ms` — labels are the registry's `provider_id` and `model`, not raw keys.
- Raw audio deletion obligation (ARCH-001@0.7.0 §3.5 / §9.5) is unchanged: the wrapping C5 component still deletes after success or terminal failure; this ticket does not move that responsibility.
- Unit tests at ≥80% coverage: happy path, network failure (one retry per ADR-023@0.1.0 §Decision), oversize audio rejection (>15 s per PRD-001@0.3.0 §7), missing API key error, malformed JSON response, auth_header_template variant.

## 3. NOT In Scope
- LLM `chat.completions` / vision client — TKT-033@0.1.0 owns.
- Adding a per-modality voice transcription provider (the registry is the swap point).
- Changing the existing US-7 failure UX copy ("Не расслышал, напиши текстом").
- Changing the C5 retry policy (one retry maximum, only on transport failure, only if still inside the latency hard cap).
- Implementing Deepgram or AssemblyAI provider modules (the operator wires them via `config/llm.json`).
- Removing `FIREWORKS_API_KEY` (legacy fallback name kept under TKT-033@0.1.0).

## 4. Inputs
- ARCH-001@0.7.0 §3.5 C5 Voice Transcription Provider
- ADR-023@0.1.0 (provider-agnostic voice transcription; full lookup contract)
- ADR-024@0.1.0 (model registry — `kbju.voice_transcription` alias and `auth_header_template` knob)
- ADR-022@0.1.0 (LLM half — same patterns reused)
- ADR-003@0.1.0 (superseded; empirical reference for cost / latency / privacy)
- ADR-012@0.1.0 (C13 Stall Watchdog — wrapping point reused)
- TKT-033@0.1.0 (depends_on — registry must exist first)
- Existing C5 client module (find via `grep -r "audio.transcriptions" src/` or by reading TKT-007@0.1.0 outputs)

## 5. Outputs
- [x] `src/voice/voiceClient.ts` (new) with `transcribe()` against the OpenAI HTTP surface.
- [x] Existing C5 client module refactored to call the new `voiceClient.ts`; or deleted if it was a thin wrapper.
- [x] `config/llm.example.json` extended with `kbju.voice_transcription` (already seeded by TKT-033@0.1.0; this ticket only verifies the alias resolves).
- [x] `tests/voice/voiceClient.test.ts` covering all six failure modes from §2.

## 6. Acceptance Criteria
- [x] `npm test` passes.
- [x] `npm run lint` clean. `npm run typecheck` clean (strict).
- [x] Test exercises a 1-second WAV / OGG fixture against a mock server that speaks `audio.transcriptions`; transcript text returned correctly.
- [x] Test exercises `auth_header_template: "Token {key}"` variant; outgoing request `Authorization` header matches.
- [x] Test exercises missing-env-var: `LLM_FOO_API_KEY` unset → typed error → US-7 "Не расслышал, напиши текстом" path triggers via the wrapping component.
- [x] No raw API key in test logs.

## 7. Constraints
- Do NOT introduce a new HTTP client library; use `fetch` (Node 24 has it native) or whatever was already used in the existing C5 client.
- Do NOT change the C5 contract surface (transcript text + duration metadata + raw-audio deletion obligation). This is an indirection swap, not a feature change.
- Do NOT add new runtime dependencies. Multipart construction can use `form-data` if it was already in `package.json`; otherwise build the multipart body manually.
- Do NOT implement provider-specific feature extensions (diarization, word-level timestamps with non-OpenAI shapes, etc.).
- Reuse the same `redactPii` and stall-watchdog wrapping the LLM client uses.

## 8. Definition of Done
- [x] All Acceptance Criteria pass.
- [x] PR opened with link to this TKT in description (version-pinned).
- [x] Executor filled §10 Execution Log.
- [x] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log

- 2026-05-25T22:19:21Z opencode-executor: started
- 2026-05-26T02:05:00Z opencode-executor: in_review; tests 52 pass (voice); lint clean; typecheck clean
- 2026-05-26T02:20:00Z opencode-executor: iter 2; addressed RV-CODE-020 F-M2 (preserve typed registry_error through adapter boundary); F-M1 deferred to backlog (registry auth_header_template knob outside §5 Outputs but authorised by §2; ADR-024@0.1.0 §Schema patch needed); F-L1 (double /v1 guard) and F-L2 (comment accuracy) addressed as one-liners
- 2026-05-25T23:23Z opencode-orchestrator: merged in commit 0fc2a09; RV-CODE-020 verdict=pass after iter 2 (F-M2+F-L1+F-L2 fixed; F-M1 backlogged as BACKLOG-008 — ADR-024@0.1.0 §Schema patch for auth_header_template); status=done
