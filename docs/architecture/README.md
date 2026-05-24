# Architecture Specs (ArchSpecs)

Owner: **Technical Architect** (planner via Codex CLI; backup: Opus 4.6 thinking via Windsurf).

## Rules

- 1 PRD ⇒ 1 ArchSpec. Filename: `ARCH-NNN-<kebab-slug>.md`.
- Scaffold: `python scripts/new_artifact.py arch "Title"`.
- ArchSpec MUST reference its PRD with version pinning (`PRD-NNN@X.Y.Z`).
- Every non-obvious tech-stack decision needs an ADR in `adr/` — see `adr/README.md`.
- **Phase 0: Recon is mandatory.** Before drafting components, the Architect reads `docs/knowledge/openclaw.md` and `docs/knowledge/awesome-skills.md`, audits fork-candidates, and records findings in §0 Recon Report. ArchSpecs without §0 fail Reviewer SPEC mode.
- Never edit an `approved` ArchSpec. Bump version or supersede.

## Lifecycle

`draft` → `in_review` (Reviewer SPEC mode opens `docs/reviews/RV-SPEC-ARCH-NNN-*`) → `approved` → `superseded` (when replaced).

Only the PO sets `status: approved`, and only after a Reviewer verdict of `pass` or `pass_with_changes` plus all blocking findings resolved.
