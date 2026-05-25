---
id: RV-CODE-015
type: code_review
target_pr: "https://github.com/code-yeongyu/openclown-assistant/pull/24"
ticket_ref: TKT-047@0.1.0
status: in_review
created: 2026-05-25
---

# Code Review — PR #24 (TKT-047@0.1.0)

## Summary
The PR aligns the shipped C20 Mood Logger comment-overflow behaviour with the canonical contract (ARCH-001@0.7.0 §6.2.2 C20): limit raised from 200 to 280 chars, silent-drop replaced by truncation with a friendly Russian notice (`COMMENT_TRUNCATED_REPLY`), and truncation uses `Array.from` for astral-plane safety as required by TKT-047@0.1.0 §7. The TKT-031@0.1.0 §2 docs-drift fix is a single-line text change with no frontmatter tampering. All 37 tests pass, typecheck is clean, and the two-commit split satisfies the §8 DoD separation requirement. One Medium observability finding: truncation events are indistinguishable from normal persist events in telemetry labels.

## Verdict
- [ ] pass
- [x] pass_with_changes
- [ ] fail

One-sentence justification: All six Acceptance Criteria are verifiably satisfied; one Medium observability finding (missing `wasTruncated` flag in telemetry labels) is not blocking but should be backlogged.
Recommendation to PO: approve & merge after addressing or backlogging F-M1.

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT §5 Outputs
  - `src/modality/mood/logger.ts`, `src/modality/mood/copy.ru.ts`, `tests/modality/mood/logger.test.ts`, `docs/tickets/TKT-031-c20-mood-logger.md` — all explicit §5 Outputs. The ticket file (`TKT-047-*.md`) has frontmatter `status` flip + `§10 Execution Log` appends — the executor carve-out per CONTRIBUTING.md §6.
- [x] No changes to TKT §3 NOT-In-Scope items
  - No changes to score-range guardrail, 5-min TTL, inferred-score confirmation flow, modality-OFF gate, or any other `src/modality/` directory.
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist
  - Zero `package.json` or `package-lock.json` changes.
- [x] All Acceptance Criteria from TKT §6 are verifiably satisfied (file:line or test name cited)
  - **AC #1** (`npm test` passes): 37/37 tests pass, vitest exit code 0.
  - **AC #2** (`lint` + `typecheck` clean): `tsc --noEmit` passes with zero errors (project `lint` script is `tsc --noEmit` per `package.json` line 8).
  - **AC #3** (schema CHECK ≤280 accepts every truncated value): schema `CHECK (comment_text IS NULL OR length(comment_text) <= 280)` is already on `main` (`src/store/schema.sql:441`); the new truncation function never emits >280 chars because `Array.from(text).slice(0, 280)` guarantees a max of 280 code-points.
  - **AC #4** (285-char comment persists 280, reply matches verbatim string): `tests/modality/mood/logger.test.ts:362-378` — `"а".repeat(285)` → `expect(commentArg).toHaveLength(280)` and `expect(result.text).toBe(COMMENT_TRUNCATED_REPLY.replace("{score}", "7"))`.
  - **AC #5** (no silent-drop path): `git grep "silent" src/modality/mood/logger.ts` returns only the comment-doc about pending-inference TTL expiry (line 17), which is intentional. The old `text.slice(0, COMMENT_MAX_LENGTH)` silently truncating has been replaced by `truncateComment` returning `{ text, wasTruncated }`, and the handler branches on `wasTruncated` to emit `COMMENT_TRUNCATED_REPLY`.
  - **AC #6** (TKT-031@0.1.0 §2 text drift fixed): `git diff origin/main...HEAD -- docs/tickets/TKT-031-c20-mood-logger.md` shows exactly one hunk on line 31: "Optional comment: truncate to ≤200 chars; drop comment if overlength rather than fail-open." → "Optional comment: truncate to ≤280 chars; emit friendly Russian notice on overflow." No frontmatter or other fields changed.
- [x] CI green (lint, typecheck, tests, coverage)
  - Tests: 37/37 pass (`vitest run tests/modality/mood/logger.test.ts`). Typecheck: `tsc --noEmit` clean (zero errors). `validate_docs.py` not runnable in review env (no python3) but no doc violations visible from manual inspection.
- [x] Definition of Done complete
  - PR opened with version-pinned TKT-047@0.1.0 in description. Executor filled §10 Execution Log. Two-commit split confirmed: `7758c8f` (all code + test + TKT-031@0.1.0 doc changes) and `64336d5` (status `ready→in_review` + §10 Execution Log append only).
- [x] Ticket frontmatter `status: in_review` in a separate commit
  - Commit `64336d5` touches ONLY `docs/tickets/TKT-047-mood-comment-overflow-alignment.md` with `status: ready → in_review` + §10 Execution Log appends.

## Findings

### High (blocking)
*(none)*

### Medium
- **F-M1 (`src/modality/mood/logger.ts:498-508` and `src/modality/mood/logger.ts:228-238`):** The `wasTruncated` flag is computed correctly and used for reply-text selection, but is NOT included in telemetry labels. Both `persistDirectScore` (lines 498-508) and the confirmed-inference path (lines 228-238) emit `modality_event_persisted` with labels `{ modality, source, score }` — identical for truncated and non-truncated events. A 3am operator cannot distinguish truncation events from normal persist events in metrics dashboards or structured-log queries without examining stored data or user-facing reply text. *Responsible role:* Executor. *Suggested remediation:* Add `wasTruncated` as a boolean label in the `buildRedactedEvent` payload for both emit sites (e.g. `{ modality: "mood", source: eventSource, score, wasTruncated }`). Backlogging is acceptable — the user-facing reply is unambiguous and no data is lost.

### Low
*(none)*

## Red-team probes (Reviewer must address each)
- **Error paths (Telegram / LLM / DB failure):** The truncation function (`truncateComment`) handles `null` input cleanly (returns `{ text: null, wasTruncated: false }`). If `insertMoodEvent` fails (network error, DB lock), the promise rejection propagates through the async handler chain — standard failure behaviour. `COMMENT_TRUNCATED_REPLY.replace("{score}", …)` is a synchronous string operation with no failure modes.
- **Concurrency:** Two messages from the same user are delivered sequentially by Telegram's bot API. Within the handler, each `handleMoodEvent` call receives its own dependency bag; no shared mutable state exists between invocations. No race condition on truncation.
- **Input validation:** The test fixture `"а".repeat(285)` exercises Cyrillic code-point truncation. `Array.from(text).slice(0, 280)` correctly counts any Unicode code-point (including astral-plane emoji) as one character, per TKT-047@0.1.0 §7. Oversized payloads (e.g. 10,000-char comment) would be truncated to 280 without crash or OOM — no loop over the full string beyond the `Array.from` iterator.
- **Prompt injection:** Comment text extracted by `extractExplicitScore` never reaches an LLM. It passes only through regex matching and then to `truncateComment` → `insertMoodEvent`. No unsanitised user text surface. The `buildRedactedEvent` payload includes `{ modality, source, score }` — no comment text in logs, preserving PII redaction semantics.
- **Tenant isolation:** All `insertMoodEvent` calls pass `userId` explicitly. The schema has RLS (`mood_events_user_id_isolation` at `schema.sql:563-564`) — active for the table. No new tables added. ✓
- **Secrets:** No new environment variables, no credentials in code or error messages. Zero diff on `package*.json`, `.env*`, or config files. ✓
- **Observability:** All persist paths emit `kbju_modality_event_persisted` with `{ modality, source, score }` labels. Truncation events are indistinguishable from non-truncation in telemetry (see **F-M1** above). No new observability events or metric names needed — the existing `PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted` counter covers all cases.
- **Rollback:** Reverting to the commit before `7758c8f` would restore the old 200-char silent-drop behaviour. The schema CHECK is already 280 on `main` (pre-existing), so the rollback target code would still be compatible with the schema. No migration needed either direction. ✓
