---
id: TKT-038
title: Multi-stage Dockerfile (build-in-image)
status: done
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: Deployment / ADR-019
depends_on: []
blocks:
- TKT-040@0.1.0
estimate: S
created: 2026-05-25
updated: 2026-05-25
closed_at: 2026-05-25
closed_by: orchestrator (PO-delegated)
review_ref: RV-CODE-011
---

# TKT-038: Multi-stage Dockerfile (build-in-image)

## 1. Goal
Replace the single-stage `Dockerfile` (which COPYs prebuilt `dist/`) with a two-stage builder→runtime pipeline that compiles inside the image so a fresh VPS can `docker compose up` without host-side `npm`.

## 2. In Scope
- Rewrite `Dockerfile` per ADR-019@0.1.0 §Decision: a `builder` stage that runs `npm ci` + `npm run build`, and a `runtime` stage that runs `npm ci --omit=dev` + `COPY --from=builder /app/dist ./dist`.
- Runtime stage runs as the unprivileged `node` user (the image's standard non-root account).
- Add BuildKit cache mounts on `npm ci` (`--mount=type=cache,target=/root/.npm`) so re-builds are fast.
- Add `.dockerignore` excluding `node_modules/`, `dist/`, `tests/`, `docs/`, `.git/`, `.github/`, `incidents/`, and other non-build inputs.
- Update `docker-compose.yml` `kbju-sidecar.build` to reference the `runtime` target (`{ context: ".", dockerfile: "Dockerfile", target: "runtime" }`).
- The `metrics` service in `docker-compose.yml` (which also `build:`s the same Dockerfile) follows the same `target: runtime` pattern.
- Add `dist/` to `.gitignore` if not already present, to prevent stale artefacts from leaking into the build context.
- Add a smoke test under `tests/deployment/` (extending the existing `tests/deployment/compose.test.ts` style) that asserts the resulting Dockerfile parses, declares two stages named `builder` and `runtime`, and that the runtime stage uses a non-root user.

## 3. NOT In Scope
- External Docker registry / GHCR publish workflow (ADR-019@0.1.0 §Option C, deferred).
- Image scanning / vuln-pinning beyond the digest pinning in TKT-043@0.1.0.
- Changing the `node:24-slim` base image to a different distro / version.
- Adding new CI workflows (`.github/workflows/`) — out of architect zone for this PR.

## 4. Inputs
- ARCH-001@0.7.0 §10 Operational Procedures + §10.1 HYBRID two-process deployment
- ADR-019@0.1.0 (full Dockerfile contract)
- ADR-020@0.1.0 (consumer of this Dockerfile in install.sh)
- Existing `Dockerfile` (the file being rewritten)
- Existing `docker-compose.yml` (the build block being updated)
- Existing `package.json` (the build script being invoked)

## 5. Outputs
- [ ] `Dockerfile` rewritten with `builder` + `runtime` stages.
- [ ] `.dockerignore` (new) excluding non-build inputs.
- [ ] `docker-compose.yml` `kbju-sidecar.build` and `metrics.build` blocks point at `target: runtime`.
- [ ] `.gitignore` includes `dist/` (verify; add if missing).
- [ ] `tests/deployment/dockerfile.test.ts` (new) asserting two-stage structure and non-root user.

## 6. Acceptance Criteria
- [ ] `docker build -t kbju-sidecar:test .` succeeds without host-side `npm` having been run first (verify on a fresh VPS or in a Docker-in-Docker harness).
- [ ] `docker compose config` succeeds.
- [ ] `npm test -- tests/deployment/dockerfile.test.ts` passes.
- [ ] `docker run --rm kbju-sidecar:test id` shows `uid=1000(node)` (non-root).
- [ ] Image size: smaller than the v0.6.2 single-stage equivalent (assert via `docker image inspect`); if the comparison can't be made in CI, the executor records the size in the PR body.
- [ ] `npm run lint` clean.

## 7. Constraints
- Do NOT add new runtime dependencies.
- Do NOT change the application's `npm run build` command; use whatever script `package.json` already exposes.
- Do NOT use `:latest` tags inside the Dockerfile; pin the base image (`node:24-slim`) to a digest matching TKT-043@0.1.0's pinning policy. If TKT-043@0.1.0 hasn't landed yet, leave the tag as `node:24-slim` in this ticket and let TKT-043@0.1.0 pin it; document the dependency in the PR body.
- Use BuildKit (`# syntax=docker/dockerfile:1`) — required for cache mounts.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->
- 2026-05-25T00:00:00Z opencode-executor: started
- 2026-05-25T19:10:00Z opencode-executor: in_review; tests 23 pass; lint clean; typecheck clean; docker build+run verified (uid=1000(node), image ~233 MB)
- 2026-05-25T16:24:00Z opencode-orchestrator: merged in commit 3e685e1; RV-CODE-011 verdict=pass_with_changes (1M backlogged as BL-TKT-038-01); status=done
