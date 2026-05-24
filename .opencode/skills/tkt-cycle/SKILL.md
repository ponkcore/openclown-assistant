---
name: tkt-cycle
description: Use ONLY when running one Ticket from `docs/tickets/TKT-NNN-*.md` end-to-end through the openclown-assistant pipeline. Covers TKT, Ticket, ticket cycle, dispatch executor, code review, RV-CODE, merge ticket PR. Triggers on `/tkt-run`, "run TKT-021", "implement this ticket", "close TKT-NNN". Do not use for PRD or ArchSpec authoring — those are external roles outside opencode.
---

# Skill: One Ticket Cycle

This skill encodes the orchestration discipline for one TKT cycle in the `openclown-assistant` repo, from `status: ready` to merged-and-`done`. You are the orchestrator. You do not write code yourself — you delegate.

## The cycle in one diagram

```
        ┌─ ready
        ▼
[1] preflight  ──────►  Q to PO ──► STOP
        │
        ▼
[2] executor  ────────► blocked ──► Q to PO ──► STOP
        │
        ▼
[3] reviewer
        │
        ├─ fail ────────► back to [2] (iter+1)
        ├─ pass_with_changes
        │      │
        │      ├─ orchestrator decides: iterate or backlog
        │      └─ ► [4]
        └─ pass
        │
        ▼
[4] CI gate (typecheck + lint + tests + docs-ci)
        │
        ▼
[5] merge to main
        │
        ▼
[6] close-out: status → done, log entries
```

## Inputs

The user gave you one of:
- A TKT id, e.g. `TKT-021`.
- A path to a ticket file.

If it's an id, locate the file: `ls docs/tickets/TKT-NNN-*.md`. Refuse the cycle and ask if there are zero or multiple matches.

## Step 0 — bootstrap (read every time)

Always re-read these before you start a cycle:
- `AGENTS.md`
- `CONTRIBUTING.md`
- The ticket file in full
- Every `§4 Inputs` reference in the ticket (ArchSpec sections, ADRs, prior tickets)

You are checking three things:
1. Is the ticket really `status: ready` and not something else? Anything other than `ready` is a stop condition unless the user explicitly says "resume".
2. Are all `depends_on` tickets `status: done`? If not, refuse and tell the user which dependencies are still open. Don't try to fix them yourself.
3. Does the ticket's `arch_ref` point to an `approved` ArchSpec? If `status: draft`, that's an upstream gate that's not closed — tell the user, don't proceed.

## Step 1 — preflight

Branch off the latest `main`. Use `git fetch origin && git checkout -b tkt/TKT-NNN-<short-slug> origin/main`. The slug is the ticket file's stem minus the `TKT-NNN-` prefix.

Confirm clean working tree before you delegate (`git status` must be empty on the new branch). If it isn't, stop and tell the user.

## Step 2 — dispatch executor

Delegate to the `executor` subagent with one structured task:

```
You are dispatched on TKT-NNN.

Ticket file: docs/tickets/TKT-NNN-<slug>.md
Branch: tkt/TKT-NNN-<short-slug>
Mandate: implement this ticket end-to-end per its §5 Outputs and §6 Acceptance Criteria, run typecheck + lint + tests, push the branch, open a PR titled "TKT-NNN: <title>".

Bootstrap files you must read before writing code:
- AGENTS.md, CONTRIBUTING.md
- docs/tickets/TKT-NNN-<slug>.md (full)
- All §4 Inputs cited in the ticket

When done: hand back the PR number, branch name, files changed (must equal §5 Outputs + ticket-file diff), test count, 3 weakest assumptions.

If blocked: create docs/questions/Q-TKT-NNN-NN.md, flip status to blocked, hand back "BLOCKED: see Q-..." and stop.
```

Wait for the executor to hand back. Possible hand-back outcomes:
- **Success**: PR opened. Note the PR number. → step 3.
- **Blocked**: Q-file path returned. Stop the cycle, surface the question to the user, do not iterate.
- **CI red**: the executor should have fixed before handing back. If it didn't, dispatch it again with the failing output and "fix CI without changing scope". Cap at 3 iterations; after that, escalate.

## Step 3 — dispatch reviewer

The reviewer must run on a different model family than the executor. The orchestrator is responsible for routing. If you cannot guarantee family separation, stop and tell the user — do not silently route to the same family.

Delegate to the `reviewer` subagent:

```
You are dispatched on PR #<N> for TKT-NNN.

PR branch: tkt/TKT-NNN-<short-slug>
Ticket: docs/tickets/TKT-NNN-<slug>.md
This is iteration <K>.
Prior review (if K>1): docs/reviews/RV-CODE-MMM-*.md

Mandate: produce a verdict per docs/reviews/TEMPLATE-code.md. Verdict ∈ {pass, pass_with_changes, fail}. Commit the RV file on this branch and push.

Hand back: RV id + path, verdict, finding counts (H/M/L), one-line per High, recommendation ∈ {merge, iterate, escalate-to-architect}.
```

Wait for the reviewer's hand-back.

## Step 4 — verdict routing

- **fail**: dispatch the executor again with `subagent: executor`, prompt = "address findings F-H1..F-Hn and F-M1..F-Mm in docs/reviews/RV-CODE-NNN-*.md; do not change anything else; iterate on the same branch". After executor returns, dispatch the reviewer again. Cap at **3 review iterations**. If still failing after 3, stop and surface to the user with a summary of the still-open Highs.
- **pass_with_changes**: judgement call. If all findings are Medium and concern style or local refactor, you may proceed to merge AND log a follow-up backlog entry under `docs/backlog/` with each Medium finding. If a Medium finding concerns correctness or a missed §6 AC, dispatch the executor for one more iteration and then re-review.
- **pass**: → step 5.

## Step 5 — CI gate

Wait for GitHub Actions on the PR. The required check is `docs-ci` (validates docs frontmatter and refs). There is no separate code-CI workflow on this repo currently — typecheck/lint/tests are local-only and the executor was responsible for running them clean before push. You must independently verify by checking that the latest commit on the PR has the executor's reported test counts in its commit message or PR body, and by running locally:

```
git fetch origin pull/<N>/head:pr-<N>
git checkout pr-<N>
npm ci
npm run typecheck && npm run lint && npm test
git checkout - && git branch -D pr-<N>
```

If any of these fail, set verdict = fail and go to step 4. Do not merge a PR you couldn't verify locally.

## Step 6 — merge

Per project agreement: PR-per-TKT, the orchestrator may merge autonomously when **all** of:
- reviewer verdict is `pass` OR `pass_with_changes` with all Mediums backlogged or accepted by the orchestrator's own judgement.
- `docs-ci` check is green on the PR's latest commit.
- Local typecheck + lint + tests all green on the PR head.

Use `gh pr merge <N> --squash --delete-branch`. Do not use `--admin`. Do not force-push. Do not merge to anything other than `main` from a `tkt/...` branch.

After merge:
1. `git checkout main && git pull origin main`.
2. Confirm the merge commit is present.
3. Update the ticket file: flip frontmatter `status: in_review → done`, append `§10 Execution Log`: `- <ISO-date> opencode-orchestrator: merged in commit <SHA>; RV-CODE-NNN verdict=<pass|pass_with_changes>`.
4. Commit the ticket-file edit on `main` with message `TKT-NNN: close cycle`. Push.

## Step 7 — close-out report

Tell the user:
- Ticket id and title.
- Merged commit SHA.
- Iteration count (1 = pass first try; >1 = with iteration explanation).
- Backlog entries created (if any).
- One-line readiness summary: "next ticket in PRD-NNN is TKT-MMM; ready to dispatch?" if a `prd-orchestration` cycle is in progress.

## Stop conditions (do not autonomously proceed)

- Executor returns BLOCKED (Q-file).
- Reviewer returns 3 consecutive `fail`s.
- CI is red after the executor's third iteration.
- Ticket modifies a file outside `§5 Outputs` and the executor does not self-correct.
- Merge would target anything other than `main`.
- A `gh pr merge` would require `--admin` or branch protection bypass.
- The ticket's `arch_ref` points to a non-`approved` ArchSpec.

In every stop condition: produce a clear summary to the user, do not loop, do not partially complete.

## What you (orchestrator) MUST NOT do

- Write code yourself. Always delegate to executor.
- Write the review yourself. Always delegate to reviewer.
- Edit the ticket's Goal / In Scope / NOT In Scope / Outputs / Acceptance Criteria / Constraints. Read-only.
- Edit AGENTS.md, CONTRIBUTING.md, opencode.json, .opencode/**, .github/**, infra/**, scripts/**, docs/prompts/**, docs/architecture/**, docs/prd/**, docs/roadmap/**, docs/knowledge/** — these are PO/architect/BP-only zones.
- Merge to `main` without a green reviewer verdict.
- Run two TKT cycles in parallel from this skill — parallelism is the `prd-orchestration` skill's responsibility (which gates on `depends_on` and §5-Outputs disjointness).
