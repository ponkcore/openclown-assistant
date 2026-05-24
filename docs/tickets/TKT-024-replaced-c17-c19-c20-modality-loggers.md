---
id: TKT-024
title: C17 Water Logger + C19 Workout Logger + C20 Mood Logger — REPLACED (split into
  3 tickets)
version: 0.1.0
status: done
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
component: C17+C19+C20
depends_on:
- TKT-021@0.1.0
- TKT-022@0.1.0
blocks: []
estimate: null
created: 2026-05-06
updated: 2026-05-06
replaced_by:
- TKT-029@0.1.0
- TKT-030@0.1.0
- TKT-031@0.1.0
---

# TKT-024: REPLACED — split into three atomic tickets

This ticket bundled C17 Water Logger, C19 Workout Logger, and C20 Mood Logger into a single atom. Per (medium), the bundle violated the "one atomic Goal per Ticket" discipline. The Architect split it into three separate tickets in the ARCH-001@0.6.1 amendment cycle:

- TKT-029@0.1.0 — C17 Water Logger
- TKT-030@0.1.0 — C19 Workout Logger
- TKT-031@0.1.0 — C20 Mood Logger

Rationale: C19 (workout extraction with vision surface) has different LLM surface, test surface, and failure modes from C17 (simple water counter) and C20 (mood free-form text). Bundling them would mean a C19 vision-surface bug blocks C17 and C20 from shipping.

This file is retained as a stub for frontmatter cross-reference resolution by `scripts/validate_docs.py`. All DAG references have been updated to point to the three replacement tickets instead.

## §10 Execution Log

- 2026-05-06: Created as part of ARCH-001@0.6.0 bundle.
- 2026-05-06: Split into three tickets at 0.1.0 per ARCH-001@0.6.1 amendment cycle.