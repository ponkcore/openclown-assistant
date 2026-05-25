---
id: BACKLOG-005
title: Add wasTruncated label to mood-logger telemetry (TKT-047 follow-up)
status: open
spec_ref: TKT-047@0.1.0
created: 2026-05-25
---

# BACKLOG-005: wasTruncated telemetry label on C20 Mood Logger

Carried forward from RV-CODE-015 finding F-M1 (verdict `pass_with_changes`).

## Summary
TKT-047@0.1.0 implemented the 200→280 truncate-with-friendly-notice path correctly (verbatim ArchSpec copy, `Array.from` code-point truncation, three boundary tests). The `wasTruncated` flag flows through the logger correctly to drive the reply, but it is NOT emitted as a telemetry label on either persist path (`persistDirectScore` and the confirmed-inference path in `logger.ts`). As a result truncation events are indistinguishable from normal persist events in logs and metrics — operationally we cannot answer "how often do users hit the 280 limit?" from observability.

## Why backlogged (not iterated)
The gap is observability, not correctness or a data-integrity contract violation. Schema CHECK still enforces ≤280 server-side, the reply matches verbatim ArchSpec copy, no silent-drop path remains. Iterating to add a label is a one-line patch but would burn another full TKT cycle of executor + reviewer + CI rebase to the same `pass`. Backlog and fold into the next observability touch (TKT-015 already-done covered the bulk; this is below that bar).

## Follow-up
- Add `was_truncated` (boolean) label to the existing mood-persist telemetry counter in `src/modality/mood/logger.ts` on both `persistDirectScore` and the confirmed-inference branch.
- Test: assert label is `true` on the 285-char fixture, `false` on the 280-char and short-comment fixtures.
- Tiny ticket — could be paired with any future C20 polish.

## Status
- 2026-05-25 BACKLOG-005 opened during TKT-047 close-out.
