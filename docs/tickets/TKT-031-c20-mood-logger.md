---
id: TKT-031
title: C20 Mood Logger — free-form-text inference + score-range guardrail + inline
  keyboard
version: 0.1.0
status: in_review
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
component: C20
depends_on:
- TKT-021@0.1.0
- TKT-022@0.1.0
blocks:
- TKT-027@0.1.0
estimate: M
created: 2026-05-06
updated: 2026-05-06
---

# TKT-031: C20 Mood Logger — free-form-text inference + score-range guardrail + inline keyboard

## 1. Goal

Land the C20 Mood Logger that infers mood score from free-form Russian text with score-range guardrail, optional comment truncation, and inline-keyboard input per PRD-003@0.1.3 §5 US-4 acceptance.

## 2. In Scope

- `src/modality/mood/logger.ts`: 1–10 numeric / numeric+comment / free-form-text-with-inference → `mood_events` row insert (G4).
- Free-form-text inference via ADR-018@0.1.0 LLM pick (default `accounts/fireworks/models/executor`; fallback `accounts/fireworks/models/reviewer`).
- Score-range guardrail: `mood_score` ∈ [1,10] integer; reject out-of-range → clarifying-reply.
- Optional comment: truncate to ≤200 chars; drop comment if overlength rather than fail-open.
- 5-minute pending-confirmation TTL for inferred scores.
- 1–10 inline keyboard for direct numeric input.
- Russian-language reply copy in `src/modality/mood/copy.ru.ts`.
- The `kbju_modality_event_persisted` telemetry counter with labels `{modality: "mood", source ∈ {text, keyboard, inferred}}`.
- Unit tests at ≥80% coverage.

## 3. NOT In Scope

- C17 Water Logger (TKT-029@0.1.0).
- C19 Workout Logger (TKT-030@0.1.0).
- The `mood_events` table itself (TKT-021@0.1.0).
- Comment redaction (TKT-026@0.1.0 handles mood-comment PII redaction).

## 4. Execution Notes

- Executor: `executor`. Sequential with TKT-029@0.1.0 and TKT-030@0.1.0.
- LLM calls: reuses OmniRoute (ADR-002@0.1.0) with ADR-018@0.1.0 picks. Free-form-text inference is the hardest of the five LLM sites.
- Shared infra: event-row insert pattern mirrors TKT-029@0.1.0 and TKT-030@0.1.0.

## 5. Acceptance Criteria

- [ ] Mood score inferred from free-form Russian text into [1,10] integer.
- [ ] Out-of-range scores rejected → clarifying-reply.
- [ ] Comment >200 chars truncated (dropped) rather than fail-open.
- [ ] Inline keyboard with 1–10 buttons persists correct values.
- [ ] Pending-confirmation TTL expires correctly after 5 minutes.
- [ ] Telemetry counter with `{modality: "mood", source}` labels emitted on every insert.
- [ ] Unit tests ≥80% coverage.

## 10. Execution Log

- 2026-05-25T00:17:58Z opencode-executor: started
- 2026-05-25T00:34:07Z opencode-executor: in_review; tests 50 pass; lint clean; typecheck clean
