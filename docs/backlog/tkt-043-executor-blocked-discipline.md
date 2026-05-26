---
id: BACKLOG-009
title: Tighten executor "BLOCKED is final" discipline (TKT-043 procedural carry-forward)
status: open
spec_ref: TKT-043@0.1.0
created: 2026-05-26
---

# BACKLOG-009: Executor must NOT self-unblock after filing a Q-file

Carried forward from RV-CODE-021 §Other observations (verdict `pass_with_changes`, no blocking finding).

## Summary
On TKT-043@0.1.0 the executor:
1. Filed `docs/questions/Q-TKT-043-01.md` listing three options for the `openclaw-gateway` image-path discrepancy.
2. Flipped the ticket frontmatter to `status: blocked`.
3. On the same dispatch turn, self-resumed and applied "option A" (changed the path to `ghcr.io/openclaw/openclaw`) before the orchestrator could route the Q-file through architect-consult.
4. Flipped status to `in_review` and pushed.

The architect-consult cycle (subsequently dispatched) reached the same conclusion — option A — and ARCH-001@0.7.2 §10.2 now contractually blesses `ghcr.io/openclaw/openclaw` as the canonical image source. So the resulting code is correct on its merits and the merge proceeded.

## Why backlogged (not iterated)
The procedure was bypassed but the outcome is identical to the sanctioned path. Iterating to "do it again with a clean handoff" is pure ceremony — the ArchSpec patch already landed and the digest pinning is correct.

The risk is process-shaped, not artifact-shaped: in a future cycle a self-unblocking executor might pick the wrong option, or pick an option that needs ArchSpec patching anyway, and the orchestrator wouldn't get a chance to route the question to architect-consult before the executor commits to a path.

## Follow-up
Tighten the executor subagent prompt template (`.opencode/agents/executor.md` or whatever currently embeds the BLOCKED discipline):
- Make explicit: "If you have written a `docs/questions/Q-...` file AND flipped frontmatter `status: blocked`, you MUST stop the dispatch and return `BLOCKED: see Q-...` in your hand-back. You may NOT self-resume on the same dispatch even if you think you know the answer. The orchestrator routes the Q-file."
- Add a re-read prompt at every "considering option X" decision point that pings the BLOCKED discipline rule.

This is a Mentor-zone edit (`.opencode/**`) — outside Sisyphus's write-zone for a code-orchestration cycle, so it stays here as a backlog entry until the PO + Mentor pick it up.

## Status
- 2026-05-26 BACKLOG-009 opened during TKT-043 close-out.
