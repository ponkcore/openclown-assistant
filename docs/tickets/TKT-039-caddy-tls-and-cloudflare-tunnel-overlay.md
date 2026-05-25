---
id: TKT-039
title: Caddy + Let's Encrypt TLS termination + Cloudflare Tunnel overlay
status: ready
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: Deployment / ADR-020
depends_on: []
blocks:
- TKT-040@0.1.0
estimate: M
created: 2026-05-25
updated: 2026-05-25
---

# TKT-039: Caddy + Let's Encrypt TLS termination + Cloudflare Tunnel overlay

## 1. Goal
Add a Caddy reverse-proxy service that terminates inbound TLS for the Telegram webhook with automatic Let's Encrypt issuance, plus a `docker-compose.cf-tunnel.yml` overlay for operators who prefer Cloudflare Tunnel.

## 2. In Scope
- New `caddy` service in `docker-compose.yml` per ADR-020@0.1.0 §Default path:
  - Image: `caddy:2-alpine` pinned to a digest by TKT-043@0.1.0 (use the tag in this ticket; TKT-043@0.1.0 swaps in the digest).
  - Ports `80:80` and `443:443` exposed on the host.
  - Volumes: `./Caddyfile:/etc/caddy/Caddyfile:ro`, `caddy_data:/data`, `caddy_config:/config`.
  - Env: `KBJU_PUBLIC_DOMAIN: ${KBJU_PUBLIC_DOMAIN}`.
  - `depends_on: openclaw-gateway`.
  - `restart: unless-stopped`.
  - Healthcheck: `curl -fsS http://localhost/health`.
- New top-level `Caddyfile` per ADR-020@0.1.0 §Default path (literal content shown in that ADR; the executor copies it verbatim).
- New `docker-compose.cf-tunnel.yml` overlay per ADR-020@0.1.0 §Override path — disables the `caddy` service via a profile and adds a `cloudflared` service that takes `CLOUDFLARED_TUNNEL_TOKEN` from env.
- Add `caddy_data` and `caddy_config` named volumes to the `volumes:` block (top of file).
- Add `KBJU_PUBLIC_DOMAIN`, `CLOUDFLARED_TUNNEL_TOKEN`, and `INSTALL_TLS_MODE` to `.env.example` with documentation comments.
- Smoke test in `tests/deployment/compose.test.ts` (extend existing) asserting the `caddy` service exists with the correct port mapping, volume mounts, and healthcheck shape; and asserting `docker-compose.cf-tunnel.yml` exists and references `cloudflared`.
- Update `tests/deployment/envExample.test.ts` to include the new env vars in the required-name set.

## 3. NOT In Scope
- `install.sh` itself — TKT-040@0.1.0 owns.
- Pinning Caddy / cloudflared images to digests — TKT-043@0.1.0 owns.
- Changing OpenClaw Gateway's webhook port (the Caddyfile assumes the existing one).
- Configuring Cloudflare Tunnel routes from inside this repo — operator does that in the CF dashboard (PRD-001@0.3.0 §3 NG5 forbids admin web UI in v0.1, but the operator's CF dashboard is operator territory, not application territory).

## 4. Inputs
- ARCH-001@0.7.0 §10.4 Deploy Sequence (the install.sh contract that consumes this)
- ADR-020@0.1.0 (full Caddy / Cloudflare Tunnel contract)
- ADR-008@0.1.0 (Docker Compose VPS deployment)
- Existing `docker-compose.yml`
- Existing `.env.example`
- Existing `tests/deployment/*.test.ts` (extension targets)

## 5. Outputs
- [ ] `docker-compose.yml` extended with `caddy` service + `caddy_data` / `caddy_config` named volumes.
- [ ] `Caddyfile` (new) at repo root.
- [ ] `docker-compose.cf-tunnel.yml` (new) overlay file at repo root.
- [ ] `.env.example` extended with `KBJU_PUBLIC_DOMAIN`, `CLOUDFLARED_TUNNEL_TOKEN`, `INSTALL_TLS_MODE`.
- [ ] `tests/deployment/compose.test.ts` extended with Caddy + overlay assertions.
- [ ] `tests/deployment/envExample.test.ts` extended for new env-var names.

## 6. Acceptance Criteria
- [ ] `docker compose config` succeeds with the default file alone.
- [ ] `docker compose -f docker-compose.yml -f docker-compose.cf-tunnel.yml config` succeeds and the `caddy` service is profile-disabled in the merged output.
- [ ] `npm test -- tests/deployment/` passes.
- [ ] Caddy service block has explicit `restart: unless-stopped`, `depends_on: openclaw-gateway`, and the three named volumes / Caddyfile bind.
- [ ] No host bind mount for production data (Caddy only mounts the Caddyfile read-only and the two named volumes).
- [ ] `Caddyfile` references `{$KBJU_PUBLIC_DOMAIN}` and reverse-proxies `/telegram*` to `openclaw-gateway`.

## 7. Constraints
- Do NOT add new runtime dependencies in `package.json`.
- Do NOT commit secrets — `CLOUDFLARED_TUNNEL_TOKEN` is referenced from env, never embedded.
- Caddy service must not use host networking; it sits on the same `internal` Docker network and exposes 80/443 only via the compose `ports:` block.
- The `caddy` service `image:` in this ticket may be `caddy:2-alpine` (tag-only); TKT-043@0.1.0 will swap to a digest. Document this explicit dependency in the PR body.
- Healthcheck endpoint `/health` must return literal `kbju-caddy-ok` 200 per the Caddyfile in ADR-020@0.1.0.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->
