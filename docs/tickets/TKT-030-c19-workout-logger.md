---
id: TKT-030
title: C19 Workout Logger — closed-enum extraction + forced-output JSON schema + photo
  support
version: 0.1.0
status: done
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
component: C19
depends_on:
- TKT-021@0.1.0
- TKT-022@0.1.0
blocks:
- TKT-027@0.1.0
estimate: L
created: 2026-05-06
updated: 2026-05-06
---

# TKT-030: C19 Workout Logger — closed-enum extraction + forced-output JSON schema + photo support

## 1. Goal

Land the C19 Workout Logger that extracts canonical workout events from text / voice / photo with the ADR-016@0.1.0 closed-enum forced-output prompt and persists to `workout_events`.

## 2. In Scope

- `src/modality/workout/logger.ts`: text / voice / photo → `workout_events` row insert with the ADR-016@0.1.0 closed-enum forced-output prompt (G3).
- Closed-enum extraction via ADR-018@0.1.0 LLM pick (default `accounts/fireworks/models/qwen3-vl-30b-a3b`; fallback `accounts/fireworks/models/executor`).
- Deterministic post-validator on extracted fields: `workout_type` ∈ {running, walking, cycling, strength_training, yoga, swimming, hiking, other}, `duration` ≥ 0, `distance` ≥ 0, `sets` ≥ 0, `repetitions` ≥ 0.
- Photo support: vision-model extraction of workout type + visual context (ADR-016@0.1.0 §Decision vision surface).
- Russian-language reply copy in `src/modality/workout/copy.ru.ts`.
- The `kbju_modality_event_persisted` telemetry counter with labels `{modality: "workout", source ∈ {text, voice, photo}}`.
- Unit tests at ≥80% coverage.

## 3. NOT In Scope

- C17 Water Logger (TKT-029@0.1.0).
- C20 Mood Logger (TKT-031@0.1.0).
- The `workout_events` table itself (TKT-021@0.1.0).
- Workout taxonomy ADR-016@0.1.0 closed-enum definition (already decided; this ticket implements).

## 4. Execution Notes

- Executor: `executor`. Sequential with TKT-029@0.1.0 and TKT-031@0.1.0.
- LLM calls: reuses OmniRoute (ADR-002@0.1.0) with ADR-018@0.1.0 picks. Photo extraction uses vision-capable model.
- Shared infra: event-row insert pattern mirrors TKT-029@0.1.0; closed-enum type rendering map is shared via `src/summary/copy.ru.ts` (TKT-027@0.1.0).

## 5. Acceptance Criteria

- [ ] Workout type extracted from free-form Russian text into closed enum.
- [ ] Forced-output JSON schema enforced; invalid output rejected.
- [ ] Vision-model extraction from photo yields workout type + optional fields.
- [ ] Deterministic validator rejects out-of-enum types and negative numeric fields.
- [ ] Telemetry counter with `{modality: "workout", source}` labels emitted on every insert.
- [ ] Unit tests ≥80% coverage.
## 10. Execution Log

- 2026-05-25T00:00:00Z opencode-executor: started
- 2026-05-25T13:20:00Z opencode-executor: in_review; tests 63 pass; lint clean; typecheck clean
- 2026-05-25T11:10:00Z opencode-orchestrator: F-H1 reclassified as reviewer false-positive (validator + parser already use `<= 0` at PR head; 4 explicit zero-rejection tests pass; verified locally 65/65 modality/workout tests). RV-CODE-009 verdict overridden iter1→pass_with_changes (recommendation merge); F-L1 + F-L2 informational only.
- 2026-05-25T11:18:00Z opencode-orchestrator: merged in commit 4de97f9 (PR #13)
