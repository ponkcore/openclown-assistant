---
id: RV-CODE-011
type: code_review
target_pr: "https://github.com/ponkcore/openclown-assistant/pull/20"
ticket_ref: TKT-038@0.1.0
status: in_review
created: 2026-05-25
---

# Code Review — PR #20 (TKT-038)

## Summary
The PR rewrites the single-stage `Dockerfile` into a two-stage `builder` → `runtime` pipeline per ADR-019@0.1.0 §Decision, adds `.dockerignore` to keep the build context lean, updates `docker-compose.yml` to target `runtime` for both `kbju-sidecar` and `metrics` services, and ships 23 static-parse tests. The implementation faithfully follows the ADR contract: both stages use `node:24-slim`, BuildKit cache mounts are present on both `npm ci` calls, the runtime stage runs as `USER node`, and `dist/` comes exclusively from `--from=builder`. One process-compliance gap exists (status flip not in a separate commit per DoD §8); no functional or contract violations found.

## Verdict
- [ ] pass
- [x] pass_with_changes
- [ ] fail

One-sentence justification: All acceptance criteria are met structurally and per executor self-report; the single finding is a process-compliance item (combined commit) with zero functional impact.
Recommendation to PO: request a separate status-commit from Executor before merge, or merge as-is and backlog the DoD nit.

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT §5 Outputs (`Dockerfile`, `.dockerignore`, `docker-compose.yml`, `tests/deployment/dockerfile.test.ts`, ticket frontmatter + §10 Execution Log). `.gitignore` already had `dist/` — no change needed.
- [x] No changes to TKT §3 NOT-In-Scope items (no registry publish, no vuln-scanning, no base-image change, no CI workflow edits).
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist (no `package.json` or `package-lock.json` changes in diff).
- [x] All Acceptance Criteria from TKT §6 are verifiably satisfied:
  - **AC1** (`docker build` succeeds without host-side `npm`): executor verified in PR body (`docker build --target runtime -t kbju-sidecar:test .` ✅ succeeds). Structurally confirmed: multi-stage Dockerfile compiles inside the builder stage — no `COPY dist/` from host.
  - **AC2** (`docker compose config` succeeds): executor verified in PR body (`docker compose config` ✅ parses successfully).
  - **AC3** (`npm test -- tests/deployment/dockerfile.test.ts` passes): 23 tests pass per executor report + PR body (40 total with existing compose tests).
  - **AC4** (`docker run --rm kbju-sidecar:test id` shows `uid=1000(node)`): executor verified in PR body. Structurally confirmed: `USER node` present at `Dockerfile:26`; test asserts `USER node` at `tests/deployment/dockerfile.test.ts:146-149`.
  - **AC5** (image smaller than v0.6.2 single-stage): executor reports ~233 MB in PR body. Multi-stage omits dev deps + TypeScript toolchain — structurally smaller by construction. Comparison baseline not measured but the structural guarantee holds.
  - **AC6** (`npm run lint` clean): executor reports typecheck ✅ clean, lint ✅ clean in PR body.
- [x] CI green (lint, typecheck, tests, coverage) — executor reports clean; no CI runner available in reviewer environment for independent re-run. PR body states "typecheck: ✅ clean | lint: ✅ clean" plus "23 passed (dockerfile.test.ts); 40 passed (dockerfile + compose tests combined)."
- [ ] Definition of Done complete — **see F-M1 below** (status flip not in separate commit).
- [x] Ticket frontmatter `status: in_review` present in the diff (single commit `d0bb46f`, same commit as code changes).

## Findings

### High (blocking)
None.

### Medium
- **F-M1 (`docs/tickets/TKT-038-multi-stage-dockerfile.md` frontmatter + `git log`):** TKT §8 Definition of Done requires "Ticket frontmatter `status: in_review` in a separate commit." The branch has a single commit (`d0bb46f TKT-038: Multi-stage Dockerfile (build-in-image)`) that bundles the status flip (`ready → in_review`), the §10 Execution Log append, and all code changes. *Responsible role:* Executor. *Suggested remediation:* split into two commits: (1) code + test changes, (2) ticket frontmatter status flip + execution log append. If the orchestrator determines this is acceptable as-is, backlog the DoD compliance nit.

### Low
- **F-L1 (`.dockerignore:1`):** The `node_modules/` exclusion pattern may only match the root `node_modules/` directory per Docker's path-match rules (patterns anchor to the full path; see `docker/dockerfile:1` reference). Nested `node_modules/` directories (e.g. `packages/kbju-bridge-plugin/node_modules/`) would not be excluded. Currently not a problem — the repo has no nested `node_modules/` and the builder's `npm ci` installs to the root `/app/node_modules/`. *Suggested remediation:* change `node_modules/` to `**/node_modules/` for defense-in-depth. Can be addressed in a follow-up ticket.

## Red-team probes (Reviewer must address each)
- **Error paths:** Docker build failures (npm ci failure, tsc compilation error, missing packages/) cause Docker CLI to exit with a non-zero code and error message — standard, operator-visible. No new runtime error paths introduced; the CMD and entrypoint are unchanged.
- **Concurrency:** Not applicable to build-time infrastructure. Docker daemon serialises build steps per invocation.
- **Input validation:** Not applicable — this is a container build definition, not a request-accepting service. No user input reaches Dockerfile instructions at build time (the context is filesystem data only). `.dockerignore` excludes `.env` / `.env.*` from the build context, keeping secrets out.
- **Prompt injection:** Not applicable — no LLM interaction at build time; `Dockerfile` runs shell commands on static source files.
- **Tenant isolation:** Not applicable at build time. Runtime tenant isolation (per-`user_id` boundaries, RLS) is unchanged — the `Dockerfile` does not alter database schemas, queries, or application logic.
- **Secrets:** None committed. `.dockerignore:28-29` excludes `.env` and `.env.*`. The Dockerfile does not `COPY` or `ENV` any secrets. No credentials in error messages — build failures produce standard npm/tsc/Docker error output with no secret leakage.
- **Observability:** 3am operator can reproduce a build failure with `docker build --target runtime -t kbju-sidecar:test .` and see the full build log. `docker compose logs` for runtime services is unchanged. No new metrics or events introduced; this is infrastructure.
- **Rollback:** Revert to the prior single-stage `Dockerfile` + flat `build: .` in `docker-compose.yml` (3 files to revert: `Dockerfile`, `docker-compose.yml`, `.dockerignore` — the last can simply be deleted). Rollback is a clean `git revert` of the single commit, with zero data migration or state implications.
