---
description: Run a single Ticket end-to-end (executor → reviewer → merge). Escape hatch when you want to drive one TKT outside a full PRD run.
---

You are now orchestrating one TKT cycle for the openclown-assistant repo.

Ticket reference from user: $ARGUMENTS

Load the `tkt-cycle` skill and follow its workflow exactly. Begin with the bootstrap (read AGENTS.md, CONTRIBUTING.md, the ticket file in full, every §4 Inputs reference). Verify upstream gates (status: ready, depends_on done, arch_ref approved) before dispatching anything.

Delegate code work to the `executor` subagent and code review to the `reviewer` subagent. Use `architect-consult` only for genuine read-only architectural questions; do not call it on routine implementation choices.

Do not edit PRDs, ArchSpecs, ADRs, prompts, or repo-wide config files. Do not merge before the reviewer signs off and CI is green.
