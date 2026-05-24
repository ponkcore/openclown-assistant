# AGENTS.md

This repository operates on a **three-role pipeline** with strict separation. Two of the roles are external (Business Planner, Technical Architect) — they can run on any LLM in any agent runtime. The third role is **Sisyphus**, the local opencode orchestrator, which lives in this repo and turns approved Tickets into shipped code.

## The pipeline

```
PO ↔ Business Planner            (rare; once per epic)
            │
            ▼ docs/prd/PRD-NNN.md (status: approved)
            │
PO ↔ Technical Architect         (rare; once per PRD)
            │
            ▼ docs/architecture/ARCH-NNN.md (status: approved)
            │ docs/architecture/adr/ADR-NNN.md (status: accepted)
            │ docs/tickets/TKT-NNN.md (status: ready)
            │
PO → Sisyphus orchestrator (opencode)   ← invoked once per PRD by `/prd-run`
            │
            ├── executor subagent     (writes code per one TKT, one PR)
            ├── reviewer subagent     (reviews PR, writes RV-CODE-NNN.md)
            └── architect-consult     (write-enabled in docs/architecture; auto-called on RV-CODE escalate-to-architect)
                                        │
                                        ▼
                                   merged on `main`
```

## Role table

| Role | Where it runs | Write-zone | Invocation |
|---|---|---|---|
| Product Owner (human) | — | Anything (final authority) | — |
| Business Planner | Any LLM in any runtime; PO chooses per session | `docs/prd/`, `docs/roadmap/` (with PO authorisation) | Once per epic |
| Technical Architect | Any LLM in any runtime; PO chooses per session | `docs/architecture/`, `docs/tickets/` | Once per PRD |
| Sisyphus orchestrator | opencode + oh-my-openagent on PO's machine | `docs/tickets/` (frontmatter promotion only), `docs/reviews/` (via reviewer subagent), `docs/questions/`, `docs/backlog/` | `/prd-run PRD-NNN@X.Y.Z` |
| Executor (subagent of Sisyphus) | opencode subagent | `src/`, `tests/`, `packages/`, the assigned ticket's `§5 Outputs` files only, ticket frontmatter `status` and `§10 Execution Log` | Spawned by Sisyphus per TKT |
| Reviewer (subagent of Sisyphus) | opencode subagent (must run on a model from a different family than the executor) | `docs/reviews/` only | Spawned by Sisyphus per PR |
| Architect-consult (subagent of Sisyphus) | opencode subagent | `docs/architecture/**`, `docs/backlog/**`, `docs/questions/**` only — never `src/`, `tests/`, tickets, PRDs, ROADMAP, prompts, knowledge, repo config | Auto-called by Sisyphus when reviewer flags an ArchSpec/ADR-localised contract failure (`recommendation: escalate-to-architect`), or when an executor BLOCKED Q-file cites a contradiction in design artefacts. May patch ArchSpec, bump patch version, write new ADRs, log backlog. Returns `confidence: low` when the gap is too wide; PO escalates externally. |

The **Business Planner** and **Technical Architect** are not bound to any specific model. The PO decides per session (ChatGPT Plus web, Claude Opus thinking, Codex CLI, opencode, etc.). Their prompts live at `docs/prompts/business-planner.md` and `docs/prompts/architect.md` and are runtime-agnostic.

The **Sisyphus orchestrator** is the local opencode session running on the PO's machine. Its top-level agent is provided by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent). Its custom subagents and skills are defined in `.opencode/`. Models for the subagents (executor, reviewer, architect-consult) are configured in `.opencode/agents/<name>.md` or in `~/.config/opencode/oh-my-openagent.json`; the PO swaps them freely. The only hard rule is **the reviewer model family ≠ the executor model family** (separation of perspectives).

## How to start work

If you are an LLM agent looking at this repo, identify your role and load the matching file:

| Role | Prompt / skill file |
|---|---|
| Business Planner | `docs/prompts/business-planner.md` |
| Technical Architect | `docs/prompts/architect.md` |
| Sisyphus / opencode primary agent | `AGENTS.md` (this file) + `CONTRIBUTING.md` + the relevant skill in `.opencode/skills/` (`tkt-cycle` for one ticket, `prd-orchestration` for a whole PRD) |
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

The full discipline of one TKT cycle is in `.opencode/skills/tkt-cycle/SKILL.md`. The full PRD-loop is in `.opencode/skills/prd-orchestration/SKILL.md`.
