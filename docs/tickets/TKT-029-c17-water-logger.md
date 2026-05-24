---
id: TKT-029
title: C17 Water Logger — volume extraction + quick-preset inline keyboard + telemetry
version: 0.1.0
status: in_review
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
component: C17
depends_on:
- TKT-021@0.1.0
- TKT-022@0.1.0
blocks:
- TKT-027@0.1.0
estimate: M
created: 2026-05-06
updated: 2026-05-06
---

# TKT-029: C17 Water Logger — volume extraction + quick-preset inline keyboard + telemetry

## 1. Goal

Land the C17 Water Logger that persists water-event rows with volume extraction (text/voice/inline-keyboard) per PRD-003@0.1.3 §5 US-1 acceptance.

## 2. In Scope

- `src/modality/water/logger.ts`: voice / text / inline-keyboard quick-volume preset → `water_events` row insert (G1).
- Volume extraction from free-form Russian text via ADR-018@0.1.0 LLM pick (default `accounts/fireworks/models/gpt-oss-20b`).
- Quick-volume preset inline keyboard (PO ratifies the three presets — small / medium / large millilitre values).
- Russian-language reply copy in `src/modality/water/copy.ru.ts`.
- The `kbju_modality_event_persisted` telemetry counter with labels `{modality: "water", source ∈ {text, voice, keyboard}}`.
- Unit tests at ≥80% coverage.

## 3. NOT In Scope

- C19 Workout Logger (TKT-030@0.1.0).
- C20 Mood Logger (TKT-031@0.1.0).
- The `water_events` table itself (TKT-021@0.1.0).
- Modality routing — C16 handles classification; this handler fires when C16 returns `WATER`.

## 4. Execution Notes

- Executor: `executor`. Sequential with TKT-030@0.1.0 and TKT-031@0.1.0; same Executor handles all three to avoid OmniRoute key contention on a 2-user pilot.
- LLM calls: reuses OmniRoute (ADR-002@0.1.0) with ADR-018@0.1.0 picks.
- Shared infra: event-row insert pattern mirrors TKT-030@0.1.0 and TKT-031@0.1.0 (row shape, telemetry counter, reply-copy module structure).

## 5. Acceptance Criteria

- [ ] Volume extraction from free-form Russian text (e.g. "выпил 2 стакана", "пол-литра") returns ml value.
- [ ] Quick-preset inline keyboard (3 presets) persists correct ml values.
- [ ] Voice → transcribed text → volume extraction → insert.
- [ ] Telemetry counter with `{modality: "water", source}` labels emitted on every insert.
- [ ] Unit tests ≥80% coverage.
## 10. Execution Log

- 2026-05-25T00:00:00Z opencode-executor: started
- 2026-05-25T02:47:00Z opencode-executor: implementation complete; preset values 250/500/750 ml chosen (PO did not ratify specific values — ARCH-001 §6.2 Q_TO_BUSINESS_6 defers to ticket sign-off); ADR-018@0.1.0 §Decision C17 fallback = minimax-m2p7 (not qwen3-vl-30b-a3b); TKT-029 inherits TKT-028@0.1.0 carve-out — TenantScopedRepository extended with insertWaterEvent for type-safe data access; no private-field reach; raw_text added to LOG_FORBIDDEN_FIELDS and FORBIDDEN_METRIC_LABELS per TKT-026 redaction surface; confidence checked before range to give LOW_CONFIDENCE_REPLY on full-chain LLM failure (volume_ml=0)
- 2026-05-25T02:47:30Z opencode-executor: in_review; tests 26 pass; lint clean; typecheck clean; pre-existing healthCheck.test.ts 1 fail (not touched)
