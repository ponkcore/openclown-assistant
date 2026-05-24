---
name: prd-orchestration
description: Use ONLY when running every Ticket of one PRD end-to-end through opencode in the openclown-assistant repo. Covers `/prd-run`, "run PRD-003", "process this PRD", "ship all tickets for PRD-NNN". Walks the depends_on DAG topologically, dispatches one ticket cycle at a time (per the tkt-cycle skill), parallelises only when safe, escalates to PO on substantive blockers. Do not use for PRD or ArchSpec authoring — those are external roles outside opencode.
---

# Skill: One PRD Orchestration

This skill is the long-running outer loop. The user gave you a PRD id (e.g. `PRD-003@0.1.3`) and expects you to autonomously close every Ticket that traces to that PRD, from first to last, mostly without disturbing them. You walk the `depends_on` DAG, you dispatch one TKT cycle at a time using the `tkt-cycle` skill, you escalate only on substantive blockers.

This is a multi-hour run. Be patient and disciplined.

## Inputs

The user gave you a PRD reference, expected forms:
- `PRD-NNN` — resolve to the latest version on `main`.
- `PRD-NNN@X.Y.Z` — pinned, exact.

Locate the PRD file: `ls docs/prd/PRD-NNN-*.md`. Refuse if zero or multiple matches.

## Step 0 — bootstrap and gate checks

Always re-read in this order:
1. `AGENTS.md` and `CONTRIBUTING.md`.
2. The PRD file in full. Confirm `status: approved`. If `draft` or `in_review`, refuse: PRD has not been ratified by PO yet.
3. The ArchSpec(s) referenced in the PRD's `prd_ref` chain (typically one `ARCH-NNN-*.md`). Confirm `status: approved`. If `draft`, refuse: ArchSpec has not been ratified.
4. Every ADR cited in the ArchSpec's frontmatter `adrs:` list. Confirm `status: accepted` for those that gate code work.
5. The Tickets cited in the ArchSpec's frontmatter `tickets:` list. These are the tickets you will run.

If any upstream gate is open (PRD not approved, ArchSpec not approved, ADR not accepted) — stop, tell the user which gate is open, do not proceed.

## Step 1 — build the DAG

For every ticket file in scope, parse frontmatter:
- `id` (e.g. TKT-021)
- `status` (must be `ready`, `in_progress`, `in_review`, `done`, or `blocked`)
- `depends_on` (list of `TKT-MMM@X.Y.Z` references)
- `blocks` (informational, derive from depends_on)

Build a directed graph: edge from each `depends_on` entry to the ticket. Verify acyclic (the architect should already have verified, but check anyway — cycles are a hard stop, escalate to user).

For each ticket compute:
- `ready_now` = all `depends_on` are `done` AND own status is `ready` or `blocked`.
- `done` = own status is `done`.
- `in_flight` = own status is `in_progress` or `in_review` (orchestration may have crashed mid-run; recovering this is fine).

## Step 2 — initial state report to the user

Before dispatching anything, give the user a one-screen summary:
- PRD id, title, version.
- ArchSpec id, version.
- Ticket count: total, done, in_flight, ready_now, blocked-on-dependency, blocked-by-Q.
- Topological order you will walk.
- Estimated parallelism windows (any pair of tickets with disjoint `depends_on` and `§5 Outputs`).
- Single line: "I will run autonomously. I will pause and ask only when [list of stop conditions below]. Reply 'go' to start."

Wait for the user's "go" (or equivalent affirmative). If the user wants to change the order, defer to them.

## Step 3 — main loop

Maintain a single mutable state:
- `frontier` = set of ticket ids currently `ready_now`.
- `in_flight` = set of ticket ids currently being executed (running through `tkt-cycle`).
- `done` = set of ticket ids closed by merge.
- `blocked` = set of ticket ids that hit a Q-stop or repeated reviewer fail.

While `frontier ∪ in_flight ≠ ∅`:

1. Pick the next ticket from `frontier`. Selection priority: smallest `estimate` first (S < M < L) breaking ties by id ascending.
2. **Parallelism gate**: you may run a second ticket concurrently if and only if:
   - The two tickets' `§5 Outputs` paths are disjoint (no overlapping files).
   - Neither has the other in its transitive `depends_on`.
   - You are confident the model providers can handle two concurrent executors without rate-limiting (default: do NOT parallelise unless explicitly asked).
   Without explicit user permission to parallelise, run sequentially. Sequential is safer and the default.
3. Move the chosen ticket from `frontier` to `in_flight`.
4. Invoke the `tkt-cycle` skill on that ticket. Wait for it to return.
5. On `tkt-cycle` return:
   - **Merged successfully** → move to `done`. Re-scan the DAG: any ticket whose `depends_on` is now fully `done` joins `frontier`.
   - **Blocked (Q-file)** → move to `blocked`. Notify user with the Q-file path. Continue with other frontier tickets if any (the blocker may not block them).
   - **Aborted (3 reviewer fails / CI red repeatedly)** → move to `blocked`. Notify user. Continue with other frontier tickets only if the user said "continue on partial failure" at step 2; otherwise stop the loop entirely and report.
6. If `frontier` is empty but `in_flight` non-empty: wait.
7. If both are empty and `blocked` is non-empty: stop the loop, report final state to user.

## Step 4 — close-out report

When the loop terminates, give the user a final report:
- Tickets `done`: count + list.
- Tickets `blocked`: list with reason (Q-file path, repeated-fail summary, or other).
- New backlog entries created during the run (under `docs/backlog/`).
- New questions filed (under `docs/questions/`).
- Total orchestrator runtime.
- One-line gate-check on PRD goals: which PRD `§2 Goals` (G1, G2, …) appear satisfied by the merged tickets; which remain.

## Stop conditions (escalate to user; do not auto-resolve)

- Cycle in `depends_on` graph.
- Upstream gate open (PRD not `approved`, ArchSpec not `approved`).
- A ticket lists a `§4 Inputs` reference to an artefact that does not exist on `main`.
- A ticket's `§5 Outputs` overlaps with an `in_flight` ticket's outputs (this should not happen if the architect did their job — but check).
- The architect-consult subagent returns confidence `low` (means a real ADR or PRD revision is needed before continuing).
- A reviewer's verdict requires touching a file outside the executor's write-zone (e.g. a finding is "the ArchSpec needs an additional ADR for X").
- More than 3 tickets in `blocked` — mass blocker often signals a systemic issue, not 3 independent bugs.

## What you (orchestrator) MUST NOT do

- Author or edit the PRD, ArchSpec, ADR, or Tickets. Those are external (PO/BP/Architect) artefacts.
- Skip an upstream gate to "save time". Gates exist on purpose.
- Aggregate multiple tickets into one PR. PR-per-TKT is the contract.
- Decide that a Ticket "isn't really needed" and skip it. The Architect decides scope, not you.
- Add a new Ticket. The Architect adds tickets.
- Change `depends_on` ordering of a ticket. That's an Architect decision; if you think it's wrong, escalate.
- Run >1 PRD orchestration concurrently in the same opencode session.
- Auto-resolve a Q-file by inventing an answer. If you're tempted, escalate to PO.

## What you (orchestrator) SHOULD do

- Be transparent. Print state at every transition: "TKT-021 done; frontier now {TKT-022, TKT-026}; running TKT-022 next".
- Backlog Mediums you accepted to merge despite. Don't lose them.
- Update the ticket file's `§10 Execution Log` after every transition.
- Use `gh pr list` and `gh pr view <N>` to verify state when in doubt; opencode-side state can drift if a previous session crashed.
- Be conservative about parallelism. Sequential first; parallelism only on explicit user request.
