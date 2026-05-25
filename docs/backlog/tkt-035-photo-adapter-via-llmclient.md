---
id: BACKLOG-007
title: Photo recognition adapter bypasses central llmClient (TKT-035 carry-forward)
status: open
spec_ref: TKT-035@0.1.0
created: 2026-05-25
---

# BACKLOG-007: Photo recognition adapter raw-fetch vs. centralised `llmClient.vision()`

Carried forward from RV-CODE-019 finding F-M1 (verdict `pass_with_changes`, deferred — pre-existing pattern not introduced by TKT-035@0.1.0).

## Summary
TKT-035@0.1.0 migrated the photo extractor manifest from inline model picks to the `kbju.photo_recognition` call-type alias and rewired `src/photo/photoRecognitionAdapter.ts` to read the resolved provider via `registry.resolve(...)`. The adapter still issues the actual HTTPS POST via raw `fetch()` and a bespoke retry loop instead of going through the centralised `llmClient.vision()` helper that landed in TKT-033@0.1.0.

That bypass means:
- C13 Stall Watchdog wrapping does not surround the photo call-site (Stall Watchdog wraps `llmClient.chatCompletion` and `llmClient.vision`).
- redactPii filtering of payload metadata is hand-rolled in the adapter rather than centralised.
- Future cost-degrade / kill-switch behaviour added to `llmClient.vision()` (per ARCH-001@0.7.1 §C10) won't automatically apply to the photo path.

## Why backlogged (not iterated)
Pre-existing pattern. RV-CODE-019 confirmed the raw-fetch behaviour is not a regression introduced by TKT-035@0.1.0 — the adapter shipped this way in TKT-008@0.1.0 and TKT-035@0.1.0 only swapped the model lookup. Refactoring the photo retry loop to live behind `vision()` is a non-trivial layering change that risks breaking the photo round-trip latency budget; it deserves its own ticket.

## Follow-up
- New ticket scope: refactor `src/photo/photoRecognitionAdapter.ts` to call `llmClient.vision()` directly. Preserve the existing retry semantics by either (a) adding configurable retry to `llmClient.vision()` or (b) keeping the adapter-side retry but having each attempt go through `vision()` instead of raw `fetch()`.
- AC: photo path is wrapped by C13 Stall Watchdog identically to the chat path; tests cover the same kill-switch / degrade matrix the chat client now covers.
- Out of scope for that follow-up: adding new functionality to the photo path; changing `kbju.photo_recognition` alias; touching `config/llm.example.json` defaults.

## Status
- 2026-05-25 BACKLOG-007 opened during TKT-035 close-out.
