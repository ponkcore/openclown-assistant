# AGENTS.md

This repository operates on a **four-role pipeline** with strict separation. Two of the roles are external (Business Planner, Technical Architect) — they can run on any LLM in any agent runtime. Two roles are local opencode primary agents: **Mentor**, the PO's project navigator and process gardener; and **Sisyphus**, the orchestrator that turns approved Tickets into shipped code.

## The pipeline

```
PO ↔ Mentor (opencode primary)              ← always-on; first stop for "where do we go next"
        │                                       triages PO intent, prepares external sessions,
        │                                       diagnoses orchestrator failures, fixes config.
        │
        ├── routes to ──► Business Planner    (external session, on PO command)
        │                       │
        │                       ▼ docs/prd/PRD-NNN.md (status: approved)
        │
        ├── routes to ──► Technical Architect (external session, on PO command)
        │                       │
        │                       ▼ docs/architecture/ARCH-NNN.md (status: approved)
        │                         docs/architecture/adr/ADR-NNN.md (status: accepted)
        │                         docs/tickets/TKT-NNN.md (status: ready)
        │
        └── hands off ──► Sisyphus orchestrator (opencode primary, omo)
                                │                  invoked once per PRD by `/prd-run`
                                │
                                ├── executor subagent          (writes code per one TKT, one PR)
                                ├── reviewer subagent          (reviews PR, writes RV-CODE-NNN.md)
                                └── architect-consult subagent (in-flight ArchSpec/ADR fixes)
                                            │
                                            ▼
                                       merged on `main`
```

## Role table

| Role | Where it runs | Write-zone | Invocation |
|---|---|---|---|
| Product Owner (human) | — | Anything (final authority) | — |
| **Mentor** | opencode primary agent on PO's machine | `AGENTS.md`, `CONTRIBUTING.md`, `README.md`, `opencode.json`, `.opencode/**`, `docs/backlog/`, `docs/questions/`, `docs/drafts/`, `.gitignore` | On demand from PO. First contact for "where do we go next", "what's the project state", "Sisyphus упал, разберись", "помоги сформулировать запрос BP / Архитектору", "почему что-то не работает с конфигом". |
| Business Planner | Any LLM in any runtime; PO chooses per session | `docs/prd/`, `docs/roadmap/` (with PO authorisation) | Once per epic. Mentor prepares the bootstrap-prompt; PO opens the external session. |
| Technical Architect | Any LLM in any runtime; PO chooses per session | `docs/architecture/`, `docs/tickets/` | Once per PRD. Mentor prepares the bootstrap-prompt; PO opens the external session. |
| Sisyphus orchestrator | opencode + oh-my-openagent on PO's machine | `docs/tickets/` (frontmatter promotion only), `docs/reviews/` (via reviewer subagent), `docs/questions/`, `docs/backlog/` | `/prd-run PRD-NNN@X.Y.Z`, `/tkt-run TKT-NNN` |
| Executor (subagent of Sisyphus) | opencode subagent | `src/`, `tests/`, `packages/`, the assigned ticket's `§5 Outputs` files only, ticket frontmatter `status` and `§10 Execution Log` | Spawned by Sisyphus per TKT |
| Reviewer (subagent of Sisyphus) | opencode subagent (must run on a model from a different family than the executor) | `docs/reviews/` only | Spawned by Sisyphus per PR |
| Architect-consult (subagent of Sisyphus) | opencode subagent | `docs/architecture/**` (ArchSpec patch fixes + new ADRs only — no minor/major bumps, no component removal, no ADR retirement), `docs/backlog/**`, `docs/questions/**` | Auto-called by Sisyphus when reviewer flags an ArchSpec/ADR-localised contract failure (`recommendation: escalate-to-architect`), or when an executor BLOCKED Q-file cites a contradiction in design artefacts |

The **Business Planner** and **Technical Architect** are not bound to any specific model. The PO decides per session (ChatGPT Plus web, Claude Opus thinking, Codex CLI, opencode, etc.). Their prompts live at `docs/prompts/business-planner.md` and `docs/prompts/architect.md` and are runtime-agnostic.

The **Mentor** and **Sisyphus orchestrator** are both local opencode primary agents. The PO switches between them in the same opencode session via `Tab` (or the configured `switch_agent` keybind). Mentor is the default first-contact; Sisyphus is invoked when there is concrete ticket work to walk through. Sisyphus's top-level agent is provided by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent); Mentor is a project-defined primary in `.opencode/agents/mentor.md`. Custom subagents (executor, reviewer, architect-consult) and skills are defined in `.opencode/`. Models for everything are configured in `.opencode/agents/<name>.md` or in `~/.config/opencode/oh-my-openagent.json`; the PO swaps them freely. The only hard rule is **the reviewer model family ≠ the executor model family** (separation of perspectives).

## How to start work

If you are an LLM agent looking at this repo, identify your role and load the matching file:

| Role | Prompt / skill file |
|---|---|
| Mentor (opencode primary) | `AGENTS.md` (this file) + `CONTRIBUTING.md` + `.opencode/agents/mentor.md` |
| Business Planner | `docs/prompts/business-planner.md` |
| Technical Architect | `docs/prompts/architect.md` |
| Sisyphus / opencode primary orchestrator | `AGENTS.md` (this file) + `CONTRIBUTING.md` + the relevant skill in `.opencode/skills/` (`tkt-cycle` for one ticket, `prd-orchestration` for a whole PRD) |
| Executor subagent | `.opencode/agents/executor.md` |
| Reviewer subagent | `.opencode/agents/reviewer.md` |
| Architect-consult subagent | `.opencode/agents/architect-consult.md` |

Follow the role file **exactly**. Do not cross role boundaries. See `CONTRIBUTING.md` for the full process rules.

Before making any change:

1. Read `README.md` and `CONTRIBUTING.md`.
2. Confirm your write-zone in `CONTRIBUTING.md` § Roles. Touching files outside it will be rejected by the reviewer (or, for code, blocked by `opencode.json` permission rules).
3. Read the role-specific reference knowledge listed in your prompt or skill file. The Architect MUST read `docs/knowledge/openclaw.md` and `docs/knowledge/awesome-skills.md` before designing — this is Phase 0 Recon.
4. Run `python scripts/validate_docs.py` before pushing. CI runs the same check on every PR.

## Slash commands inside opencode

- `/prd-run PRD-NNN@X.Y.Z` — start orchestrating an entire PRD. Sisyphus walks the `depends_on` DAG, dispatches executor + reviewer per ticket, merges PRs on green.
- `/tkt-run TKT-NNN` — escape hatch for a single ticket cycle.

The full discipline of one TKT cycle is in `.opencode/skills/tkt-cycle/SKILL.md`. The full PRD-loop is in `.opencode/skills/prd-orchestration/SKILL.md`. The Mentor's working procedures are in `.opencode/agents/mentor.md`.
