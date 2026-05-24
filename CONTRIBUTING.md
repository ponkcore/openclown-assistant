# Contributing — Process Rules

This file defines **how the three roles collaborate** in this repo. These are not suggestions. CI enforces the machine-checkable parts; the orchestrator's reviewer subagent enforces the rest. The Product Owner is the final authority.

## Roles and write zones

| Role | Where it runs | MAY write | MUST NOT write |
|---|---|---|---|
| Product Owner (human) | — | Anything (final authority) | — |
| Business Planner | Any LLM in any runtime; PO chooses per session | `docs/prd/`, `docs/roadmap/` (with explicit PO authorisation per session) | `docs/architecture/`, `docs/tickets/`, `src/`, anything else |
| Technical Architect | Any LLM in any runtime; PO chooses per session | `docs/architecture/`, `docs/tickets/` | `docs/prd/`, `docs/roadmap/`, `src/`, `tests/`, `infra/`, repo root |
| Sisyphus orchestrator | opencode + oh-my-openagent (PO's machine) | Ticket frontmatter promotion only (`status`, `§10 Execution Log`), backlog entries, question files. Delegates code → executor subagent and reviews → reviewer subagent. | PRD bodies, ArchSpec bodies, ADR bodies, prompts, knowledge files, AGENTS.md, CONTRIBUTING.md, opencode.json, `.opencode/**`, `.github/**`, `infra/**`, `scripts/**` |
| Executor subagent | opencode subagent | `src/`, `tests/`, `packages/`, files explicitly listed in the assigned ticket's `§5 Outputs`, ticket frontmatter `status` (transitions only) and `§10 Execution Log` (append-only) | All other ticket fields, all other docs zones, repo-wide config, all other tickets |
| Reviewer subagent | opencode subagent (model family ≠ executor) | `docs/reviews/` only | Everything else, **NEVER `status: approved` on the artefact under review** (that is the PO's call) |
| Architect-consult subagent | opencode subagent | `docs/architecture/**` (ArchSpec patch fixes + new ADRs only — no minor/major bumps, no component removal, no ADR retirement), `docs/backlog/**`, `docs/questions/**` | `src/`, `tests/`, `migrations/`, tickets, PRDs, ROADMAP, prompts, knowledge, AGENTS.md, CONTRIBUTING.md, opencode.json, `.opencode/**`, `.github/**`, `infra/**`, `scripts/**`. **NEVER `status: approved` on PRD/ArchSpec/Ticket** (PO only). May set `status: accepted` only on a NEW ADR it authors. |

The **reviewer model family must differ from the executor model family** (separation of perspectives). Configure this in `.opencode/agents/executor.md` and `.opencode/agents/reviewer.md` or in `~/.config/opencode/oh-my-openagent.json`.

## Hard rules

1. **Never skip upstream.** No Ticket without an approved ArchSpec. No ArchSpec without an approved PRD.
2. **Version-pinned references only.** Inside any artifact, reference upstream docs as `ID@X.Y.Z` (e.g. `PRD-001@1.0.0`). Bare `PRD-001` outside code fences is rejected by CI.
3. **Status gates.**
   - `draft` — anyone in role may edit.
   - `in_review` — only the matching reviewer touches the artefact (via a separate `docs/reviews/RV-*.md` file).
   - `approved` — immutable. Any change ⇒ bump version and create a new revision file (or `superseded_by` link). Only the PO sets `approved`.
   - `superseded` — read-only; `superseded_by` must point to the replacement.
4. **Non-Goals / NOT In Scope are mandatory.** PRDs list ≥1 Non-Goal. Tickets list ≥1 NOT-In-Scope item.
5. **Architect Phase 0 Recon is mandatory.** Before any design, the Architect MUST read `docs/knowledge/openclaw.md` and `docs/knowledge/awesome-skills.md`, audit fork-candidates, and write a Recon Report into ArchSpec §0. ArchSpec without a Recon Report is rejected.
6. **Executor guardrails.**
   - Executor may modify ONLY files explicitly listed in the Ticket's `§5 Outputs`, with one carve-out: the assigned Ticket file's `status` frontmatter field (transitions `ready → in_progress`, `in_progress → in_review`, `in_progress → blocked`, `blocked → in_progress` — these four only) and append-only edits to that file's `§10 Execution Log`. All other fields on the Ticket file (Goal, ACs, Outputs, etc.) remain read-only to the Executor.
   - If a Ticket is ambiguous or contradicts the ArchSpec, Executor MUST stop and create `docs/questions/Q-TKT-XXX-NN.md` before writing code.
   - Executor may NOT add new runtime dependencies unless the Ticket §7 Constraints explicitly allows them.
7. **Reviewer independence.** Reviewer must be a different model family from the executor. Family separation is enforced by orchestrator routing; a same-family reviewer must refuse and ask Sisyphus to re-route.
8. **No secrets in git.** Ever. Use `.env.example` and document in ArchSpec §9 Security. Permission rules in `opencode.json` block `.env*` writes by default; do not work around them.
9. **No direct push to `main`.** All changes via PR. Each Ticket gets its own PR. PRs require: docs CI green, reviewer subagent verdict `pass` or `pass_with_changes`, local typecheck + lint + tests green.
10. **One TKT, one PR.** Do not aggregate multiple tickets into one PR; do not split one ticket across multiple PRs.

## Handoff contracts

| From → To | What goes across | Gate |
|---|---|---|
| PO → Business Planner | This-epic ask, in chat | — |
| Business Planner → PO | One PRD on a branch, status `draft` | BP runs `validate_docs.py` |
| PO → Architect | One PRD, status `approved` | PO sets status |
| Architect → PO | ArchSpec + ADRs + Tickets, status `draft` | Architect runs `validate_docs.py` |
| PO → Sisyphus orchestrator | One ArchSpec, status `approved`; tickets ready | PO sets statuses; PO invokes `/prd-run PRD-NNN@X.Y.Z` |
| Sisyphus → executor | One Ticket, status `ready`, all `depends_on` done | Orchestrator gates per `tkt-cycle` skill |
| Executor → reviewer (via orchestrator) | One PR, ticket status `in_review` | Local CI green + executor self-review |
| Reviewer → orchestrator | One review file, verdict `pass` / `pass_with_changes` / `fail` | Reviewer runs from a different model family |
| Orchestrator | Merge to `main`, flip ticket `status: done`, append §10 Execution Log | Verdict `pass` or `pass_with_changes` (Mediums backlogged), CI green |

## Change requests

If PO wants to change an already-`approved` PRD:

1. Bump PRD version (e.g. `1.0.0 → 1.1.0`).
2. Open a PR that modifies the PRD (or supersedes it with a new file).
3. Architect annotates which ArchSpec sections are impacted (in a comment or via `Q_TO_BUSINESS`).
4. Affected ArchSpec is bumped, re-reviewed, affected Tickets are re-opened or split.

**No "small tweak" propagates silently to code.** Every change walks the pipeline.

## Parallelism

- Tickets may be executed in parallel **only if** `depends_on` is empty or all listed dependencies are `done`, AND their `§5 Outputs` paths are disjoint.
- The orchestrator defaults to sequential execution. Parallelism requires explicit PO authorisation per run.
- The reviewer model family must differ from the executor's regardless of parallelism.

## LLM hygiene

- Every LLM session starts with a **fresh context**. The orchestrator skills (`tkt-cycle`, `prd-orchestration`) include a bootstrap step that re-reads `AGENTS.md`, `CONTRIBUTING.md`, the relevant ticket / PRD / ArchSpec, and the §4 Inputs cited in the ticket.
- Never dump the entire repo into context — only what the artifact's §4 Inputs (or equivalent) explicitly references.
- If an LLM produces output outside its role (Architect writing code, Executor redesigning the queue) → the reviewer rejects without merge. Model drift is real.
- The PO swaps models for executor / reviewer / architect-consult freely; the only hard rule is reviewer family ≠ executor family.
