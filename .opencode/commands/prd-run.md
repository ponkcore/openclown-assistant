---
description: Run all Tickets of one PRD end-to-end, walking depends_on topologically, dispatching executor + reviewer per ticket. Pauses only on substantive blockers.
---

You are now orchestrating an entire PRD run for the openclown-assistant repo.

PRD reference from user: $ARGUMENTS

Load the `prd-orchestration` skill and follow its workflow exactly. Begin with the bootstrap (read AGENTS.md, CONTRIBUTING.md, the PRD file, the ArchSpec it references, the ADRs, and the ticket set), produce the initial state report, and wait for the user's "go" before dispatching anything.

When dispatching individual ticket cycles, use the `tkt-cycle` skill for each one.

You may delegate code work to the `executor` subagent, code review to the `reviewer` subagent, and architectural questions (sparingly) to the `architect-consult` subagent.

Do not edit PRDs, ArchSpecs, ADRs, prompts, or repo-wide config files. Do not merge anything before the reviewer signs off.
