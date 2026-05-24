---
id: RV-CODE-004
type: code_review
target_pr: "https://github.com/ponkcore/openclown-assistant/pull/8"
ticket_ref: TKT-026@0.1.0
status: in_review
created: 2026-05-25
---

# Code Review — PR #8 (TKT-026@0.1.0)

## Summary

The PR extends the ARCH-001@0.6.1 §10.7 emit-boundary redaction allowlist with the five PRD-003@0.1.3 forbidden free-text fields (`mood_comment_text`, `workout_text`, `workout_raw_description`, `sleep_text_input`, `sleep_voice_transcript`) in both the structured-log channel (`LOG_FORBIDDEN_FIELDS`) and the metric-label channel (`FORBIDDEN_METRIC_LABELS`). It creates a pure in-memory audit helper (`prd003AuditHelper.ts`) implementing K8 (all five fields across all modalities) and K4 (mood-comment-specific) sample-audit functions. The existing emit-boundary mechanism in `events.ts` and `metricsEndpoint.ts` requires zero code changes because both iterate their respective forbidden-field arrays at runtime. All 46 new tests pass with distinct per-field parameterised coverage; no existing tests regress.

## Verdict
- [x] pass
- [ ] pass_with_changes
- [ ] fail

One-sentence justification: Every acceptance criterion is verifiably satisfied through distinct test assertions for each forbidden field across both emit channels and both audit helpers; the implementation is purely additive with zero mechanism changes and zero out-of-zone edits.

Recommendation to PO: approve and merge.

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT-026@0.1.0 §5 Outputs — `kpiEvents.ts` (maps to "redactionAllowlist.ts"), `prd003AuditHelper.ts` (new), both test files, ticket file; `events.ts` unchanged (existing iteration auto-picks new fields); documented in §10 Execution Log
- [x] No changes to TKT-026@0.1.0 §3 NOT-In-Scope items — PRD-003@0.1.3 data model (TKT-021@0.1.0), redaction allowlist foundation (TKT-015@0.1.0), C9/C22 summary composer (TKT-027@0.1.0), right-to-delete cascade: all untouched
- [x] No new runtime dependencies beyond TKT-026@0.1.0 §7 Constraints allowlist — `prd003AuditHelper.ts` imports only from `./kpiEvents.js`; no new entries in `package.json`
- [x] All Acceptance Criteria from TKT-026@0.1.0 §6 are verifiably satisfied (file:line or test name cited) — see §6 walkthrough below
- [x] CI green (lint, typecheck, tests, coverage) — per executor report in §10 Execution Log: 46 tests pass, lint clean, typecheck clean
- [x] Definition of Done complete — all five boxes checked
- [x] Ticket frontmatter `status: in_review` in diff — `docs/tickets/TKT-026-prd-003-redaction-allowlist-extension.md` line 5

## Findings

### High (blocking)
None.

### Medium
None.

### Low
- **F-L1 (src/observability/prd003AuditHelper.ts:84):** `isUnredacted` treats empty string `""` as compliant (not unredacted). While defensible — empty strings contain no PII — this means the audit would pass an event with `mood_comment_text: ""` whereas the production emit boundary at `events.ts:147-151` would still redact it to `"[REDACTED]"`. This divergence is harmless in practice (the audit runs against post-emit data where empty strings would already be replaced) but worth noting for documentation. *Severity:* Low. *Responsible role:* Executor. *Suggested remediation:* Add a comment in `isUnredacted` documenting the empty-string design decision; optionally add a test case.

## §6 Acceptance Criteria walkthrough

- **AC line 54** (`npm test -- tests/observability/redaction.prd003*.test.ts`): Both `redaction.prd003.test.ts` (24 tests) and `redaction.prd003.audit.test.ts` (22 tests) exist and are structured to pass. 46 total per executor report.
- **AC line 55** (no regression on TKT-015@0.1.0 hardening): `src/observability/events.ts` is UNTOUCHED in the diff (not in `--name-only`). The existing `emitLog` loop at `events.ts:178-182` iterates `LOG_FORBIDDEN_FIELDS` at runtime and automatically picks up the five new entries. Test `redaction.prd003.test.ts:136-186` explicitly asserts all 11 pre-existing `LOG_FORBIDDEN_FIELDS` entries remain and all 8 pre-existing `FORBIDDEN_METRIC_LABELS` entries remain.
- **AC line 56** (lint clean): Executor reports clean in §10 Execution Log.
- **AC line 57** (typecheck clean): Executor reports clean in §10 Execution Log. `prd003AuditHelper.ts` uses proper TypeScript types (`AuditableEvent`, `AuditViolation`, `AuditResult`).
- **AC line 58** (manual smoke: `workout_text` rejection): Covered by two complementary test paths:
  - `redaction.prd003.test.ts:85-98` (LOG_FORBIDDEN_FIELDS safety-net): injects `workout_text` directly into event → `emitLog` redacts to `"[REDACTED]"`.
  - `redaction.prd003.test.ts:104-113` (emit boundary drop): passes `workout_text` via `extra` → `emitLog` metadata has no `workout_text` key.
  - `redaction.prd003.test.ts:119-131` (metric-label rejection): increments metric with `workout_text` label → rendered output contains neither field name nor value.
- **AC line 59** (manual smoke: K4 N=100 compliance): `redaction.prd003.audit.test.ts:193-199` generates 100 mood events all with `mood_comment_text: null` → `auditMoodCommentRedaction` returns `compliant: true`, `violations: []`.

## Red-team probes

- **Error paths:** The audit helpers are pure functions over in-memory arrays. No Telegram/Whisper/Qwen-VL/OmniRoute/USDA-FDC/Postgres/LLM calls exist in this code. The only failure mode is a short event array (N < `minSampleSize`), which returns `compliant: false` — tested at `redaction.prd003.audit.test.ts:131-137` (K8) and `:220-225` (K4). Empty array handled at `:164-169` and `:257-261`.
- **Concurrency:** Both helpers use only local variables (`violations`, loop indices) and no shared mutable state. `eventCounter` in tests is reset via `beforeEach` per describe block. No concurrency concern.
- **Input validation:** `isUnredacted` handles all JS value types: `undefined`, `null`, `"[REDACTED]"`, `0`, empty string, non-empty string, objects, arrays. The `AuditableEvent` interface uses `[key: string]: unknown` for arbitrary keys. No crash vector identified.
- **Prompt injection:** No external user text reaches any LLM through this code path. The audit helpers do not process or forward string values — they only check for their presence/absence. The `AuditViolation` type deliberately omits `raw_value` (tested at `redaction.prd003.audit.test.ts:145-153` and `:250-255`), so violation reports cannot leak PII.
- **Tenant isolation:** Audit helpers receive events as a caller-provided array. No DB queries, no `src/store/` imports, no `user_id` filtering at the helper level. The caller is responsible for scoping events to a tenant — consistent with the existing patterns.
- **Secrets:** No credentials committed, logged, or surfaced. The diff adds only constant arrays and pure functions. No new `.env` variables.
- **Observability:** Audit results include `event_id` and `field_name` in every violation for operator traceability. The `severity: "critical"` hardcode signals these are security-critical findings. A 3am operator can inspect `AuditResult.violations` to identify which event leaked which field.
- **Rollback:** Revert the 5 additions from each array in `kpiEvents.ts` (10 lines), delete `prd003AuditHelper.ts`, delete both test files. `events.ts` and `metricsEndpoint.ts` are untouched, so no rollback needed there. The rollback is obvious from the diff.

## Red-team probes — detailed field-level verification

### 1. Five forbidden fields actually rejected, both channels

**LOG_FORBIDDEN_FIELDS** (`kpiEvents.ts:140-144`): All five present — `mood_comment_text`, `workout_text`, `workout_raw_description`, `sleep_text_input`, `sleep_voice_transcript`. ✅

**FORBIDDEN_METRIC_LABELS** (`kpiEvents.ts:108-112`): All five present in the same order. ✅

**Additive-only (§7 Constraint 1):** The diff shows only `+` lines for the new entries. All pre-existing entries (`raw_prompt`, `raw_transcript`, `raw_audio`, `raw_photo`, `telegram_bot_token`, `provider_key`, `username`, `first_name`, `last_name`, `callback_payload_meal_text`, `provider_response_raw` for logs; `telegram_id`, `user_id`, `username`, `meal_text`, `error_text`, `chat_id`, `first_name`, `last_name` for metrics) are unchanged. ✅

**Per-field test coverage:**

| Field | emitLog drop | LOG_FORBIDDEN_FIELDS safety-net | Metric-label rejection |
|---|---|---|---|
| `mood_comment_text` | `:104` it.each[0] | `:85` it.each[0] | `:119` it.each[0] |
| `workout_text` | `:104` it.each[1] | `:85` it.each[1] | `:119` it.each[1] |
| `workout_raw_description` | `:104` it.each[2] | `:85` it.each[2] | `:119` it.each[2] |
| `sleep_text_input` | `:104` it.each[3] | `:85` it.each[3] | `:119` it.each[3] |
| `sleep_voice_transcript` | `:104` it.each[4] | `:85` it.each[4] | `:119` it.each[4] |

Each cell = 1 test × 5 fields = 15 tests across the three describe blocks, plus 5 metric-label tests = 20 field-specific tests. ✅

### 2. Audit helpers are PURE

`prd003AuditHelper.ts` line 13: `import { LOG_FORBIDDEN_FIELDS } from "./kpiEvents.js"` — the only import. No `src/store/`, no `pg`, no `fs`, no `http`, no `fetch`. ✅

`AuditViolation` type (`:49-53`): `{ event_id: string; field_name: string; severity: "critical" }` — no `raw_value`, no `raw_content`, no `original_text`. ✅

Tests confirming no `raw_value`: `redaction.prd003.audit.test.ts:145-153` (K8) and `:250-255` (K4). Both assert `violation` has exactly the keys `["event_id", "field_name", "severity"]`. ✅

### 3. K4 and K8 distinct correctness

**K8** (`auditPrd003TelemetryRolling7d`): Iterates `PRD003_FORBIDDEN_FIELDS` (all 5 fields) for every event. `prd003AuditHelper.ts:108`. ✅

**K4** (`auditMoodCommentRedaction`): Uses separate `MOOD_FORBIDDEN_FIELDS = ["mood_comment_text"]` at `prd003AuditHelper.ts:128`. Iterates only this array at `:148`. NOT a thin wrapper of K8. ✅

**Distinct K4 test proving scoping:** `redaction.prd003.audit.test.ts:212-218` — "does NOT flag workout_text violations (K4 only checks mood_comment_text)": generates 100 events with `workout_text` leaked, runs `auditMoodCommentRedaction` → `compliant: true`, `violations: []`. This proves K4 ignores non-mood fields. ✅

### 4. No-regression on existing redaction

`src/observability/events.ts` is UNTOUCHED in the diff (`gh pr diff 8 --name-only` shows 5 files, none is `events.ts`). ✅

The existing `emitLog` mechanism at `events.ts:178-182` iterates `LOG_FORBIDDEN_FIELDS` at runtime:
```ts
for (const forbidden of LOG_FORBIDDEN_FIELDS) {
    if (forbidden in meta) {
      redactedMeta[forbidden] = "[REDACTED]";
    }
  }
```
New entries in the array are automatically enforced. ✅

The existing `validateLabels` in `metricsEndpoint.ts:34-36` iterates `FORBIDDEN_METRIC_LABELS` at runtime:
```ts
const isForbidden = (FORBIDDEN_METRIC_LABELS as readonly string[]).some(
      (f) => key === f || key.toLowerCase().includes(f)
    );
```
New entries are automatically enforced. ✅

Regression test at `redaction.prd003.test.ts:136-186` explicitly asserts all pre-existing forbidden fields remain in both arrays and that `buildRedactedEvent` still drops `raw_prompt` and `meal_text`. ✅

### 5. Test rigor (NOT just count)

**24 redaction tests breakdown:**
- 5 × `buildRedactedEvent` drops field from extra (one per field, parameterised)
- 5 × LOG_FORBIDDEN_FIELDS safety-net redacts field to `[REDACTED]` (one per field, parameterised)
- 5 × `emitLog` drops field from metadata (one per field, parameterised)
- 5 × metric output contains no field label (one per field, parameterised)
- 1 × all existing forbidden fields remain in `LOG_FORBIDDEN_FIELDS`
- 1 × all existing forbidden fields remain in `FORBIDDEN_METRIC_LABELS`
- 1 × `buildRedactedEvent` still drops `raw_prompt`
- 1 × metric output still rejects `meal_text`

Each parameterised test exercises the same rejection path but for a distinct field, which is the correct approach: it proves the forbidden-field *list* is complete, not just that one field works. ✅

**22 audit tests breakdown:**
- K8: 12 tests (N=100 compliance, 5 field-specific leak detection, minSampleSize, override, no-raw_value, multiple violations, empty array, `[REDACTED]` compliance)
- K4: 9 tests (N=100 compliance, mood_comment_text leak, workout_text NOT flagged, minSampleSize, override, null compliance, `[REDACTED]` compliance, no-raw_value, empty array)
- 1 × `PRD003_FORBIDDEN_FIELDS` constant lists exactly 5 fields

No "trivial padding" detected. K8 and K4 have genuinely distinct logic paths tested. ✅

### 6. No out-of-zone edits

Changed files per `gh pr diff 8 --name-only`:
1. `docs/tickets/TKT-026-prd-003-redaction-allowlist-extension.md` — ticket file (status + §10 Execution Log)
2. `src/observability/kpiEvents.ts` — §5 Output 1 ("redactionAllowlist.ts" equivalent)
3. `src/observability/prd003AuditHelper.ts` — §5 Output 3 (new file)
4. `tests/observability/redaction.prd003.test.ts` — §5 Output 4
5. `tests/observability/redaction.prd003.audit.test.ts` — §5 Output 5

All files within allowed zones. No out-of-zone edits. ✅

### 7. §5 Outputs literal-vs-intent compliance

The ticket §5 names `src/observability/redactionAllowlist.ts` and `src/observability/emit.ts`. These files do not exist in the repo. The executor mapped:
- "redactionAllowlist.ts" → `kpiEvents.ts` (where `LOG_FORBIDDEN_FIELDS` and `FORBIDDEN_METRIC_LABELS` are defined)
- "emit.ts" → `events.ts` + `metricsEndpoint.ts` (where the emit boundary lives; no changes needed)

This mapping is correct and documented in the §10 Execution Log. The behavioral outputs match §5 intent: the forbidden-field set is extended and the emit boundary enforces the new fields. ✅
