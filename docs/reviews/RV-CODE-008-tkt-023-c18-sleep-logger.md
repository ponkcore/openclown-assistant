---
id: RV-CODE-008
type: code_review
target_pr: "https://github.com/ponkcore/openclown-assistant/pull/12"
ticket_ref: TKT-023@0.1.0
status: in_review
created: 2026-05-25
---

# Code Review — PR #12 (TKT-023@0.1.0)

## Summary

The C18 Sleep Logger implementation correctly follows the six-path ADR-017@0.1.0 state machine with DST-safe attribution via `luxon`, a GC cron skill, and comprehensive test coverage across unit, DST, and sanity test files. Three Medium findings block a clean pass: (1) Russian copy uses guillemets `«»` for inline quotes where `ARCH-001@0.6.2` §6.2.2 specifies ASCII `"..."`; (2) the OFF-state path returns a non-empty reply string while §6.2.2 mandates "silent"; (3) `correctSanityWarnedSleep` leaks the pairing state and produces `is_paired_origin=false` when correcting after a paired-path sanity warning.

## Verdict
- [ ] pass
- [x] pass_with_changes
- [ ] fail

One-sentence justification: Three Medium copy-verbatim and logic-findings require executor remediation before merge — all functional ACs are met and the state machine is structurally correct.

Recommendation to PO: request changes from Executor (iterate once on copy + pairing-leak fix).

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT §5 Outputs (store types/tenantStore + mock updates are necessary infrastructure for new `TenantStore` methods — consistent with TKT-029@0.1.0 / TKT-031@0.1.0 precedent)
- [x] No changes to TKT §3 NOT-In-Scope items
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist (`luxon@^3.7.2` + `@types/luxon` — single new runtime dep, authorized by ADR-017@0.1.0 §Decision)
- [x] All Acceptance Criteria from TKT §6 are verifiably satisfied (file:line or test name cited — see §6 AC walkthrough below)
- [ ] CI green (lint, typecheck, tests, coverage) — **Cannot verify locally** (no Node.js runtime available in review environment). Executor's §10 Execution Log claims: "tests 56 pass; lint clean; typecheck clean."
- [x] Definition of Done complete (see DoD walkthrough below)
- [x] Ticket frontmatter `status: in_review` in the diff (`TKT-023-c18-sleep-logger.md` line 10: `+status: in_review`)

## Findings

### High (blocking)
(none)

### Medium
- **F-M1** (`src/modality/sleep/copy.ru.ts`:17,25): `EVENING_ACK_REPLY` uses guillemets `«встал»` where `ARCH-001@0.6.2` §6.2.2 specifies ASCII double quotes `"встал"`. Same deviation in `MORNING_NO_PAIR_REPLY`: three inline quotes `«лёг»`, `«поспал(а) 7 часов»`, `«лёг в 23, встал в 7»` should be `"лёг"`, `"поспал(а) 7 часов"`, `"лёг в 23, встал в 7"` per §6.2.2 verbatim. The `SANITY_FLOOR_WARN` string correctly uses `«дневной сон»` (matching §6.2.2 which itself nests guillemets there). — *Responsible role:* Executor. *Suggested remediation:* Replace inner guillemets with ASCII `"` in `EVENING_ACK_REPLY` and `MORNING_NO_PAIR_REPLY` only; leave `SANITY_FLOOR_WARN` unchanged.

- **F-M2** (`src/modality/sleep/copy.ru.ts`:31, `src/modality/sleep/logger.ts`:236-244): `OFF_STATE_REPLY` is `"Запись сна сейчас выключена."` but `ARCH-001@0.6.2` §6.2.2 says "Modality OFF: silent." The copy file comment acknowledges this ("silent per §6.2.2, but we keep a reply for debug") but `handleSleepEvent` returns the non-empty text to the caller, so the bot will send a Telegram message. `PRD-003@0.1.3` §5 US-2 6th AC says "a no-op friendly reply" — direct conflict with §6.2.2. The ticket §6.8 says "Russian-language replies match the PO-ratified copy file" and the copy file header says "CHARACTER-FOR-CHARACTER per `ARCH-001@0.6.2` §6.2.2." — *Responsible role:* Executor. *Suggested remediation:* Either (a) return `text: ""` for OFF-state and let the caller suppress the message (matching §6.2.2 "silent"), or (b) escalate to PO to resolve the PRD-vs-§6.2.2 conflict and ratify the non-silent reply.

- **F-M3** (`src/modality/sleep/logger.ts`:598-633, `correctSanityWarnedSleep`): When a paired path-3 sanity warning triggers (e.g. "встал" 10 min after "лёг") and the user corrects via "опечатка, 7 часов", `correctSanityWarnedSleep` delegates to `handleSleepEvent({kind: "single_duration"})` which: (a) inserts the record with `is_paired_origin=false` instead of `true`; (b) does NOT delete the stale pairing state from `sleep_pairing_state`. By contrast, `confirmSanityWarnedSleep` correctly handles this at line 585: `if (isPairedOrigin) { await deps.store.deleteSleepPairingState(userId); }`. The correction path has no access to the `isPairedOrigin` flag from the original `sanityPending` context. Impact: stale pairing remains until GC (≤24 h); a subsequent "встал" within that window creates a phantom duplicate record; the corrected record has the wrong `is_paired_origin` flag. No test covers the paired-correction scenario. — *Responsible role:* Executor. *Suggested remediation:* Accept `isPairedOrigin` in the `correctSanityWarnedSleep` signature (or a full `sanityPending` object); if paired-origin, call `store.deleteSleepPairingState(userId)` after the correction insert; add a test for paired correction.

### Low
- **F-L1** (`tests/modality/sleep/logger.unit.test.ts`:408-428): OFF-state is tested only on the `evening_leg` path (path 1). The OFF-state gate at `logger.ts`:236 applies before all paths (correct), but paths 3 (`morning_vstal`) and 5 (`single_duration`) — which would otherwise persist records — lack explicit OFF-state tests. — *Responsible role:* Executor. *Suggested remediation:* Add two OFF-state tests: one for `morning_vstal` and one for `single_duration` with `sleepOn: false`.

- **F-L2** (`tests/modality/sleep/*.test.ts`): No explicit assertions on telemetry emit shape. Tests verify return values (`persisted`, `durationMin`, `sourceLabel`) but do not assert that `emitLog` / `buildRedactedEvent` was called with `KPI_EVENT_NAMES.modality_event_persisted` or the expected label set. The mandate's probe "kbju_modality_event_persisted emitted on paths 3, 5. Tests assert this" cannot be verified from the test code alone. — *Responsible role:* Executor. *Suggested remediation:* Add `expect(deps.logger.info).toHaveBeenCalledWith(expect.objectContaining({event: "kbju_modality_event_persisted", ...}))` or equivalent for paths 3 and 5.

## §6 Acceptance Criteria walkthrough

| AC | Evidence | Verdict |
|---|---|---|
| `npm test -- tests/modality/sleep/` passes | 56 tests across 4 files (executor §10 log). Test files exist and are structurally correct. CI not runnable locally. | ✅ (unverifiable locally, executor claims green) |
| `npm run lint` clean | Executor §10 log: "lint clean." | ✅ (unverifiable locally) |
| `npm run typecheck` clean | Executor §10 log: "typecheck clean." | ✅ (unverifiable locally) |
| Manual smoke: "лёг" → ack; 7 h later "встал" → paired record, duration 420, `is_paired_origin=true` | `logger.unit.test.ts`:197-219 (path 1 ack), `logger.unit.test.ts`:249-286 (path 3 paired persist, asserts duration 420, sourceLabel "paired") | ✅ |
| Manual smoke: "спал 7 часов" → `is_paired_origin=false`, duration 420 | `logger.unit.test.ts`:310-338 (path 5, regex extracts 420 min, isPairedOrigin=false) | ✅ |
| Manual smoke: "спал 10 минут" → floor warn; "да" → persist; "опечатка, 7 часов" → re-parse + persist | `logger.sanity.test.ts`:82 (floor warn), `:118` (confirm → persist), `:149` (correct → re-parse 420 min) | ✅ |
| Manual smoke: "встал" without "лёг" → clarifying reply | `logger.unit.test.ts`:289-307 (path 4, MORNING_NO_PAIR_REPLY) | ✅ |
| DST smoke: LA spring-forward 2026-03-08 02:30→09:30 | `logger.dst.test.ts`:229-264 (exact AC scenario, asserts duration 360 min UTC-anchored, attribution_date_local 2026-03-08) | ✅ |
| Russian copy matches `src/modality/sleep/copy.ru.ts` | Copy matches `ARCH-001@0.6.2` §6.2.2 for 5 of 7 strings. Two deviations: inner-quote style (F-M1) and OFF-state (F-M2). | ⚠️ (F-M1, F-M2) |

## Definition of Done walkthrough

| DoD item | Status |
|---|---|
| All §6 ACs pass | ✅ (with F-M1/M2 copy caveats) |
| `src/modality/sleep/copy.ru.ts` single source of truth | ✅ |
| `src/modality/sleep/logger.ts` handles all six paths | ✅ (paths 1-5 in logger.ts; path 6 in sleep-gc) |
| `src/skills/sleep-gc/` cron skill GCs expired pairing rows | ✅ (cron `0 * * * *`, parameterised DELETE) |
| DST smoke in 3 zones | ✅ (`logger.dst.test.ts`: Moscow + Belgrade + LA) |
| Sanity floor/ceiling tested with confirm + correct branches | ✅ (`logger.sanity.test.ts` — all 4 confirm/correct paths) |
| luxon as single new runtime dep | ✅ (`luxon@^3.7.2` + `@types/luxon@^3.7.1` only) |
| `kbju_modality_event_persisted{modality=sleep,...}` on persist | ✅ (emitted on paths 3, 5 — also emitted on paths 1, 2, 4 which is semantically questionable but not harmful) |
| No raw_text in any emit | ✅ (`sleep_records` INSERT has no `raw_text` column; emit payloads contain `modality`, `source`, `duration_min`, `is_nap`, `attribution_date_local`, `event_id` only) |
| All SQL parameterised | ✅ (all queries use `$1`, `$2`, etc. positional params) |
| No `console.log` | ✅ (grep returned zero hits in sleep module and GC skill) |
| No `TODO`/`FIXME` without follow-up TKT | ✅ (grep returned zero hits) |
| Executor filled §10 Execution Log | ✅ (ticket diff shows 2 log entries) |
| Ticket frontmatter `status: in_review` | ✅ (ticket diff line 10: `+status: in_review`) |

## Red-team probes (Reviewer must address each)

- **Error paths:** `handleSleepEvent` is entirely async/await with no try/catch around store calls. If `getSleepPairingState` or `insertSleepRecord` throws (DB down, connection pool exhausted), the error propagates to the caller unhandled. The GC skill (`runSleepGc`) likewise has no error handling around `gcExpiredSleepPairingState`. This is acceptable for a first iteration — the caller (Telegram handler) is expected to catch and reply with a generic error. No concern for this PR, but a follow-up TKT for structured error handling may be warranted.

- **Concurrency:** Two "лёг" messages from the same user within milliseconds could race on `upsertSleepPairingState`. The `ON CONFLICT (user_id) DO UPDATE` clause makes this idempotent — the last write wins, which is the correct behavior per ADR-017@0.1.0 path 2 (replace). Two "встал" messages could both read the pairing state and both insert records. The `deleteSleepPairingState` after insert reduces but does not eliminate this race. Acceptable for a 2-user pilot; a unique constraint or advisory lock would be needed at scale. No concern for this PR.

- **Input validation:** The `extractDurationFromText` regex covers numeric ("7 часов", "7ч", "7.5 ч", "7,5 часов"), word-form ("семь часов"), and special ("полчаса") patterns. It returns `null` on no match, falling through to the LLM extractor or the "could not extract" reply. Unicode edge cases (Cyrillic vs Latin "ч") are handled by the regex matching Cyrillic. No concern.

- **Prompt injection:** The `rawText` from user input is passed to `extractDurationFromText` (regex only, no LLM) and optionally to `llmDurationExtractor` (an injected dependency, not defined in this PR). The regex extraction is safe — it only parses numbers and unit words. If the LLM extractor is used, the raw text goes to the LLM unsanitised, but that's the LLM adapter's responsibility. The `buildRedactedEvent` function handles PII redaction per `ARCH-001@0.4.0` §10.7. No concern for this PR (LLM extractor is an optional injection, not implemented here).

- **Tenant isolation:** All `TenantScopedRepository` methods use parameterised queries scoped by `user_id`. The `gcExpiredSleepPairingState` in `TenantPostgresStore` deliberately bypasses `withTransaction` and uses `this.pool.query` directly — this is correct for a system-wide GC that operates across all tenants. RLS policies on `sleep_pairing_state` (from TKT-021@0.1.0) would not interfere with pool-level queries. No concern.

- **Secrets:** No credentials committed. `package.json` and `package-lock.json` contain only public npm registry URLs. No `.env` files modified. No secrets in error messages (the emit payloads use `buildRedactedEvent` for PII redaction). No concern.

- **Observability:** Every state-machine path emits a structured log via `emitLog` + `buildRedactedEvent` with `KPI_EVENT_NAMES.modality_event_persisted`. The event includes `modality: "sleep"`, `source`, and contextual labels (`duration_min`, `is_nap`, `attribution_date_local`, `event_id`). The GC skill emits when rows are deleted. A 3am operator can trace a sleep event through its `requestId`. Metric names follow the existing `kbju_` prefix convention. No concern.

- **Rollback:** The PR adds new files (`src/modality/sleep/*`, `src/skills/sleep-gc/*`) and extends existing store interfaces. Rolling back requires: (1) reverting the PR, (2) removing the new `TenantStore` methods from `src/store/types.ts` and `src/store/tenantStore.ts`, (3) reverting the mock updates in `breachDetector.test.ts` and `tenantStore.test.ts`. The rollback is straightforward — no schema migrations are included (TKT-021@0.1.0 owns the tables). The `luxon` dependency would remain in `package.json` but is harmless. No concern.

- **Prompt injection (copy.ru.ts):** Copy strings are hardcoded constants, not user-interpolated. The `{h}`, `{m}`, `{start}`, `{end}` placeholders are replaced with sanitized values (numbers and luxon-formatted times). No concern.

## §6 ACs detailed evidence

| # | AC text | Evidence |
|---|---|---|
| 1 | `npm test -- tests/modality/sleep/` passes | `logger.unit.test.ts` (593 lines, 29 `it()` blocks), `logger.dst.test.ts` (265 lines, 9 `it()` blocks), `logger.sanity.test.ts` (305 lines, 12 `it()` blocks) |
| 2 | `npm run lint` clean | Executor §10 log |
| 3 | `npm run typecheck` clean | Executor §10 log |
| 4 | "лёг" → ack; "встал" → paired record, `is_paired_origin=true`, `duration_min≈420` | `logger.unit.test.ts`:197 (path 1), `:249` (path 3, asserts `persisted: true`, `durationMin: 420`, `sourceLabel: "paired"`, `insertSleepRecord` called with `isPairedOrigin: true`) |
| 5 | "спал 7 часов" → `is_paired_origin=false`, `duration_min=420` | `logger.unit.test.ts`:310 (path 5, asserts `persisted: true`, `durationMin: 420`) |
| 6 | "спал 10 минут" → floor warn; "да" → persist; "опечатка, 7 часов" → re-parse + persist | `logger.sanity.test.ts`:82 (floor warn), `:118` (confirm → persist), `:149` (correct → 420 min) |
| 7 | "встал" without "лёг" → clarifying reply, no record | `logger.unit.test.ts`:289 (path 4, `MORNING_NO_PAIR_REPLY`, `persisted: false`) |
| 8 | DST smoke: LA 2026-03-08 02:30→09:30, `attribution_date_local=2026-03-08`, duration UTC-anchored | `logger.dst.test.ts`:229 (asserts `durationMin: 360`, `attribution_date_local: "2026-03-08"`) |
| 9 | Russian copy matches `src/modality/sleep/copy.ru.ts` | 5 of 7 strings match §6.2.2 verbatim; 2 deviations (F-M1, F-M2) |

## Iteration 2 verdict (Reviewer, 2026-05-25)

**Iter-2 diff scope:** `07d6cad..5ccc9e5` — 5 files changed, +209 −32. Files: `src/modality/sleep/copy.ru.ts`, `src/modality/sleep/logger.ts`, `tests/modality/sleep/logger.sanity.test.ts`, `tests/modality/sleep/logger.unit.test.ts`, `docs/tickets/` `TKT-023-c18-sleep-logger.md` (execution-log append only). No out-of-zone files touched.

**F-M1 (ASCII quotes) — CLOSED:**
- `copy.ru.ts`:17 — `EVENING_ACK_REPLY` now uses `\"встал\"` (ASCII escaped double quotes). ✅
- `copy.ru.ts`:26 — `MORNING_NO_PAIR_REPLY` now uses `\"лёг\"`, `\"поспал(а) 7 часов\"`, `\"лёг в 23, встал в 7\"` (all ASCII). ✅
- `copy.ru.ts`:32 — `SANITY_FLOOR_WARN` keeps `«дневной сон»` (guillemets) per `ARCH-001@0.6.2` §6.2.2 verbatim. ✅
- New header comment (`copy.ru.ts`:12-13) clarifies the §6.2.2 rule: ASCII for inline command words, guillemets for descriptive labels. ✅

**F-M2 (OFF-state silent) — CLOSED:**
- `logger.ts`:240 — OFF-state branch returns `{ text: "", persisted: false }`. Empty string is the correct "silent" shape per §6.2.2. ✅
- `OFF_STATE_REPLY` import removed from `logger.ts` (no runtime callers remain). ✅
- `copy.ru.ts`:37-38 — `OFF_STATE_REPLY` kept as export with `@internal` debug comment; no production code path references it. Acceptable. ✅
- Dispatch surface: `handleSleepEvent` has no Telegram-wiring callers in this PR (that's a future TKT). The return contract (`text: ""`) is correct — the future caller must suppress Telegram messages when `text === ""`. This matches §6.2.2 "Modality OFF: silent." ✅
- `logger.unit.test.ts`:424 — existing OFF-state test updated to assert `result.text === ""` (was `OFF_STATE_REPLY`). ✅

**F-M3 (paired-correction preserves is_paired_origin + deletes pairing) — CLOSED:**
- `logger.ts`:634 — `correctSanityWarnedSleep` signature now accepts `isPairedOrigin: boolean` as 5th parameter. ✅
- `logger.ts`:706-708 — `insertSleepRecord` call passes `isPairedOrigin` through to the store. ✅
- `logger.ts`:711-713 — `if (isPairedOrigin) { await deps.store.deleteSleepPairingState(userId); }` — pairing state deleted after correction insert. ✅
- `sanityPending` shape (`logger.ts`:77-83) carries `isPairedOrigin` from path-3 trigger (`logger.ts`:324: `isPairedOrigin: true`) and path-5 trigger (`logger.ts`:473: `isPairedOrigin: false`). ✅
- `logger.sanity.test.ts`:228-254 — new test for paired correction asserts `insertSleepRecord` called with `is_paired_origin=true` AND `deleteSleepPairingState` called once with `USER_ID`. ✅
- `logger.unit.test.ts`:594-624 — new "F-M3" test asserts `is_paired_origin=true` preserved, `sourceLabel: "paired"`, `deleteSleepPairingState` called. ✅

**F-L1 (OFF-state tests for paths 3, 5) — CLOSED:**
- `logger.unit.test.ts`:629-648 — "OFF-state on morning_vstal" test: `sleepOn: false`, kind `morning_vstal` → `text === ""`, `persisted === false`, `insertSleepRecord` not called. ✅
- `logger.unit.test.ts`:650-670 — "OFF-state on single_duration" test: `sleepOn: false`, kind `single_duration` → `text === ""`, `persisted === false`, `insertSleepRecord` not called. ✅

**F-L2 (telemetry-emit-shape rigor) — NOTED, not addressed:**
- Non-blocking nit from iter-1. Tests still do not assert on `emitLog`/`buildRedactedEvent` call shapes. Backlog after merge.

**Out-of-zone diff sweep:** `07d6cad..5ccc9e5` touches exactly 5 files, all within `src/modality/sleep/**`, `tests/modality/sleep/**`, and the ticket file. No out-of-zone files. ✅

**No-regression sweep:** No Node.js runtime available locally; cannot run typecheck/lint/tests. Executor §10 log claims clean. Iter-2 changes are narrow: removed one import, added one parameter to an existing function signature, updated existing test assertions, added new test blocks. No modification to production logic outside the three M-finding remediations. Structural risk is low.

**Minor style nit (Low, non-blocking):** New `describe` blocks appended at `logger.unit.test.ts`:594 and `:627` are at file top-level but indented with 2 spaces (matching the inner describe convention). Functionally correct; inconsistent with the 0-space indent of other top-level describes (`extractDurationFromText`, `formatDurationHm`, etc.). Not worth an iteration.

### Iteration 2 status:
- F-M1: closed (ASCII quotes per `ARCH-001@0.6.2` §6.2.2)
- F-M2: closed (OFF-state returns `text: ""`, silent per §6.2.2)
- F-M3: closed (`isPairedOrigin` passed through + `deleteSleepPairingState` called on paired correction)
- F-L1: closed (2 OFF-state tests added for `morning_vstal` + `single_duration`)
- F-L2: noted, not addressed (telemetry-shape rigor — non-blocking, backlog)

### New findings introduced by iter-2:
- None. (One Low style nit noted above — non-blocking.)

### Updated overall verdict:
- [x] pass
- [ ] pass_with_changes
- [ ] fail

One-sentence justification: All three Medium findings are verifiably closed with correct implementations and matching tests; remaining Low (F-L2) is backlog-only.

Recommendation to PO: **merge** — all blocking findings resolved; F-L2 telemetry nit is non-blocking backlog.
