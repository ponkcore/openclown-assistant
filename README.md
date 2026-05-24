# openclown-assistant

A personal-life-management Telegram bot in Russian — currently in pilot as **KBJU Coach v0.1**, a calorie / macro tracker that logs meals via voice, text, and photo for two users on a self-hosted VPS. Strategic direction (`docs/roadmap/ROADMAP-001-*.md`) extends this through proactive coaching, calendar + web view, per-user-instance fan-out, life-manager modules, and eventual monetisation.

## What is in this repo

This is a **docs-as-code** monorepo. Specifications drive code; nothing ships without an approved PRD, an approved ArchSpec, and explicit Tickets.

```
docs/
├── prd/           PRDs (Business Planner output)
├── architecture/  ArchSpec + ADRs (Architect output)
├── tickets/       Atomic implementation tickets (Architect output)
├── reviews/       Code-review verdicts (Reviewer subagent output)
├── questions/     Blocker questions raised by the Executor mid-cycle
├── backlog/       Deferred follow-ups
├── roadmap/       Strategic direction across PRDs
├── prompts/       Role prompts for Business Planner and Architect
└── knowledge/     Reference material (openclaw, llm-routing, model evaluations)

src/                  Application code (KBJU sidecar, Node 24 + TypeScript)
packages/             OpenClaw bridge plugin (separate package)
tests/                Vitest test suite mirroring src/

.opencode/            Local orchestrator config (Sisyphus subagents + skills + slash commands)
opencode.json         Project-scoped opencode permissions
scripts/validate_docs.py    CI-enforced docs-as-code validator
```

## Pipeline (three roles, strict separation)

```
PO ↔ Business Planner            (rare; once per epic)
            │
            ▼ docs/prd/PRD-NNN.md (status: approved)
            │
PO ↔ Technical Architect         (rare; once per PRD)
            │
            ▼ ArchSpec + ADRs + Tickets (status: approved/ready)
            │
PO → Sisyphus orchestrator (opencode)   ← invoked once per PRD
            │
            ├── executor subagent     (writes code per one TKT, one PR)
            ├── reviewer subagent     (reviews PR, writes RV-CODE-NNN.md)
            └── architect-consult     (read-only; rare, edge cases only)
                          │
                          ▼
                     merged to `main`
```

The Business Planner and Architect are **not bound to any specific runtime or model** — the PO chooses per session (ChatGPT Plus web, Claude Opus thinking, Codex CLI, opencode, etc.). Sisyphus runs locally in opencode + [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent), with subagents whose models are configured by the PO and freely swappable. The only hard rule is **reviewer model family ≠ executor model family**.

See `AGENTS.md` for the full role table and `CONTRIBUTING.md` for process rules.

## Working with opencode

Inside an opencode session at the repo root:

| Command | What it does |
|---|---|
| `/prd-run PRD-NNN@X.Y.Z` | Walks every Ticket of a PRD in `depends_on` order, dispatching executor + reviewer per ticket, merging PRs on green. Multi-hour autonomous run. |
| `/tkt-run TKT-NNN` | Single-ticket cycle (executor → reviewer → merge). Escape hatch outside a full PRD run. |

The discipline of one TKT cycle is in `.opencode/skills/tkt-cycle/SKILL.md`. The full PRD-loop is in `.opencode/skills/prd-orchestration/SKILL.md`. The orchestrator loads the matching skill automatically when you invoke a slash command.

### Subagents

| Subagent | Role | Default model |
|---|---|---|
| `executor` | Writes code for one TKT, runs tests, opens PR | Configured in `.opencode/agents/executor.md` (override per session if needed) |
| `reviewer` | Reviews the PR, writes `docs/reviews/RV-CODE-NNN-*.md`, returns verdict | Configured in `.opencode/agents/reviewer.md` — must be a different family than the executor |
| `architect-consult` | Read-only consultant for narrow gaps the orchestrator hits during a cycle | Configured in `.opencode/agents/architect-consult.md` |

Models for these subagents are settled either inline in their `.md` frontmatter or globally in `~/.config/opencode/oh-my-openagent.json`. The PO swaps freely.

### Permissions

`opencode.json` constrains autonomous edits at the orchestrator level:
- `src/`, `tests/`, `packages/`, `docs/tickets/**`, `docs/reviews/**`, `docs/questions/**`, `docs/backlog/**` — auto-allow.
- `docs/prd/**`, `docs/architecture/**`, `docs/roadmap/**`, `docs/prompts/**`, `docs/knowledge/**`, `AGENTS.md`, `CONTRIBUTING.md`, `.opencode/**`, `.github/**`, `infra/**`, `scripts/**`, `Dockerfile`, `docker-compose.yml` — ask before editing.
- `.env*`, `*.pem`, `*.key`, `**/secrets/**` — denied outright.
- `git push --force`, `git push * main*`, `git config *`, `npm publish`, `docker push` — denied.
- `git reset --hard`, `git clean -f`, `git branch -D` — ask first.

## Local development

Prerequisites: Node 24, npm, Postgres 17 (or Docker).

```
npm ci
npm run typecheck    # strict TypeScript
npm run lint         # tsc --noEmit
npm test             # vitest
npm run build        # emits dist/
```

Full stack via Docker:

```
cp .env.example .env   # fill in real values; never commit
docker compose up
```

`docker-compose.yml` brings up the KBJU sidecar (Node 24 HTTP server on `:3000`), the OpenClaw gateway (which holds the Telegram channel and forwards to the sidecar via the `kbju-bridge` plugin), Postgres 17 with persistent volume, and a metrics service on `:9464`.

## Required environment variables

See `.env.example` for the canonical list. Highlights:

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_PILOT_USER_IDS` — the bot and its allowlist.
- `DATABASE_URL`, `POSTGRES_PASSWORD` — tenant-scoped Postgres.
- `OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY` — LLM router (Fireworks-pool first, fallback to direct providers).
- `FIREWORKS_API_KEY` — direct Whisper / Qwen-VL fallback path.
- `USDA_FDC_API_KEY` — nutrition lookup for hybrid KBJU estimation.
- `MONTHLY_SPEND_CEILING_USD` — auto-degrade trigger (default `10`).

## Validating docs

`scripts/validate_docs.py` checks every artefact's frontmatter, status enum, and version-pinned cross-references. CI runs it on every PR; run it locally before push:

```
python scripts/validate_docs.py
```

It expects `pyyaml`. On a fresh checkout: `pip install --user pyyaml` (or use the Nix shell: `nix-shell -p python3 python3Packages.pyyaml --run "python3 scripts/validate_docs.py"`).

## Status

- **PRD-001** KBJU Coach v0.1 — `approved 0.2.0`, in production for 2 pilot users.
- **PRD-002** observability + scale-readiness — `approved 0.3.0`. G1 continuous tenant-isolation breach detection, G2 automated model-stall detection, G4 config-driven Telegram allowlist load-tested to 10 000 users.
- **PRD-003** tracking modalities expansion (water / sleep / workout / mood + per-modality settings + adaptive summaries) — `approved 0.1.3`, ArchSpec `0.6.1` in amendment cycle, 11 PRD-003 tickets `ready` waiting for orchestration.
- **ROADMAP-001** — `approved 0.1.0`, anchors v0.2 and beyond.

## License

(none specified yet)
