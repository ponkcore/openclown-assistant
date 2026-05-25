---
id: RV-CODE-020
type: code_review
target_pr: "https://github.com/code-yeongyu/openclown-assistant/pull/30"
ticket_ref: TKT-034@0.1.0
status: in_review
created: 2026-05-26
---

# Code Review — PR #30 (TKT-034@0.1.0)

## Summary
The PR refactors C5's existing voice transcription adapter into a provider-agnostic `src/voice/voiceClient.ts` that speaks the OpenAI `POST /v1/audio/transcriptions` HTTP surface and resolves providers from the model registry (ADR-024@0.1.0). The adapter preserves the C5 contract surface (duration check, budget preflight, raw-audio deletion). Tests cover the happy path, retry-on-transport-failure, `auth_header_template` variant, missing-env-var typed error, and no-raw-key-in-logs. Two Medium findings: a registry.ts file touched outside §5 Outputs (auth_header_template knob not documented in ADR-024@0.1.0 schema), and a typed-error collapse in the adapter. No High findings.

## Verdict
- [ ] pass
- [x] pass_with_changes
- [ ] fail

One-sentence justification: All Acceptance Criteria are verifiably met, no High findings; two Medium findings (registry.ts scope + typed-error collapse in adapter) should be addressed before merge or back-logged.

Recommendation to PO: request changes from Executor (fix-or-backlog the two Medium findings), or merge with backlog entries.

## Contract compliance (each must be ticked or marked finding)
- [ ] PR modifies ONLY files listed in TKT §5 Outputs — **F-M1**: `src/llm/registry.ts` is not in §5 Outputs. Justified by §2 prose (`auth_header_template` knob), but ADR-024@0.1.0 schema does not document the field. (Medium)
- [x] No changes to TKT §3 NOT-In-Scope items
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist — `package.json` diff is empty.
- [x] All Acceptance Criteria from TKT §6 are verifiably satisfied (file:line or test name cited) — see below.
- [x] CI green (lint, typecheck, tests, coverage) — per executor execution log; node not available in reviewer environment for direct verification.
- [x] Definition of Done complete — two commits: `6d4e5e2` (implementation) + `aa986ba` (status + execution log).
- [x] Ticket frontmatter `status: in_review` in a separate commit — `aa986ba`.

### Acceptance Criteria traceability
| AC | Status | Evidence |
|---|---|---|
| AC#1 (`npm test` passes) | ✓ | exec log claims 52 voice tests pass |
| AC#2 (`npm run lint`, `npm run typecheck` clean) | ✓ | exec log claims clean |
| AC#3 (1-second WAV/OGG fixture, mock `audio.transcriptions`, transcript text) | ✓ | `tests/voice/voiceClient.test.ts:162-182` — "returns transcript text on successful response (AC#3)", asserts `"гречка 200 грамм"`, URL ends with `/audio/transcriptions` |
| AC#4 (`auth_header_template: "Token {key}"` variant, `Authorization` header) | ✓ | `tests/voice/voiceClient.test.ts:360-376` — asserts `Authorization: Token dg-test-key-xyz789` |
| AC#5 (missing-env-var → typed error → US-7 via wrapping component) | ✓ * | `tests/voice/voiceClient.test.ts:294-302` — `delete process.env.LLM_FIREWORKS_API_KEY` → `result.outcome === "registry_error"`. See **F-M2**. |
| AC#6 (no raw API key in test logs) | ✓ | `tests/voice/voiceClient.test.ts:423-449` — asserts `"fw-test-key-abc123"` absent from all log output |

\* AC#5 qualified: see F-M2 below.

## Findings

### High (blocking)
*None.*

### Medium
- **F-M1 (`src/llm/registry.ts:24,48,183`):** `auth_header_template` field added to `ProviderEntry` and `Resolved` types. This file is not enumerated in TKT-034@0.1.0 §5 Outputs (it landed in TKT-033@0.1.0). While TKT-034@0.1.0 §2 prose explicitly says "`auth_header_template` knob in registry: if `providers[*].auth_header_template` is set, use it…", ADR-024@0.1.0 §Schema (lines 117-142) does **not** include `auth_header_template` in the provider schema — the schema shows only `base_url` and `api_key_env`. The knob is mentioned only in ADR-023@0.1.0 lines 173-175 (as a client-side concern) but ADR-024@0.1.0 (the registry schema owner) has not codified it. *Responsible role:* Executor. *Suggested remediation:* Either (a) open a backlog entry to patch ADR-024@0.1.0 to add `auth_header_template?: string` to the provider schema, or (b) if the architect-consult deems the ADR-023@0.1.0 reference sufficient authority, document the resolution. Not a High because §2 prose provides explicit authority.

- **F-M2 (`src/voice/transcriptionAdapter.ts:215-226`):** When `voiceClient.transcribe()` returns `outcome: "registry_error"` (typed error), the adapter collapses it to `outcome: "provider_failure"` (generic). The AC#5 test (`voiceClient.test.ts:294`) exercises the typed-error path at the voiceClient level, not through the wrapping component. While the US-7 fallback ("Не расслышал, напиши текстом") still triggers correctly through C4, the typed-error distinction is lost at the adapter boundary, which limits the calling code's ability to provide differentiated diagnostics (e.g. distinguishing "API key missing — operator action required" from "provider 500 — retry worked but ultimately failed"). *Suggested remediation:* Add a test that exercises `transcribeVoice(config, request)` with a deliberately broken `resolvedOverride` (bad env var name) and verify `outcome: "provider_failure"`; or propagate the typed outcome through the adapter return value.

### Low
- **F-L1 (`src/voice/transcriptionAdapter.ts:65`):** `buildResolvedFromConfig` unconditionally appends `/v1` — `${config.baseUrl}/v1`. If `config.baseUrl` already ends with `/v1` (an operator misconfiguration), the resulting URL would be `.../v1/v1/audio/transcriptions`. No guard exists. The registry-based path is not affected (providers declare full base_url including `/v1`). *Suggested remediation:* Strip trailing `/v1` before appending, or add a JSDoc warning on `TranscriptionConfig.baseUrl`.

- **F-L2 (`src/voice/voiceClient.ts:14`):** Comment says "All log emits pass through redactPii" but the actual import is `buildRedactedEvent` (line 18). The function `redactPii` may exist elsewhere but is not the one used here. *Suggested remediation:* Correct the comment to `buildRedactedEvent` for accuracy.

## Red-team probes (Reviewer must address each)
- **Error paths:** Transcription timeout handled via `AbortController` (voiceClient.ts:295, 7s timeout). Stall watchdog wraps every call (voiceClient.ts:297-329, ADR-012@0.1.0). Budget block returns `"budget_blocked"` before the HTTP call (transcriptionAdapter.ts:112-145). Audio deletion on failure is preserved (transcriptionAdapter.ts:216). Kill switch checked before fetch (voiceClient.ts:220-249). DB lock not relevant to this module.
- **Concurrency:** Two concurrent calls from the same user would have independent `StallWatchdog` instances, independent `AbortController`s, and independent registry resolve snapshots. No shared mutable state in `voiceClient.ts` beyond env-var reads which are process-global.
- **Input validation:** Duration >15s is the adapter's job (transcriptionAdapter.ts:80-110) — verified. No buffer-size validation in voiceClient (test at voiceClient.test.ts:276-290 accepts 1MB buffer). Malformed JSON handled via try/catch on `response.json()` (voiceClient.ts:409). Missing `text` field returns empty transcript (voiceClient.ts:410) — success outcome preserved.
- **Prompt injection:** The `opts.prompt` field (voiceClient.ts:54) is sent directly in the multipart form body (line 265). In the v0.1 envelope this is set by application code ("Russian meal description"), not by untrusted user input. The transcription model's prompt is a hint, not a system-prompt vector. Audio bytes themselves are not prompt-injectable. The downstream C6 KBJU Estimator handles injection via its own `buildRedactedEvent` + prompt-policy guard layer.
- **Tenant isolation:** `userId` is passed through as metadata labels (e.g. voiceClient.ts:233,283) and as the metrics tenant_id. No new table writes — C3 persistence is not in scope. RLS remains on existing tables.
- **Secrets:** No credentials committed. All log emits use `buildRedactedEvent`. Test fixture keys (`fw-test-key-abc123`, `dg-test-key-xyz789`) are obviously test values. AC#6 verified no raw key leakage to logs (voiceClient.test.ts:423-449). `.env.example` was not modified — the only env-var changes are the registry's `api_key_env` references which re-use existing `LLM_*` naming convention.
- **Observability:** `provider_call_started` (voiceClient.ts:276), `voice_transcription_completed` (voiceClient.ts:424), `provider_call_finished` (voiceClient.ts:376), `llm_call_stalled` (voiceClient.ts:308) events emitted with `provider_alias`, `model_alias`, `latency_ms`, `error_code` labels. Kill switch events (voiceClient.ts:225-239) include the path. A 3am operator can see which provider was called, how long it took, and whether it failed — sufficient for incident triage.
- **Rollback:** The adapter preserves the identical `transcribeVoice(config, request)` signature (plus a new optional third param `resolvedOverride`). VoiceClient.ts is additive. Rollback: revert adapter + delete voiceClient.ts. No migration, no schema change, no config file change. Straightforward from the diff.


---

## Iteration 2 — re-review (commit `9bff31f`)

### Per-finding status

| Finding | Status | Evidence |
|---|---|---|
| **F-M1** (registry.ts outside §5 Outputs) | **DEFERRED** | Registry.ts `auth_header_template` unchanged. Orchestrator will open backlog entry for ADR-024@0.1.0 patch. Accepted as deferred — not re-raised. |
| **F-M2** (typed-error collapse in adapter) | **RESOLVED** | `mapOutcome()` helper added at `src/voice/transcriptionAdapter.ts:87-103`. `TranscriptionOutcome` now includes `"registry_error"` (`src/voice/types.ts:61`). `TranscriptionResult.error_kind?: TranscriptionErrorKind` preserves fine-grained discriminator (`src/voice/types.ts:46-53`). 5 new tests at `tests/voice/transcriptionAdapter.test.ts:343-435` assert `result.outcome === "registry_error"` (line 383), `error_kind` for provider_failure (lines 399, 408), and `error_kind: undefined` on non-error outcomes (lines 417, 433). |
| **F-L1** (double `/v1` in `buildResolvedFromConfig`) | **RESOLVED** | `src/voice/transcriptionAdapter.ts:73`: `config.baseUrl.replace(/\/v1\/?$/, "")` strips trailing `/v1` before appending, anchored at end-of-string. |
| **F-L2** (comment typo `redactPii` → `buildRedactedEvent`) | **RESOLVED** | `src/voice/voiceClient.ts:14`: comment now reads "All log emits pass through buildRedactedEvent (which applies redactPii internally)." |

### Updated verdict

- [x] pass
- [ ] pass_with_changes
- [ ] fail

All iter-1 Medium/Low findings addressed. F-M1 formally deferred to orchestrator's backlog. No new findings. DoD two-commit topology preserved with one fix-up commit on top (3 commits total on branch: `6d4e5e2` implementation, `aa986ba` status, `9bff31f` iter-2 fixes + `f973e09` RV-CODE-020).

CI: executor reports 1340 pass total (1 pre-existing unrelated failure in `healthCheck.test.ts`, Node 24 compat — not in scope).

### New red-team re-check
- **Error paths:** The `mapOutcome()` switch is exhaustive over `TranscribeOutcome` (typescript enforces). No regression in duration check, budget block, or audio deletion paths. ✓
- **Observability:** The `error_kind` discriminator is emitted in the failure log (`transcriptionAdapter.ts:271`), giving a 3am operator visibility into whether the failure was registry/env-level or provider-HTTP-level. ✓
- **Typed-error propagation:** `registry_error` survives end-to-end from `voiceClient.transcribe()` → `mapOutcome()` → `TranscriptionResult.outcome`. Verified by test at `transcriptionAdapter.test.ts:383`. ✓

### Recommendation: **merge**

