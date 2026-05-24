# Roadmap

Strategic-direction artifacts authored by the **Business Planner** that span multiple PRDs and capture the long-horizon product vision, the order in which PRDs ship, and the dependencies between them.

This directory complements `docs/prd/`: every individual epic still gets its own PRD under `docs/prd/`, but the *sequencing*, *vision*, and *cross-PRD coherence* live here so the project doesn't drift between cycles.

## Why this directory exists

Through PRD-001 (KBJU coach) and PRD-002 (observability + scale) the project survived without a roadmap because the next PRD was always obvious from the previous one's deferral list. Starting with PRD-003 (modalities expansion) the long-horizon vision spans **four to five additional PRDs** (proactive coaching → calendar + web view → life-manager modules → personality customisation → multi-tenant SaaS). Without an anchored roadmap the order, dependencies, and "north star" become chat-only memory — which violates the docs-as-code invariant (every architectural / strategic decision lives in a versioned markdown file in git).

ROADMAP-NNN files therefore capture: the long-horizon vision, the canonical ordering of the next 3–6 PRDs, the dependency edges between them (e.g. "PRD-X cannot ship before PRD-Y closes"), the open strategic questions that still require PO ratification, and any structural gaps surfaced by audit (mismatches between stated vision and existing PRD scope).

ROADMAP files are **not** tickets, **not** PRDs, **not** ArchSpecs. They do not commit the project to a specific implementation, schema, or technology — those decisions remain Architect-owned. ROADMAP files commit the project to a *direction* and a *sequence*.

## Authoring rules

| Field | Rule |
|---|---|
| **Author role** | Business Planner only. PO must explicitly authorise BP write-zone extension to `docs/roadmap/` for the session that produces a new or revised ROADMAP. The default BP write-zone (`docs/prd/`) does **not** cover this directory. |
| **Author model** | Whatever model the BP role is currently invoked with (historical default: `planner` for openclown-assistant; alternative: `planner` via ChatGPT Plus). |
| **Status flow** | `draft` → `in_review` (Reviewer / RV-SPEC dispatch) → `approved` (PO sets after Reviewer verdict `pass` or `pass_with_changes`). Same flow as PRDs. |
| **Versioning** | Semver-style on a single canonical file (e.g. `ROADMAP-001-v0-2-and-beyond.md` bumps internal `version: 0.1.0 → 0.2.0` rather than creating `ROADMAP-001-v0-3-...md`). The file is the canonical "current" roadmap; superseded versions live in git history, not as separate files. |
| **Validation** | This directory is FREEFORM (no required frontmatter fields enforced by `scripts/validate_docs.py`). The validator skips this directory because ROADMAP files are strategic-direction artifacts, not versioned product artifacts. BP authors are still encouraged to include a YAML frontmatter block with at minimum `id`, `title`, `version`, `status`, `author_model`, `created`, `updated` for human readability. |
| **Architect / Executor write-zone** | Forbidden. Architect / Executor / Reviewer never edit ROADMAP files directly — they consume them and surface concerns via Q-files or Reviewer findings. The BP role owns this directory exclusively. |

## File-naming convention

`ROADMAP-NNN-<slug>.md` where:
- `NNN` is a zero-padded sequence number (`001`, `002`, …) shared across the lifetime of the project. The first one is `ROADMAP-001`.
- `<slug>` is a short kebab-case description of the version-band the roadmap covers (e.g. `v0-2-and-beyond`, `multi-tenant-saas`, `life-manager-arc`).

## When to author / revise a ROADMAP

| Trigger | Action |
|---|---|
| **First-time** "PRD-N suggests M follow-on PRDs" — and the order is non-obvious | PO authorises BP write-zone extension; BP produces ROADMAP-001 covering the version-band that includes the current open PRD plus the next 3–6 follow-ons. |
| **Mid-version-band drift** — e.g. PO-stated long-horizon vision in a chat message contradicts the existing roadmap | PO authorises BP write-zone extension for a revision dispatch; BP bumps the relevant ROADMAP-NNN's `version` and amends the affected sections. |
| **Successor version-band** — e.g. v0.2 closes, v0.3 starts | New `ROADMAP-NNN+1-<new-slug>.md` file authored by BP, supersedes (`superseded_by:`) the prior one. |
| **PO-only nudges** ("давайте поменяем порядок follow-on PRD-X и PRD-Y") | Not enough for a file write — PO logs the request, BP collects ≥2–3 such nudges before authorising a revision dispatch (avoids PR thrash). |

## Read flow for downstream roles

| Role | Reads ROADMAP for |
|---|---|
| **Architect** | Phase 0 recon. Sequencing dependencies between PRD-N and PRD-N+1 inform whether ArchSpec-N must reserve component-namespace for ArchSpec-N+1 (pre-emptive design). |
| **Reviewer (SPEC)** | Cross-PRD coherence check. If a new PRD seems to contradict ROADMAP, that is a finding. |
| **PO** | Strategic check before authorising the next PRD draft. ROADMAP is the document the PO points at when asking BP "is this what we agreed?". |
| **orchestrator** | Cross-cycle dispatch sequencing. The next-cycle TKT/PRD dispatch decision uses ROADMAP as a tiebreaker when multiple PRDs are technically ready. |

## Relationship to `docs/backlog/`

`docs/backlog/` lives at a finer granularity (deferred tickets, observability follow-ups, individual feature IOUs that accumulate during implementation). ROADMAP lives at PRD-level granularity (which epics ship, in what order, why). A backlog item *might* be promoted into a ROADMAP entry if it grows large enough to warrant its own PRD; conversely a ROADMAP entry *might* spawn a backlog item if its first PRD scope deferred a piece of it.

The two directories are complementary, not redundant.
