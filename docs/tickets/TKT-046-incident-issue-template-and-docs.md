---
id: TKT-046
title: GitHub incident issue template + docs/incidents/{README,TEMPLATE}.md
status: ready
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: docs/incidents / .github/ISSUE_TEMPLATE
depends_on: []
blocks: []
estimate: S
created: 2026-05-25
updated: 2026-05-25
---

# TKT-046: GitHub incident issue template + docs/incidents/{README,TEMPLATE}.md

## 1. Goal
Land the artefact-side of the incident pipeline: a GitHub `incident.md` issue template that requires the structured input, plus `docs/incidents/{README,TEMPLATE}.md` describing the flow.

## 2. In Scope
- New `.github/ISSUE_TEMPLATE/incident.md` requiring at minimum:
  - Title pattern (`INC: <one-line description>`).
  - Required sections: **Version**, **Repro steps**, **`/diag` output** (paste verbatim, code-block-fenced), **Expected vs observed**, **Log bundle attached** (link to a privately-uploaded `INC-*.tgz`).
  - Auto-applied label `incident`.
- New `docs/incidents/README.md` describing the flow per ADR-021@0.1.0 §Issue template + docs:
  - Step 1: User reports bug in Telegram.
  - Step 2: PO asks for `/diag`; user pastes back; PO copies the block.
  - Step 3: PO runs `scripts/diag-bundle.sh <telegram_user_id?>` if a deeper slice is needed.
  - Step 4: PO opens a GitHub issue with the template; attaches the `INC-*.tgz` to a private channel link or as a GitHub issue attachment.
  - Step 5: Architect / code review work proceeds against the redacted artefact.
- New `docs/incidents/TEMPLATE.md` with the per-incident archive shape: a folder under `docs/incidents/INC-<id>/` (when an incident merits a tracked record beyond the GitHub issue), containing `summary.md`, links to PRs / issues, and follow-up notes. This is for *post-resolution archiving*; the live triage path uses the GitHub issue.

## 3. NOT In Scope
- The `/diag` Telegram handler — TKT-044@0.1.0 owns.
- `scripts/diag-bundle.sh` — TKT-045@0.1.0 owns.
- GitHub Actions workflows that trigger on `incident` label — out of scope; future ticket if helpful.
- Editing `AGENTS.md` / `CONTRIBUTING.md` to add an incident-handling section — out of architect zone for this ticket; the docs/incidents/README.md is the source.

## 4. Inputs
- ADR-021@0.1.0 (full pilot incident reporting flow contract)
- TKT-044@0.1.0 / TKT-045@0.1.0 (the surfaces that produce the inputs the issue template asks for)
- Existing `.github/ISSUE_TEMPLATE/` directory — verify whether one already exists and respect its conventions.

## 5. Outputs
- [ ] `.github/ISSUE_TEMPLATE/incident.md` per §2.
- [ ] `docs/incidents/README.md` (no frontmatter — this is a directory README; per `validate_docs.py`'s `case-insensitive readme.md` skip, no validation required).
- [ ] `docs/incidents/TEMPLATE.md` (no frontmatter — TEMPLATE files are skipped by validate_docs).
- [ ] `.gitignore` includes `incidents/` (verify; already in TKT-045@0.1.0 outputs).

## 6. Acceptance Criteria
- [ ] `python scripts/validate_docs.py` passes (the new docs/incidents/ files are README + TEMPLATE so they're correctly skipped).
- [ ] `.github/ISSUE_TEMPLATE/incident.md` has YAML front-matter with `name: incident`, `labels: incident`, and the required-fields body.
- [ ] `docs/incidents/README.md` describes the five-step flow.
- [ ] `docs/incidents/TEMPLATE.md` is the per-incident archive shape.

## 7. Constraints
- Do NOT add an automated incident-creation workflow.
- Do NOT make `docs/incidents/` an artefact directory subject to validate_docs typing — it's reference material like `docs/incidents/README.md` says.
- Architect zone: this ticket modifies `.github/ISSUE_TEMPLATE/` which is OUTSIDE the architect's `docs/architecture/` + `docs/tickets/` write-zone; **THE TICKET IS DELEGATED TO THE EXECUTOR**, who has `.github/` in scope per CONTRIBUTING.md? — actually no, executor scope is `src/`, `tests/`, `packages/`, files explicitly in §5 Outputs. `.github/ISSUE_TEMPLATE/incident.md` is explicitly listed in §5 Outputs of this ticket, so the executor is authorised by the ticket itself per CONTRIBUTING.md §6 Executor guardrails ("Executor may modify ONLY files explicitly listed in the Ticket's §5 Outputs").

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->
