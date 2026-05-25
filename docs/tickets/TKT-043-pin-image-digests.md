---
id: TKT-043
title: Pin docker-compose.yml images to digests (openclaw-gateway, caddy)
status: blocked
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: Deployment
depends_on:
- TKT-039@0.1.0
blocks: []
estimate: S
created: 2026-05-25
updated: 2026-05-25
---

# TKT-043: Pin docker-compose.yml images to digests (openclaw-gateway, caddy)

## 1. Goal
Replace tag-based references (`ghcr.io/.../openclaw:latest`, `caddy:2-alpine`, `cloudflare/cloudflared:latest`, `postgres:17`, `node:24-slim`) in `docker-compose.yml`, the `Dockerfile`, and the cloudflare overlay with `image@sha256:<digest>` references so deploys are reproducible and don't drift on `docker compose pull`.

## 2. In Scope
- `docker-compose.yml`: pin `openclaw-gateway` (`ghcr.io/nicholasgriffintn/openclaw:latest` → digest), `postgres:17` → digest, `caddy:2-alpine` → digest, `cloudflared` (in the overlay) → digest.
- `Dockerfile` (TKT-038@0.1.0 output): pin `node:24-slim` to a digest in BOTH the `builder` and `runtime` `FROM` lines.
- A short README-style note in a new `docs/architecture/image-digests.md` documenting how the operator updates digests when a CVE patch is needed: pull the new tag, copy `docker inspect <image> --format '{{.RepoDigests}}'` output, paste into the compose file, commit. Architect-zone permissible (it sits under `docs/architecture/`).
- Smoke test in `tests/deployment/compose.test.ts` (extend) asserting every `image:` reference in `docker-compose.yml` uses the `@sha256:` form.

## 3. NOT In Scope
- Subscribing to vulnerability scanners.
- Implementing automated digest-update CI.
- Changing image vendors.
- Changing the `node:24-slim` base to a different distro.

## 4. Inputs
- ARCH-001@0.7.0 §10.1 HYBRID two-process deployment, §10.2 Runtime Topology
- TKT-038@0.1.0 (Dockerfile shape — depends_on in spirit, can land separately)
- TKT-039@0.1.0 (Caddy + Cloudflare Tunnel compose blocks — depends_on)
- Existing `docker-compose.yml`
- Existing `Dockerfile`

## 5. Outputs
- [ ] `docker-compose.yml` with all `image:` lines pinned to `@sha256:<digest>`.
- [ ] `Dockerfile` builder + runtime stages pinned to `node:24-slim@sha256:<digest>`.
- [ ] `docker-compose.cf-tunnel.yml` cloudflared image pinned to `@sha256:<digest>`.
- [ ] `docs/architecture/image-digests.md` (new) — operator-facing update guide, frontmatter as a `draft` under ARCH-001@0.7.0.
- [ ] `tests/deployment/compose.test.ts` extended with the `@sha256:` assertion for every image.

## 6. Acceptance Criteria
- [ ] `docker compose pull` succeeds (every digest resolves).
- [ ] `docker compose config` succeeds.
- [ ] `npm test -- tests/deployment/compose.test.ts` passes including the new digest assertion.
- [ ] No `:latest` tag remains in any `image:` reference in `docker-compose.yml` or `docker-compose.cf-tunnel.yml`.

## 7. Constraints
- Use the `image@sha256:<digest>` form (Docker-canonical), not `image:tag@sha256:<digest>`. The `tag` part is optional and adding it doesn't affect resolution but creates needless noise.
- Pull digests at the time of execution; record them in the PR body so reviewers can verify against `docker manifest inspect`.
- Do NOT pin to a digest the executor cannot independently retrieve — every digest must be reachable from a public registry at PR-merge time.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->
- 2026-05-26T00:00:00Z opencode-executor: started
- 2026-05-26T00:30:00Z opencode-executor: blocked; Q-TKT-043-01 filed — ghcr.io/nicholasgriffintn/openclaw:latest does not resolve on GHCR (manifest unknown); cannot pin per §7 Constraints; awaiting PO/Architect decision on image path
