---
id: BACKLOG-003
title: TKT-038 — status-flip and code-change in same commit (process nit)
status: open
spec_ref: TKT-038@0.1.0
created: 2026-05-25
---

# BACKLOG-003: TKT-038 — status-flip / code-change commit split

Carried forward from RV-CODE-011 finding F-M1 (verdict `pass_with_changes`).

## Summary
On TKT-038@0.1.0 the executor flipped the ticket-file frontmatter `status: ready → in_review` in the same commit as the code changes, while TKT §8 Definition of Done says the status flip must live in a separate commit.

## Why backlogged (not iterated)
The deviation is procedural, not a correctness bug. The PR otherwise faithfully implements ADR-019@0.1.0 and passes all §6 Acceptance Criteria. Iterating to split commits would force a force-push on a branch already approved for merge with no functional gain.

## Follow-up
Tighten the executor subagent prompt so future TKT cycles always commit the §10/status flip separately from the code change. No change is required to the merged TKT-038@0.1.0 history.
