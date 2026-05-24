---
id: TKT-008
title: Photo Recognition Adapter
status: done
arch_ref: ARCH-001@0.2.0
component: C7 Photo Recognition Provider
depends_on:
- TKT-001@0.1.0
- TKT-003@0.1.0
- TKT-006@0.1.0
blocks:
- TKT-009@0.1.0
- TKT-014@0.1.0
estimate: M
created: 2026-04-26
updated: 2026-05-01
---

# TKT-008: Photo Recognition Adapter

## 1. Goal (one sentence, no "and")
Implement the OmniRoute vision adapter for meal photo candidates.

## 2. In Scope
- Add C7 adapter for Fireworks Qwen3 VL 30B A3B Instruct through OmniRoute.
- Downscale or pass through a temp image handle using a testable image-preparation interface.
- Return candidate food items, portion text, per-item confidence, and draft confidence.
- Apply low-confidence flag when `confidence_0_1 < 0.70` and expose the Russian label `низкая уверенность`.
- Delete raw photo bytes through the provided temp-file handle on success or terminal failure.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No Telegram photo route selection; that belongs to TKT-004@0.1.0.
- No draft confirmation persistence; that belongs to TKT-009@0.1.0.
- No barcode or packaged-goods scanning.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.2.0 §3.7 C7 Photo Recognition Provider
- ARCH-001@0.2.0 §4.4 Photo meal logging
- ARCH-001@0.2.0 §6 External Interfaces
- ARCH-001@0.2.0 §9.4 LLM Prompt-Injection Mitigations
- ARCH-001@0.2.0 §9.5 PII Handling and Deletion
- ADR-002@0.1.0
- ADR-004@0.1.0
- ADR-009@0.1.0
- docs/knowledge/llm-routing.md
- `src/shared/types.ts`
- `src/llm/omniRouteClient.ts`
- `src/kbju/types.ts`
- `src/kbju/validation.ts`
- `src/observability/costGuard.ts`
- `src/observability/events.ts`

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `src/photo/types.ts` exporting C7 request/result types
- [ ] `src/photo/photoRecognitionAdapter.ts` exporting the vision adapter
- [ ] `src/photo/photoConfidence.ts` exporting threshold and label helpers
- [ ] `tests/photo/photoRecognitionAdapter.test.ts`
- [ ] `tests/photo/photoConfidence.test.ts`

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/photo/photoRecognitionAdapter.test.ts tests/photo/photoConfidence.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] Tests prove confidence `0.69` shows `низкая уверенность` and confidence `0.70` does not.
- [ ] Tests prove malformed vision output is discarded and never marked confirmable.
- [ ] Tests prove raw photo deletion is called on success and terminal failure.
- [ ] Tests prove image-visible text is treated as untrusted data in the prompt.
- [ ] Tests prove no photo path returns an auto-save/confirmed result.

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies unless a Q-TKT approves an image-processing dependency.
- Do NOT persist raw photo bytes or temp file paths after deletion.
- Do NOT implement barcode scanning.
- Do NOT retry suspicious or malformed vision output.
- GLM assignment is appropriate because ADR-004@0.1.0 gives a narrow adapter contract.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
