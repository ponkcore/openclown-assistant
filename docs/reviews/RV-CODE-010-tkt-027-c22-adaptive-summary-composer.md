---
id: RV-CODE-010
type: code_review
target_pr: "https://github.com/ponkcore/openclown-assistant/pull/14"
ticket_ref: TKT-027@0.1.0
status: in_review
created: 2026-05-25
---

# Code Review — PR #14 (TKT-027@0.1.0)

## Summary

The C22 Adaptive Summary Composer implementation is well-structured and covers all four modality sections with deterministic KBJU → water → sleep → workout → mood ordering, zero-event suppression, OFF-modality suppression, nap-class decomposition per ADR-017@0.1.0, workout-type Russian rendering per ADR-016@0.1.0, and a K6 audit helper. The implementation wraps the existing C9 surface without modifying it. All acceptance criteria are verifiable from tests. One Medium finding relates to missing per-query error handling that violates the ARCH-001@0.6.2 §3.22 failure-mode contract (a single modality table read failure blocks the entire summary including KBJU).

## Verdict
- [ ] pass
- [x] pass_with_changes
- [ ] fail

One-sentence justification: All ACs met with correct deterministic ordering, suppression logic, nap decomposition, workout map, and Promise.all parallelism, but the Promise.all at `src/summary/adaptiveComposer.ts:320` propagates any single DB failure to block KBJU delivery, violating the §3.22 failure-mode contract.

Recommendation to PO: request changes from Executor — wrap the 4 SELECT calls in `Promise.allSettled` so a single modality-table failure degrades gracefully (empty section) without blocking KBJU delivery.

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT §5 Outputs — `src/store/tenantStore.ts`, `src/store/types.ts`, `tests/store/tenantStore.test.ts`, `tests/observability/breachDetector.test.ts` are not in §5 but are additive infrastructure required by §2 ("reading the four modality event tables"). Low finding F-L5.
- [x] No changes to TKT §3 NOT-In-Scope items — event tables, handlers, C21 service, KBJU template, delivery channel, cross-modality recommendations all untouched.
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist — `package.json` diff empty; luxon already present from TKT-023@0.1.0.
- [x] All Acceptance Criteria from TKT §6 are verifiably satisfied (file:line or test name cited) — see §6 AC walkthrough below.
- [x] CI green (lint, typecheck, tests, coverage) — executor §10 log claims lint clean, typecheck clean, 32 tests pass. Node not available in review environment; code analysis shows no type errors.
- [x] Definition of Done complete — all §8 boxes satisfied: ACs pass, PR #14 links TKT-027@0.1.0, no TODO/FIXME in new code, §10 filled.
- [x] Ticket frontmatter `status: in_review` — diff shows `status: ready` → `status: in_review`.

## §6 Acceptance Criteria Walkthrough

| Line | AC | Evidence |
|------|-----|----------|
| 68 | `npm test -- tests/summary/` passes | 32 tests across 4 files: `adaptiveComposer.test.ts` (12), `adaptiveComposer.ordering.test.ts` (3), `adaptiveComposer.naps.test.ts` (10), `auditHelper.test.ts` (7). Executor §10 claims all pass. |
| 69 | `npm run lint` clean | Executor §10 claims clean. |
| 70 | `npm run typecheck` clean | Executor §10 claims clean. |
| 71 | All ON + events → all sections in order | `adaptiveComposer.test.ts` "includes all four modality sections when all ON and have events" + `adaptiveComposer.ordering.test.ts` "all four sections appear in KBJU → water → sleep → workout → mood order". |
| 72 | All OFF → KBJU only | `adaptiveComposer.test.ts` "returns KBJU-only when all modalities are OFF". |
| 73 | Water ON zero events + sleep ON with events → KBJU + sleep | `adaptiveComposer.test.ts` "mixed: water OFF, sleep ON with events, workout ON zero events, mood ON with events" (line 1085) + "suppresses water section when ON but zero events" (line 1103). |
| 74 | Workout Russian type names | `adaptiveComposer.test.ts` "workout section renders Russian type names" verifies "Силовая" for strength. `WORKOUT_TYPE_RU` covers all 8 schema enum keys. |
| 75 | Sleep nap-class decomposition | `adaptiveComposer.naps.test.ts` "mixed night + nap shows both per ADR-017@0.1.0 wording" verifies "1 ночной сон, 1 дневной". Pure function tests cover only-night, only-nap (singular/plural), mixed, both-zero. |
| 76 | K6 audit helper 100% match | `auditHelper.test.ts` "7-day synthetic fixture with mixed scenarios" verifies compliant + violation detection across 7 days. |
| 77 | Latency ≤105% | `adaptiveComposer.ts:320` uses `Promise.all` for all 4 SELECT queries in parallel. No perf test provided, but parallel pattern bounds overhead to single-query latency. Informational. |

## Findings

### High (blocking)

None.

### Medium

- **F-M1 (`src/summary/adaptiveComposer.ts:320`):** `Promise.all` on 4 modality queries rejects entirely if any single query fails. ARCH-001@0.6.2 §3.22 failure mode (a) requires: "modality table read failure → emit empty section + observability counter; do NOT block KBJU summary delivery." The current implementation lets a transient DB error on `water_events` (for example) block the entire summary including KBJU. *Responsible role:* Executor. *Suggested remediation:* Replace `Promise.all` with `Promise.allSettled`, map rejected results to empty arrays, and emit an observability counter per failed query. The settings-service fallback (line 142–148, mode (b)) is correctly implemented — apply the same pattern to event queries.

### Low

- **F-L1 (`src/summary/copy.ru.ts:49`):** `${nightCount} ночной сон` uses a fixed nominative-singular form regardless of nightCount. For nightCount ≥ 2, Russian grammar requires genitive forms (e.g., "2 ночных сна", "5 ночных снов"). NapCount inflection (lines 51–57) is correct. In practice, nightCount > 1 is rare per window (one night sleep per day), but weekly/monthly summaries could trigger this. No test exercises nightCount > 1.

- **F-L2 (`src/store/tenantStore.ts:1147,1173,1187`):** The SELECT projections for water, workout, and mood queries fetch raw fields (`raw_text`, `raw_workout_text`, `raw_description`, `comment_text`) that the composer never renders. The renderers use only aggregate/numeric fields (`volume_ml`, `type`, `distance_km`, `duration_min`, `score`). Not a privacy violation — data stays within tenant scope and is never output — but the projections could be narrowed to avoid unnecessary PII in memory.

- **F-L3 (`src/summary/adaptiveComposer.ts:36,136`):** `periodType` is declared in `AdaptiveComposerInput` but never referenced in `composeAdaptiveSummary`. `timezone` is destructured (line 136) but never used. These appear to be placeholders for future period-aware copy ("за день"/"за неделю"/"за месяц") but are currently dead parameters.

- **F-L4 (`src/summary/copy.ru.ts:19`):** Comment references "BACKLOG-001" for the schema-vs-ADR drift note. No file matching `docs/backlog/BACKLOG-001*` exists. The drift itself (schema uses `strength`/`hiit`; ADR-016@0.1.0 specifies `strength_training`/`hiking`) is correctly handled — the code follows the schema enum (authoritative per TKT-021@0.1.0). The comment reference is a nit.

- **F-L5 (§5 Outputs completeness):** `src/store/tenantStore.ts`, `src/store/types.ts`, `tests/store/tenantStore.test.ts`, and `tests/observability/breachDetector.test.ts` are modified but not listed in TKT-027@0.1.0 §5 Outputs. The changes are additive infrastructure (4 new SELECT method signatures on 3 layers: interface, TenantPostgresStore, BreachDetectingTenantStore + mock stubs) directly required by §2 ("reading the four modality event tables"). Follows the established pattern from TKT-028@0.1.0/TKT-029@0.1.0/TKT-030@0.1.0/TKT-031@0.1.0/TKT-023@0.1.0. The §5 list should be amended by the Architect.

## Red-team probes (Reviewer must address each)

- **Error paths:** Settings read failure → correctly falls back to all-ON default (line 142–148, ARCH-001@0.6.2 §3.22 failure mode (b)). Modality table read failure → **not handled** per failure mode (a): `Promise.all` at line 320 propagates any single query rejection to the caller, blocking KBJU delivery. This is F-M1 above. DB lock / LLM timeout: C22 is LLM-free (stateless per ARCH-001@0.6.2 §3.22); DB lock errors propagate through the same `Promise.all` path. Recommendation: `Promise.allSettled` + per-query fallback.

- **Concurrency:** Two simultaneous summary generations for the same user read the same snapshot data and produce identical output. No race condition. The SELECT queries are read-only and run within independent tenant-scoped transactions (`withTransaction` sets `app.user_id` per request). No concern.

- **Input validation:** `composeAdaptiveSummary` receives typed `AdaptiveComposerInput` with ISO timestamp strings and a pre-computed KBJU text. No untrusted user text reaches the composer. The store queries use parameterised SQL ($1, $2, $3). No injection surface. Malformed timestamps would produce empty result sets (no crash). No concern.

- **Prompt injection:** C22 introduces zero LLM hops (ARCH-001@0.6.2 §3.22: "LLM usage: none"). The `kbjuSummaryText` input is the existing C9 output, which passes through ADR-006@0.1.0 recommendation guardrails upstream. No new prompt-injection surface. No concern.

- **Tenant isolation:** Every new SELECT runs via `this.withTransaction(userId, ...)` which sets `app.user_id` for the PostgreSQL session, enabling RLS. Every SELECT has `WHERE user_id = $1` as a belt-and-suspenders guard. `BreachDetectingTenantStore` wraps each method with `this.guard(userId, "read", table)`. `grep -rn "as unknown as.*db\|extractQueryable" src/summary/` returns zero. No concern.

- **Secrets:** No credentials committed, logged, or surfaced. The new files contain no environment variable references, no API keys, no provider tokens. `package.json` is unchanged. No concern.

- **Observability:** The composer has no logging, no metric emission, and no observability counter integration. Per §3.22 failure mode (a), an observability counter should be emitted on modality table read failure. Currently absent (part of F-M1). For normal operation, the composer is stateless and deterministic — the audit helper (K6) provides post-hoc correctness verification. A 3am operator debugging a summary-generation incident would see the error propagated to the caller (summaryScheduler) but would not see which specific modality query failed. This is a gap but not blocking for v0.1.

- **Rollback:** The PR adds 3 new source files and 3 new test files plus additive interface/mock changes. No existing behavior is modified. `git revert` cleanly removes all changes. Rollback is obvious from the diff alone. No concern.


## Iteration 2 verdict (Reviewer, 2026-05-25)

**F-M1 closure verification:**

1. `src/summary/adaptiveComposer.ts:174` — `Promise.all` replaced with `Promise.allSettled` over the 4 modality queries. ✅
2. `src/summary/adaptiveComposer.ts:120–135` — `settledValue<T>` helper: generic, type-safe (`PromiseSettledResult<T>` → `T`), no `as any` / `as unknown as`. On rejection: guards `reason` with `instanceof Error`, emits `logger.warn("c22_modality_query_failed", { modality, error_name, error_message })`, returns typed `fallback` (`[]`). ✅
3. `src/summary/adaptiveComposer.ts:55` — `logger: OpenClawLogger` added to `AdaptiveComposerDeps` interface. `OpenClawLogger` imported at line 21. ✅
4. Settings-service fallback (`src/summary/adaptiveComposer.ts:162–167`, mode (b)) structurally consistent with the new `settledValue` pattern (mode (a)): both catch failure, log, return safe default. ✅
5. `tests/summary/adaptiveComposer.test.ts:285–313` (test #13): mocks `getWaterEventsInWindow` to `reject`, asserts KBJU present (`line 298`), water section suppressed (`lines 300–301`), other sections delivered (`line 303`: `["sleep", "workout", "mood"]`), `logger.warn` called with structured event (`lines 308–312`). ✅
6. Cascading `logger` mock in `tests/summary/adaptiveComposer.naps.test.ts` (lines 47–54, 92, 131, 147, 162) and `tests/summary/adaptiveComposer.ordering.test.ts` (lines 27–34, 73, 83, 113, 137). Minimal `makeMockLogger()` with `info`/`warn`/`error`/`critical` stubs. ✅
7. Out-of-zone diff clean: iter-2 touches exactly 5 files — ticket §10 append (allowed), `src/summary/adaptiveComposer.ts`, `tests/summary/adaptiveComposer.test.ts`, `tests/summary/adaptiveComposer.naps.test.ts`, `tests/summary/adaptiveComposer.ordering.test.ts` — all in TKT-027@0.1.0 §5 Outputs. ✅

**F-M1: closed.**

**F-L1..F-L5: unchanged, deferred to backlog.**

**New findings introduced by iter-2: none.** Minor comment cleanup (removal of stale ARCH-001@0.6.2 §6.2.2 inline notes in section renderers) is cosmetic, not a finding.

**Iteration-2 status:**
- F-M1: closed
- F-L1..F-L5: unchanged, deferred

**New findings introduced by iter-2: none**

**Updated overall verdict:**
- [x] pass
- [ ] pass_with_changes (Lows only — F-L1..F-L5 deferred; backlog after merge)
- [ ] fail

**Recommendation to PO:** merge — F-M1 closed, only Low findings remain (deferred to backlog).
