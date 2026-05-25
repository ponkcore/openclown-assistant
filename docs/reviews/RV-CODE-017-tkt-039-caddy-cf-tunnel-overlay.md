---
id: RV-CODE-017
type: code_review
target_pr: "https://github.com/code-yeongyu/openclown-assistant/pull/26"
ticket_ref: TKT-039@0.1.0
status: in_review
created: 2026-05-25
---

# Code Review — PR #26 (TKT-039@0.1.0)

## Summary
The PR adds Caddy reverse-proxy with Let's Encrypt TLS termination and a Cloudflare Tunnel compose overlay, per ADR-020@0.1.0. Implementation is structurally faithful to the ADR — the Caddyfile content matches character-by-character, the docker-compose.yml caddy block has all required fields, and the overlay correctly uses `profiles: ["disabled"]`. However, the upstream port `openclaw-gateway:8080` is wrong: the OpenClaw gateway container listens on port **18789** by default (confirmed by OpenClaw Dockerfile HEALTHCHECK at `http://127.0.0.1:18789/healthz`, CLI docs default `--port`, and Dockerfile comment about `-p 18789:18789`). This means the Caddy reverse-proxy will silently fail on startup. The root cause is in ADR-020@0.1.0 itself, which specified the wrong port; this requires architect-level correction.

## Verdict
- [ ] pass
- [ ] pass_with_changes
- [x] fail

One-sentence justification: The Caddyfile upstream port (`openclaw-gateway:8080`) does not match the OpenClaw gateway's actual listening port (18789); the reverse-proxy will fail to connect, making AC #3 and AC #6 unverifiable for real-world operation.
Recommendation to PO: escalate-to-architect — ADR-020@0.1.0 §Default path specifies the wrong upstream port; the architect must correct the ADR port and both the ADR Caddyfile block and this ticket's Caddyfile must be updated.

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT-039@0.1.0 §5 Outputs
- [x] No changes to TKT-039@0.1.0 §3 NOT-In-Scope items
- [x] No new runtime dependencies beyond TKT-039@0.1.0 §7 Constraints allowlist
- [ ] All Acceptance Criteria from TKT-039@0.1.0 §6 are verifiably satisfied (file:line or test name cited) — **AC #3 and #6 are satisfied in code structure but incorrect in port value** (`openclaw-gateway:8080` vs actual 18789); see F-H1.
- [x] CI green (lint, typecheck, tests, coverage) — executor reports 54 tests pass, lint clean, typecheck clean
- [x] Definition of Done complete — two-commit split confirmed (`f6f32d7` status flip, `698343b` implementation), §10 Execution Log filled, PR opened
- [x] Ticket frontmatter `status: in_review` in a separate commit (commit `f6f32d7`)

## Findings

### High (blocking)
- **F-H1 (Caddyfile:3–4; ADR-020@0.1.0 lines 156–157):** The Caddyfile reverse-proxies `/telegram` and `/telegram/*` to `openclaw-gateway:8080`, but the OpenClaw gateway listens on port **18789** by default. Evidence: (1) OpenClaw Dockerfile HEALTHCHECK: `fetch('http://127.0.0.1:18789/healthz')`; (2) Dockerfile comment: `-p 18789:18789` for Docker bridge networking; (3) CLI docs: `--port <port>: WebSocket port (default comes from config/env; usually 18789)`. Our `docker-compose.yml` does not override the gateway's port. The reverse-proxy will silently fail — Caddy will get `connection refused` at `openclaw-gateway:8080`. The root cause is in ADR-020@0.1.0 §Default path which authored the Caddyfile with the incorrect port; the executor faithfully copied it. *Responsible role:* Architect (ADR-020 correction) + Executor (re-apply corrected Caddyfile). *Suggested remediation:* Architect must amend ADR-020@0.1.0 to change `openclaw-gateway:8080` to `openclaw-gateway:18789` in both the Caddyfile block and the install.sh path narrative (line 200 also references 8080), bump ADR version, then the Executor updates the Caddyfile and re-verifies.

### Medium
- **F-M1 (docker-compose.yml:105–125 — caddy service):** The `caddy` service has no `logging:` block with log rotation, unlike all other services in `docker-compose.yml` (`kbju-sidecar`, `openclaw-gateway`, `postgres`, `metrics` each have `max-size` / `max-file`). This means Caddy logs will grow unbounded on the Docker host. The existing test "Docker logs have bounded rotation" only checks services that already have a `logging:` block, so it won't catch this. *Suggested remediation:* Add `logging: driver: json-file options: max-size: "10m" max-file: "5"` to the caddy service.

### Low
- **F-L1 (docker-compose.yml:103):** `caddy` service uses `depends_on: openclaw-gateway condition: service_started` — other services use `condition: service_healthy`. ADR-020@0.1.0 uses `condition: service_started`, so the executor matched the contract, but note that `service_started` only waits for the container process to start, not for the gateway to be healthy. If the gateway takes longer to initialise its webhook handler, Caddy may start reverse-proxying before the gateway is ready. Consider upgrading to `condition: service_healthy` once the openclaw-gateway has a declared healthcheck in docker-compose.yml (it currently has none in our compose file).

- **F-L2 (Caddyfile:1–8, ADR-020@0.1.0):** The Caddy `encode zstd gzip` directive compresses responses. While this is in the ADR verbatim, enabling `zstd` compression adds CPU overhead for what is essentially small JSON webhook payloads to/from Telegram. No action needed now — note for pilot performance observation.

## Red-team probes (Reviewer must address each)
- **Error paths — Telegram / OmniRoute / Whisper / Postgres / LLM timeout:** Caddy is purely a reverse-proxy; it does not interact with these services directly. If Caddy fails to start (e.g. port 80/443 already bound), the operator gets a normal Docker error. If the OpenClaw gateway is unreachable (which it will be with the current port), Caddy returns 502 Bad Gateway to Telegram — Telegram's webhook retry mechanism will retry on exponential backoff. No new error paths beyond what already exists.
- **Concurrency:** Caddy handles concurrent connections natively with Go's goroutine model. Two simultaneous Telegram webhook deliveries are handled correctly. No shared state between requests.
- **Input validation:** Caddy is not an application-level proxy — it passes through requests to the gateway without inspection. The gateway and sidecar handle input validation as before. Caddy's `encode` directive applies compression; no new input surface.
- **Prompt injection:** Caddy does not inspect request bodies — it reverse-proxies them untouched. No user text passes through Caddy's logic. No new injection surface added.
- **Tenant isolation:** No change — the gateway and sidecar maintain per-`user_id` boundaries. ADR-001@0.1.0 RLS model is unchanged.
- **Secrets:** No credentials in committed files. `CLOUDFLARED_TUNNEL_TOKEN` is referenced from env only. `KBJU_PUBLIC_DOMAIN` is an env var placeholder. `.env.example` extended correctly with blank/default values.
- **Observability:** Caddy produces access logs to stdout/stderr. Without `logging:` configuration in docker-compose.yml (F-M1), these logs may grow unbounded. Caddy does not emit metrics in the `src/observability/events.ts` format — it's an infrastructure component, not an application component. A 3am operator can check `docker compose logs caddy` for 502 errors but won't get structured KPI events from Caddy itself. The gateway's logs remain the primary observability surface.
- **Rollback:** Reverting the Caddy-related commits removes the `caddy` service, `Caddyfile`, and overlay file from `docker-compose.yml`. Since `caddy` is additive (not modifying existing services), a `git revert` + `docker compose down caddy` is sufficient to roll back. No migration required.
