---
id: ADR-019
title: 'Build-in-image: multi-stage Dockerfile'
status: proposed
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
created: 2026-05-25
updated: 2026-05-25
superseded_by: null
---

# ADR-019: Build-in-image — multi-stage Dockerfile

## Context

The current `Dockerfile` (10 lines, single stage `node:24-slim`) starts by `COPY dist/`,
which **assumes the operator has already run `npm run build` on the host before
`docker compose up`**. This was an unstated v0.5.0 deploy precondition that worked for
the PO's local machine but breaks the PRD-001@0.3.0 single-command install path
(`./scripts/install.sh`, see ADR-020@0.1.0 §10.4): a fresh VPS clone has no `dist/`,
so `docker compose up -d` produces an image with an empty bind into `dist/`, and the
sidecar fails to start with `Cannot find module 'dist/src/main.js'`.

The single-stage `node:24-slim` also ships dev dependencies and the full TypeScript
toolchain in production images — heavier image, larger attack surface, slower image
pulls in the §10.7 VPS migration runbook.

## Options Considered (≥3 real options, no strawmen)

### Option A: Multi-stage build inside the Dockerfile (the standard pattern)

- Description:

  ```dockerfile
  # 1. Builder stage: dev deps + tsc compile
  FROM node:24-slim AS builder
  WORKDIR /app
  COPY package.json package-lock.json* ./
  RUN npm ci
  COPY tsconfig.json ./
  COPY src/ ./src/
  COPY tests/ ./tests/    # only if needed by build hooks; otherwise omit
  RUN npm run build

  # 2. Runtime stage: prod deps + compiled artefacts only
  FROM node:24-slim AS runtime
  WORKDIR /app
  COPY package.json package-lock.json* ./
  RUN npm ci --omit=dev
  COPY --from=builder /app/dist ./dist
  USER node
  CMD ["node", "dist/src/main.js"]
  ```

- Pros (concrete):
  - Self-contained build: `docker compose build` works on any machine with Docker, no
    host `npm` / TypeScript install required. Matches `install.sh` (ADR-020@0.1.0 §10.4)
    contract that operators run a single command on a fresh VPS.
  - Smaller runtime image: ships only `node_modules/*` (prod) and `dist/` plus the
    compiled JS, not the TypeScript source, dev dependencies, or build cache. Docker
    documents multi-stage as the recommended pattern for Node production images
    (<https://docs.docker.com/build/building/multi-stage/>).
  - Smaller attack surface: dev dependencies (linters, test runners, type checkers)
    don't reach production. Several live in transitive npm trees and are common attack
    vectors.
  - The runtime stage runs as the unprivileged `node` user (the `node:24-slim`
    image's standard non-root account) instead of `root`.
- Cons (concrete):
  - Slightly more complex Dockerfile to read; mitigated by the standard pattern being
    well-documented.
  - First build is slower (compile + npm ci twice, once for dev, once for prod);
    BuildKit cache mounts (`--mount=type=cache,target=/root/.npm`) restore most of
    the time after the first build. Acceptable: install.sh runs once per deploy, not
    per request.
- Cost / latency / ops burden: one-time Dockerfile rewrite + docker-compose `build`
  block update; zero runtime cost.

### Option B: Run `tsc` at container start (no precompile)

- Description: Drop the build step entirely; image is `node:24` with the full
  TypeScript toolchain; entrypoint is `npx tsx src/main.ts` or `node --loader
  ts-node/esm src/main.ts`.
- Pros: no build stage; simpler Dockerfile.
- Cons:
  - Production image ships full TypeScript toolchain — bigger image, bigger attack
    surface than Option A.
  - Cold-start time gains a full TS compile every container restart. PRD-001@0.3.0
    §7 voice latency budget (≤8 s p95) leaves no headroom for a 10–20 s tsc compile
    at startup.
  - `tsx` / `ts-node` add transitive dependencies that are otherwise unnecessary in
    production.
- Cost / latency / ops burden: low at write time, high at runtime.

### Option C: External build pipeline + image push to registry

- Description: GitHub Actions builds the image, pushes to a registry; the VPS pulls.
  PO-locked: PRD-001@0.3.0 §7 single-VPS, no SaaS dependencies; managed registries are
  fine but add an account boundary.
- Pros: build runs once per release, not on every VPS deploy.
- Cons:
  - Adds a GitHub Actions Docker build job and a registry account. Acceptable for
    later, but PRD-001@0.3.0 §3 Non-Goals does not authorise a release-pipeline
    workflow change as part of provider-abstraction work.
  - Doesn't replace the local-build path; `install.sh` on a fresh VPS still needs to
    work without an external registry login (operator may not have GitHub auth).
  - Not mutually exclusive with Option A: a future ADR can layer "publish image to
    GHCR" on top, with `install.sh` falling back to local build if the registry pull
    fails.
- Cost / latency / ops burden: medium build infra; medium ops; deferred.

### Option D: Keep the single-stage Dockerfile and require `npm run build` in install.sh

- Description: The current state. `install.sh` runs `npm ci && npm run build` before
  `docker compose up`.
- Pros: zero Dockerfile change.
- Cons:
  - Requires Node and the full toolchain on the VPS host. PRD-001@0.3.0 §7 doesn't
    forbid this, but every additional host dependency is a portability liability and
    bumps the install.sh prerequisite list.
  - Splits the build environment between host and container; operator-host Node
    version drift can produce broken images. CI does this with explicit Node
    pinning; pilot VPS may not.
- Cost / latency / ops burden: low at write time; medium at ops time (host toolchain).

## Decision

We will use **Option A: multi-stage Dockerfile (`builder` → `runtime`)**.

Concrete contract for TKT-038@0.1.0 to implement:

- Builder stage installs all deps with `npm ci` and runs `npm run build`.
- Runtime stage installs only production deps with `npm ci --omit=dev` and copies
  `dist/` from the builder.
- Runtime stage runs as the unprivileged `node` user.
- `docker-compose.yml` `kbju-sidecar.build` block becomes
  `{ context: ".", dockerfile: "Dockerfile", target: "runtime" }`.
- The image is rebuildable on any host with Docker, no host Node required. `install.sh`
  (ADR-020@0.1.0 §10.4) does NOT run `npm` on the host.
- BuildKit cache mounts are added on the npm install steps so re-deploys re-use the
  cache and don't repeat slow `npm ci` cycles.
- `dist/` is added to `.gitignore` if not already; the host should not ship a stale
  `dist/` that gets bind-mounted by accident.
- A `.dockerignore` file is added that excludes `node_modules/`, `dist/`, `tests/` (if
  not needed in the build), `docs/`, and other non-build inputs. Keeps build context
  small and reproducible.

### Why the losers lost

- **Option B (compile at startup):** breaks the latency budget at every container
  restart, ships dev toolchain in production.
- **Option C (external registry build):** out of scope for this PR (no `.github/`
  workflow change authorised); also not mutually exclusive with A — can be layered
  later.
- **Option D (status quo + host toolchain):** keeps the host-Node dependency the
  install.sh path is trying to remove; bigger surface for environment drift.

## Consequences

**Positive:**

- `install.sh` and `docker compose up` work on a fresh VPS with only Docker
  installed.
- Smaller and more secure runtime image (no TypeScript toolchain, no dev deps).
- Container runs as non-root (`node` user).
- BuildKit cache speeds up repeat builds.

**Negative / trade-offs accepted:**

- First build on a fresh VPS is slower (downloads + npm install twice). Acceptable —
  install.sh runs rarely and the cost is bounded.
- The repo has to maintain `Dockerfile`'s two stages in sync with `package.json`
  changes (TypeScript version, scripts). Standard practice.

**Follow-up work:**

- TKT-038@0.1.0 implements the multi-stage Dockerfile and updates
  `docker-compose.yml` to reference the `runtime` target.
- ADR-020@0.1.0 §10.4 install.sh assumes this Dockerfile (no host `npm`).
- ADR-008@0.1.0 portability claims hold without modification; the change is image
  internals, not deployment topology.

## References

- PRD-001@0.3.0 §7 (single-command install path; no host toolchain assumption)
- ADR-008@0.1.0 (Docker Compose VPS deployment topology — unchanged)
- ADR-020@0.1.0 (inbound TLS / install.sh path — depends on this ADR)
- Docker multi-stage builds reference: <https://docs.docker.com/build/building/multi-stage/>
- Docker BuildKit cache mounts: <https://docs.docker.com/build/cache/optimize/>
- node:24-slim image reference: <https://hub.docker.com/_/node>
