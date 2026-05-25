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

---

## Iteration 2 — re-review

**Re-reviewed commit:** `089a658` (force-push rebased on `main` containing ADR-020@0.1.1 from arch PR #27).

### Per-finding status

#### F-H1 — upstream port mismatch (iteration-1 `fail`)
**Status: RESOLVED.**

- Caddyfile lines 3-4 now proxy to `openclaw-gateway:18789` (was `:8080`).
- Matches ADR-020@0.1.1 §Default path Caddyfile (lines 157-158) character-by-character.
- ADR-020@0.1.1 line 273 changelog confirms the port correction.
- `docker-compose.cf-tunnel.yml` does not reference the upstream port directly (it relies on CF dashboard ingress rules), so no change needed there — but ADR-020@0.1.1 line 201 also corrected the tunnel target from `:8080` to `:18789` for documentation consistency.

#### F-M1 — caddy missing logging block
**Status: RESOLVED.**

- `docker-compose.yml` caddy service (lines 123-127) now has:
  ```yaml
  logging:
    driver: json-file
    options:
      max-size: "10m"
      max-file: "3"
  ```
- Consistent with other services (`kbju-sidecar` and `openclaw-gateway` use 10m/5, `metrics` uses 5m/3). The `3` file count is slightly lower than some peers but within acceptable range.

#### F-L1 — `depends_on: service_started` vs `service_healthy`
**Status: UNCHANGED (Low).** The executor did not change this, matching ADR-020@0.1.1 which also specifies `condition: service_started`. The openclaw-gateway still lacks a declared healthcheck in `docker-compose.yml`, so `service_healthy` is unavailable. This remains an observation for future hardening — not actionable in this ticket.

#### F-L2 — zstd compression overhead
**Status: UNCHANGED (Low).** ADR-020@0.1.1 retains `encode zstd gzip`. No action.

### New findings (iter-2 only)

#### Low
- **F-L3 (tests/deployment/compose.test.ts:37):** The inline comment in the hostBindMounts test references `ADR-020@0.1.0` while all `describe()` blocks in the same file were re-pinned to `ADR-020@0.1.1`. This is a stale version reference in a code comment — zero functional impact but inconsistent. *Suggested remediation:* change `ADR-020@0.1.0` to `ADR-020@0.1.1` in the comment. Can be fixed in any later PR touching this file; no need to block merge.

### Contract compliance (iter-2 re-check)
- [x] PR modifies ONLY files listed in TKT-039@0.1.0 §5 Outputs — iter-2 touch set is `Caddyfile`, `docker-compose.yml`, `.env.example`, `tests/deployment/compose.test.ts`, `tests/deployment/envExample.test.ts`, ticket §10 Execution Log. All within scope.
- [x] No changes to TKT-039@0.1.0 §3 NOT-In-Scope items — no regression.
- [x] No new runtime dependencies — no `package.json` change.
- [x] All Acceptance Criteria from TKT-039@0.1.0 §6 are verifiably satisfied:
  - AC #1: Compose config structure is valid (per executor test run; structure unchanged from iter-1 which passed).
  - AC #2: `docker-compose.cf-tunnel.yml` uses `profiles: ["disabled"]` → `docker compose config` merge will profile-disable caddy ✓.
  - AC #3: `Caddyfile:3-4` — `{$KBJU_PUBLIC_DOMAIN}` ✓, reverse-proxies `/telegram` and `/telegram/*` to `openclaw-gateway:18789` ✓, `/health` returns `"kbju-caddy-ok" 200` (line 6) ✓.
  - AC #4: `docker-compose.yml:128` `restart: unless-stopped` ✓, `depends_on: openclaw-gateway` (lines 113-115) ✓, volumes at lines 108-110 ✓, healthcheck at lines 116-120 ✓.
  - AC #5: Only host bind is `./Caddyfile:/etc/caddy/Caddyfile:ro` (line 108); `caddy_data` and `caddy_config` are named volumes (lines 109-110) ✓.
  - AC #6: Same as AC #3 — verified ✓.
- [x] CI green — executor reports 54/54 deployment tests pass, lint + typecheck clean.
- [x] Definition of Done — code + RV file now on branch; status flip + §10 Execution Log entries complete; iter-2 entry appended to §10.
- [x] Ticket frontmatter `status: in_review` — unchanged from original commit `90cbc88`.

### Commit topology
```
089a658 TKT-039 iter2: ADR-020@0.1.1 upstream port 18789 + caddy logging block (RV-CODE-017 F-H1/F-M1)
22f59c7 RV-CODE-017: review TKT-039 PR #26
90cbc88 TKT-039: ticket status → in_review
7c64f18 TKT-039: Caddy + Let's Encrypt TLS termination + Cloudflare Tunnel overlay
```
The original DoD two-commit split (`7c64f18` code + `90cbc88` status flip) is intact. The iter-2 fixup is a single atomic commit on top. Review RV file is committed. Topology is clean.

### Red-team probes (iter-2 delta)
- **Upstream port:** With the corrected `18789`, Caddy should now reach the OpenClaw gateway's webhook handler. The gateway HEALTHCHECK confirms `http://127.0.0.1:18789/healthz` is the canonical endpoint. No new error surface introduced by the port fix.
- **Observability:** The newly added `logging: json-file` block ensures Caddy logs respect the same rotation policy as other services. A 3am operator can now inspect `docker compose logs caddy` without unbounded disk consumption.
- No other red-team dimensions changed from iter-1.

---

## Iteration 2 verdict
- [x] pass
- [ ] pass_with_changes
- [ ] fail

**One-sentence justification:** Both iter-1 blocking findings (F-H1 port mismatch, F-M1 missing logging block) are resolved; the Caddyfile now correctly proxies to `openclaw-gateway:18789` per ADR-020@0.1.1, and the caddy service has JSON-file log rotation; one new Low finding (stale comment reference) does not block merge.

**Recommendation to PO:** merge — the one remaining Low finding (stale ADR version in a comment) can be fixed opportunistically in any future PR.
