# Reviews (RV)

Owner: **reviewer** (reviewer via opencode + OmniRoute) + **orchestrator Review** (auto-bot on every PR).

## Rules

- One review file per artifact under review.
- Two modes: SPEC (review ArchSpec + ADRs + Tickets before code) and CODE (review code PR after Executor opens it).
- Filename:
  - SPEC: `RV-SPEC-ARCH-NNN-<short-slug>.md` (use `python scripts/new_artifact.py review-spec "ARCH-NNN-..."`).
  - CODE: `RV-CODE-NNN-<short-slug>.md` (use `python scripts/new_artifact.py review-code "PR-NN-..."`).
- reviewer MUST be from a different model family than the Architect / Executor it reviews. A GPT-written ArchSpec is reviewed by Kimi, not by GPT. A GLM-written PR is reviewed by Kimi, not by GLM.
- Findings are severity-graded:
  - **high** — blocks merge.
  - **medium** — should be fixed before next stage; can be a patch bump.
  - **low** — nit / cosmetic.
- Verdict: `pass` (rare) | `pass_with_changes` | `fail`. Justification mandatory.
- Reviewer NEVER fixes the artifact. NEVER negotiates. NEVER merges.

## Lifecycle

`in_review` → `approved` (verdict pass / pass_with_changes) | `changes_requested` (verdict fail).
