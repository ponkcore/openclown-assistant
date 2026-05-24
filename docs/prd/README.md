# Product Requirements Documents (PRDs)

Owner: **Business Planner** (planner via ChatGPT Plus web).

## Rules

- 1 epic = 1 PRD. Do not combine epics.
- Filename pattern: `PRD-NNN-<kebab-slug>.md`.
- Scaffold with: `python scripts/new_artifact.py prd "Title"`.
- Never edit a PRD with status `approved`. Bump the version (`1.0.0 → 1.1.0`) and save the change as a new revision (git diff is your audit trail), or supersede with a new file and set `superseded_by`.
- PRD content is **WHAT and WHY**, never HOW. No tech stack, no schemas, no API endpoints. That is the Architect's job.

## Lifecycle

`draft` → `in_review` (Reviewer opens `docs/reviews/RV-SPEC-*` or PO does manual review) → `approved` → (later) `superseded` if replaced.

PO is the only role that may flip `status: approved`.
