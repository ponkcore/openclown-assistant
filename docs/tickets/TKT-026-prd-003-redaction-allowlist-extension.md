---
id: TKT-026
title: PRD-003 redaction allowlist extension + emit-boundary enforcement
version: 0.1.0
status: ready
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
component: C10
depends_on:
- TKT-021@0.1.0
blocks:
- TKT-027@0.1.0
estimate: M
created: 2026-05-06
updated: 2026-05-06
---

# TKT-026: PRD-003@0.1.3 redaction allowlist extension + emit-boundary enforcement

## 1. Goal
Extend the ARCH-001@0.5.0 §8.1 redaction allowlist + §10.7 emit-boundary policy to cover mood-comment / workout free-form description / sleep text-input transcript, and reject unredacted PRD-003@0.1.3 telemetry events at emit.

## 2. In Scope
- Update `src/observability/redactionAllowlist.ts` (or equivalent module already implementing ARCH-001@0.5.0 §8.1) to extend the forbidden-field set with: `mood_comment_text`, `workout_text`, `workout_raw_description`, `sleep_text_input`, `sleep_voice_transcript`.
- Update the emit-boundary check in `src/observability/emit.ts` (or equivalent) to reject any structured-log / metric-label payload carrying any of the new forbidden fields, mirroring the existing rejection path for `meal_text` / `username` / `raw_audio` etc.
- Sample-audit telemetry helper that reads N≥100 PRD-003@0.1.3 telemetry events from the rolling-7-day window and asserts 100% redaction compliance (PRD-003@0.1.3 §6 K8).
- Mood-comment-specific audit helper for PRD-003@0.1.3 §6 K4 ("100% redaction on N≥100 mood events with comments").
- Migration-style test: insert PRD-003@0.1.3 telemetry events with deliberately-unredacted payloads in test fixtures; assert the emit-boundary rejects all of them.

## 3. NOT In Scope
- The PRD-003@0.1.3 modality data model itself (TKT-021@0.1.0 owns table schemas; this ticket only reads them via the rolling-window helper).
- The ARCH-001@0.5.0 redaction allowlist *foundation* (already shipped under TKT-015@0.1.0 hardening; this ticket only extends the field set, not the mechanism).
- The C9 / C22 summary composer's mood-comment rendering (TKT-027@0.1.0).
- Right-to-delete cascade for mood-comment text (already covered by the TKT-021@0.1.0 cascade, which deletes the parent row and its `mood_comment_text` column).

## 4. Inputs
- ARCH-001@0.6.0 §10.7 + §8.1 (emit-boundary + redaction allowlist patterns; the §10.7 hardening of TKT-015@0.1.0 ratified at ARCH-001@0.5.0)
- ARCH-001@0.6.0 §0.6 + §3.10 (C10 spec)
- PRD-003@0.1.3 §5 US-7 (privacy-preserving modality telemetry — verbatim AC)
- PRD-003@0.1.3 §6 K4, K8 (sample-audit KPIs)
- PRD-003@0.1.3 §7 Compliance and PII handling clause (verbatim — extends the redaction allowlist set)
- ADR-009@0.1.0 (observability + redaction)
- Existing `src/observability/redactionAllowlist.ts` and `src/observability/emit.ts` (or equivalents — file names verified at ticket pickup)
- Existing TKT-015@0.1.0 hardening tests (the precedent pattern this ticket extends)

## 5. Outputs
- [ ] `src/observability/redactionAllowlist.ts` extended with the new forbidden-field set.
- [ ] `src/observability/emit.ts` reject path extended for the new fields (no new mechanism — same shape as TKT-015@0.1.0).
- [ ] `src/observability/prd003AuditHelper.ts` exporting the rolling-7-day sample-audit helper.
- [ ] `tests/observability/redaction.prd003.test.ts` covering all five new forbidden fields (each must be rejected at emit; each must NOT appear in any sample-audit output).
- [ ] `tests/observability/redaction.prd003.audit.test.ts` covering the K4 + K8 sample-audit helpers (assertion: 100% redaction on a synthetic N=100 dataset).

## 6. Acceptance Criteria
- [ ] `npm test -- tests/observability/redaction.prd003*.test.ts` passes.
- [ ] Existing `tests/observability/redaction*.test.ts` all still pass (no regression on TKT-015@0.1.0 hardening).
- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean (strict).
- [ ] Manual smoke: emit a structured log with `{event: 'workout_event_persisted', workout_text: 'жал 80×5×5'}` → emit-boundary rejects with the same error shape as `meal_text` does today; no log line written.
- [ ] Manual smoke: K4 sample-audit helper run against a fixture with N=100 mood-comment events all marked as `null` for `mood_comment_text` (correctly redacted) → returns 100% compliance.

## 7. Constraints
- Do NOT remove any existing forbidden field. Additive only.
- Do NOT change the emit-boundary mechanism (regex / schema-validator / whichever is in place). Reuse the existing pattern.
- The new forbidden fields apply to ALL emit channels: structured logs, metric labels, alert payloads.
- Allowed-in-emit fields for PRD-003@0.1.3 events: `event_name`, `user_id_hash` (already an existing allowed field per ARCH-001@0.5.0 §8.1), `modality` (∈ {water, sleep, workout, mood}), `event_outcome` (∈ {persisted, sanity_warn_pending, sanity_warn_corrected, ambiguous_clarified}), numeric fields explicitly ratified by ARCH-001@0.6.0 §8.1 (volume_ml, duration_min, distance_km, score, etc.).
- All tests parameterised; no hard-coded user IDs in test fixtures.
- `assigned_executor: "executor"` justified: redaction is security-critical (per `docs/prompts/architect.md` §Phase 8 executor-assignment rule "security-critical / algorithmically dense") — a leak here directly breaches PRD-003@0.1.3 §5 US-7.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body.
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.
