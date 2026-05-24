---
id: TKT-015
title: Observability Hardening
status: done
arch_ref: ARCH-001@0.3.0
component: C1 Access-Controlled Telegram Entrypoint; C10 Cost, Degrade, and Observability
  Service
depends_on:
- TKT-003@0.1.0
- TKT-004@0.1.0
blocks: []
estimate: M
created: 2026-04-28
updated: 2026-05-01
---

# TKT-015: Observability Hardening

## 1. Goal (one sentence, no "and")
Harden C1/C10 observability edge cases from the post-review closure scope.

## 2. In Scope
- Add deterministic handling for unsupported Telegram message subtypes, starting with stickers, so C1 sends `MSG_GENERIC_RECOVERY` and emits route-unmatched telemetry instead of silently falling through.
- Add emit-boundary redaction in C10 so final log serialization re-applies the allowlist even when producer-side redaction is bypassed.
- Cap routing-only lowercasing for history command detection to the first 256 characters while preserving original inbound text for downstream handlers.
- Extend the local metrics endpoint bind guard to reject IPv6 unspecified-address wildcards.
- Add regression tests for all four hardening items.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No production behavior outside C1/C10 hardening.
- No changes to closed artifacts TKT-003@0.1.0, TKT-004@0.1.0, or.
- No onboarding, meal estimation, history mutation, voice transcription, photo recognition, summary, storage, deployment, or Docker changes.
- No new runtime dependencies.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.3.0 §3.1 C1 Access-Controlled Telegram Entrypoint
- ARCH-001@0.3.0 §8.1 Logs
- ARCH-001@0.3.0 §8.2 Metrics
- ARCH-001@0.3.0 §10.7 Observability Hardening Addendum
- TKT-003@0.1.0 §7 Constraints
- TKT-004@0.1.0 §10 Execution Log
- probes line on `createMetricsServer`
- frontmatter `approved_note`
- F-L2
- pass summary
- orchestrator Review PR #21 comments D-I5 and D-I9 on head `bfd2643`.
- `src/shared/types.ts`
- `src/telegram/types.ts`
- `src/telegram/entrypoint.ts`
- `src/telegram/messages.ts`
- `src/observability/events.ts`
- `src/observability/kpiEvents.ts`
- `src/observability/metricsEndpoint.ts`
- `tests/telegram/entrypoint.test.ts`
- `tests/observability/events.test.ts`
- `tests/observability/metricsEndpoint.test.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `src/shared/types.ts` adding only the minimal optional Telegram sticker shape needed by C1 normalization.
- [ ] `src/telegram/types.ts` preserving original `text`, classifying unsupported Telegram message subtypes, and applying a 256-character routing-only lowercase cap.
- [ ] `src/telegram/entrypoint.ts` sending `MSG_GENERIC_RECOVERY` for unsupported message subtypes and emitting route-unmatched telemetry.
- [ ] `src/observability/events.ts` applying emit-boundary allowlist/forbidden-field redaction immediately before logger serialization.
- [ ] `src/observability/kpiEvents.ts` adding only missing route-unmatched event/metric constants required for this ticket.
- [ ] `src/observability/metricsEndpoint.ts` rejecting IPv6 unspecified-address wildcard hosts before binding.
- [ ] `tests/telegram/entrypoint.test.ts` extending C1 tests for stickers and routing-only lowercase cap behavior.
- [ ] `tests/observability/events.test.ts` extending C10 tests for emit-boundary redaction bypass protection.
- [ ] `tests/observability/metricsEndpoint.test.ts` extending metrics server tests for IPv6 wildcard rejection.

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/telegram/entrypoint.test.ts tests/observability/events.test.ts tests/observability/metricsEndpoint.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] A sticker Telegram `Message` from an allowlisted user produces exactly one `sendMessage` call containing `MSG_GENERIC_RECOVERY`.
- [ ] The sticker test proves no domain handler is invoked for the unsupported message.
- [ ] The sticker test proves C10 emits route-unmatched telemetry with `outcome: "unsupported_message_type"`, `extra.message_subtype: "sticker"`, and the Prometheus metric `PROMETHEUS_METRIC_NAMES.kbju_route_unmatched_count` (the route-unmatched constants `KPI_EVENT_NAMES.route_unmatched` and `PROMETHEUS_METRIC_NAMES.kbju_route_unmatched_count` MUST exist in `src/observability/kpiEvents.ts`; add them if absent, without renaming existing constants).
- [ ] An emit-boundary test passes a prebuilt event object directly to `emitLog` with non-allowlisted keys such as `meal_text: "пирог"` and `username: "pilot"`; the logger metadata does not contain those keys or values.
- [ ] The emit-boundary test proves allowed core fields (`event_name`, `request_id`, `user_id`, `outcome`, `schema_version`) survive final serialization.
- [ ] A routing test with a 4096-character Cyrillic string that does not start with `/история` or `/history` proves no `String.prototype.toLowerCase` call receives a receiver length greater than 256 characters.
- [ ] A routing test proves the original 4096-character `text` value is still passed unchanged to the text-meal handler.
- [ ] Existing `/history`, `/history@OpenClownBot`, `/история`, and `/история@OpenClownBot` routing tests still pass case-insensitively.
- [ ] `createMetricsServer("::", 9464)` throws the same error constructor used for `0.0.0.0` rejection.
- [ ] `createMetricsServer("[::]", 9464)` throws the same error constructor used for `0.0.0.0` rejection.
- [ ] Existing acceptance tests still prove `createMetricsServer("127.0.0.1", 9464)` and Docker-internal hostnames are accepted.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies.
- Do NOT modify files outside §5 Outputs.
- Do NOT delete or rename existing event names in `src/observability/kpiEvents.ts`; add new constants only if no existing constant fits the route-unmatched telemetry.
- Do NOT change the Russian user-facing copy except reusing existing `MSG_GENERIC_RECOVERY`.
- Do NOT change the meal, onboarding, voice, photo, history, summary, storage, or deployment flows.
- Do NOT log raw meal text, usernames, Telegram bot tokens, provider keys, raw prompts, raw transcripts, raw media markers, raw provider responses, or unbounded callback payloads.
- Preserve the original full inbound `text` for downstream handlers; the 256-character cap applies only to routing-decision normalization.
- Implement IPv6 wildcard protection with simple host-string normalization only; if Node socket inspection is required, stop and file a Q-TKT.
- Keep the redaction allowlist static for v0.1; if the allowlist must vary by tenant or environment, stop and file a Q-TKT because that would require a new ADR.
- GLM assignment is appropriate because the work is deterministic TypeScript hardening with direct regression tests.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
