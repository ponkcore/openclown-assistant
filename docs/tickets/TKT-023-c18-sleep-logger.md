---
id: TKT-023
title: C18 Sleep Logger with paired-event state machine + sanity-floor + DST-safe
  attribution
version: 0.1.0
status: ready
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
component: C18
depends_on:
- TKT-021@0.1.0
- TKT-022@0.1.0
blocks:
- TKT-027@0.1.0
estimate: L
created: 2026-05-06
updated: 2026-05-06
---

# TKT-023: C18 Sleep Logger with paired-event state machine + sanity-floor + DST-safe attribution

## 1. Goal
Land the C18 Sleep Logger implementing the ADR-017@0.1.0 paired-event state machine, sanity-floor / ceiling soft-warn flow, and DST-safe attribution.

## 2. In Scope
- New module `src/modality/sleep/logger.ts` exporting the state-machine handler per ADR-017@0.1.0 §Decision (six paths: evening-no-pair, evening-replace-pair, morning-with-pair, morning-no-pair, single-event-morning-duration, hourly-GC).
- DST-safe `attribution_date_local` computation using `luxon` (already an Architect-locked dependency choice in ADR-017@0.1.0; verify whether luxon is already in `package.json` and add only if absent — single new runtime dep is acceptable per ADR-017@0.1.0 §Decision; otherwise reuse).
- Hourly GC cron skill `src/skills/sleep-gc/index.ts` reusing C8 Cron Dispatcher to delete `sleep_pairing_state` rows where `expires_at_utc < now`.
- Russian-language reply copy for each state-machine branch (ratified by PO before sign-off; baseline copy in §6 of this ticket).
- Smoke test for DST transitions in three diverse zones: `Europe/Moscow` (no DST since 2014), `Europe/Belgrade` (EU DST), `America/Los_Angeles` (US DST).

## 3. NOT In Scope
- The `sleep_records` + `sleep_pairing_state` tables themselves (TKT-021@0.1.0).
- Modality routing of sleep keywords (TKT-022@0.1.0).
- C5 voice transcription changes (reused as-is from PRD-001@0.2.0).
- C22 Adaptive Summary Composer reading sleep records (TKT-027@0.1.0).
- Right-to-delete cascade for `sleep_records` (already covered by TKT-021@0.1.0 cascade migration).
- Manual fragmented-sleep-merge UX (PRD-003@0.1.3 §8 R2 explicitly defers to a future PRD).
- Past-date entry / retroactive backfill (PRD-003@0.1.3 §3 NG11 forbids).

## 4. Inputs
- ARCH-001@0.6.0 §3.18 (C18 spec)
- ADR-017@0.1.0 §Decision (verbatim state machine + storage contract + DST policy)
- PRD-003@0.1.3 §5 US-2 (verbatim AC bullets — pairing flow, midnight-spanning, nap-class, sanity-floor)
- PRD-003@0.1.3 §6 K3 (sanity-floor / ceiling rejection rate KPI)
- TKT-021@0.1.0 migration (the `sleep_records` + `sleep_pairing_state` tables — Executor verifies via the test environment)
- Existing C8 Cron Dispatcher entry points (gateway cron + bridge tools)
- Existing C5 voice transcription wire-up

## 5. Outputs
- [ ] `src/modality/sleep/logger.ts` exporting the state-machine handler.
- [ ] `src/skills/sleep-gc/skill.json` + `src/skills/sleep-gc/index.ts` (hourly GC cron skill).
- [ ] Russian-language reply copy strings centralised in `src/modality/sleep/copy.ru.ts` (PO can edit this file directly without touching logic).
- [ ] `tests/modality/sleep/logger.unit.test.ts` covering all six state-machine paths (≥80% coverage of `src/modality/sleep/logger.ts`).
- [ ] `tests/modality/sleep/logger.dst.test.ts` covering DST transitions in `Europe/Moscow`, `Europe/Belgrade`, `America/Los_Angeles`.
- [ ] `tests/modality/sleep/logger.sanity.test.ts` covering the <30 min and >24 h sanity-floor / ceiling soft-warn flow including the user-confirms-as-is + user-corrects branches.
- [ ] `tests/skills/sleep-gc/skill.test.ts` covering the hourly GC behaviour.

## 6. Acceptance Criteria
- [ ] `npm test -- tests/modality/sleep/` passes (all four sleep test files).
- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean (strict).
- [ ] Manual smoke: "лёг" → bot acknowledges; 7 hours later "встал" → sleep_records row inserted with `is_paired_origin=true`, duration_min ≈ 420, `is_nap=false`.
- [ ] Manual smoke: single morning "спал 7 часов" → sleep_records row inserted with `is_paired_origin=false`, duration_min=420.
- [ ] Manual smoke: "спал 10 минут" → bot replies with sanity-floor soft-warn; user types "да" → record persists; user types "опечатка, 7 часов" → re-parse + persist.
- [ ] Manual smoke: "встал" without prior "лёг" → bot replies with the §5 US-2 AC#5 clarifying message; no record persisted.
- [ ] DST smoke: insert a sleep starting 2026-03-08 02:30 `America/Los_Angeles` (DST spring-forward) and ending 2026-03-08 09:30 → `attribution_date_local` = 2026-03-08, `duration_min` correct (UTC-anchored, so DST-induced wall-clock leap doesn't affect duration).
- [ ] Russian-language replies match the PO-ratified copy file `src/modality/sleep/copy.ru.ts`.

## 7. Constraints
- Do NOT introduce a new tz library if `luxon` (or equivalent) is already in `package.json`. If absent, add `luxon` as the single new dep; add no others.
- Do NOT use `Date.now` for `start_ts_utc` / `end_ts_utc` — use `new Date(message.message.date * 1000)` (Telegram envelope timestamp, in seconds), promoted to UTC ISO 8601 before insert. The state-machine MUST be deterministic against the inbound Telegram timestamp.
- Do NOT modify `sleep_records` or `sleep_pairing_state` schemas; that's TKT-021@0.1.0 territory.
- All SQL parameterised; no string-concatenated queries.
- All hot-path logs via `ctx.log` (openclaw observability); no `console.log` per `docs/knowledge/openclaw.md` Hard Constraints.
- The `is_nap` column is computed at insert (`duration_min ≤ 240`); do NOT treat it as user-controllable.
- `assigned_executor: "executor"` justified: temporal logic with DST + tz semantics + multi-branch state machine is typing-heavy and edge-case-dense (per `docs/prompts/architect.md` §Phase 8 executor-assignment rule "complex async, edge-case type").

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body.
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.
