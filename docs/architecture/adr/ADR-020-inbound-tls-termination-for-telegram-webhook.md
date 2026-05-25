---
id: ADR-020
title: Inbound TLS termination for Telegram webhook (Caddy default; Cloudflare Tunnel
  override)
version: 0.1.1
status: proposed
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
created: 2026-05-25
updated: 2026-05-25
superseded_by: null
---

# ADR-020: Inbound TLS termination for Telegram webhook

## Context

The current `docker-compose.yml` exposes nothing on the public host. Telegram Bot API
(<https://core.telegram.org/bots/api#setwebhook>) requires:

> The webhook URL must be HTTPS. Telegram supports four ports: 443, 80, 88 and 8443
> (the certificate's CN must match the URL host or the IP if no host).

So the VPS needs:

1. A public DNS name pointing at it (PO confirms `KBJU_PUBLIC_DOMAIN` at install time).
2. An ACME-issued TLS cert for that domain.
3. A reverse proxy that terminates TLS and forwards `POST /telegram` to the OpenClaw
   Gateway's webhook handler on the internal Docker network.

PRD-001@0.3.0 §7 hands the operator the `./scripts/install.sh` single-command path
(ADR-020 §10.4). That path needs to come up to a working HTTPS endpoint without a
post-install certificate-management ritual.

PO has explicitly chosen **Caddy with automatic Let's Encrypt** as the default
(per dispatch). PO will provide the domain at install time; DNS A-record pointing to
the VPS public IP must exist BEFORE `install.sh` runs (HTTP-01 ACME challenge cannot
succeed otherwise); ports 80 and 443 must be open on the VPS firewall.

Cloudflare Tunnel is a documented override path for operators who want to skip the
public-IP / ACME / firewall flow (e.g. NAT-bound VPS, no public IPv4, or a CF-fronted
zone trust boundary). It must be enabled by an explicit compose overlay file
(`docker-compose.cf-tunnel.yml`), not as the default.

## Options Considered (≥3 real options, no strawmen)

### Option A: Caddy + automatic Let's Encrypt as a Compose service

- Description: Add a `caddy` service to `docker-compose.yml`. Caddy listens on
  `:80` (HTTP-01 challenge + redirect-to-443) and `:443` (HTTPS termination), proxies
  `POST /telegram` to `openclaw-gateway` on the internal Docker network. `Caddyfile`
  is a 5-line config. Caddy obtains and renews Let's Encrypt certs automatically
  (<https://caddyserver.com/docs/automatic-https>).
- Pros (concrete):
  - PO-chosen default per dispatch; matches the operator's stated preference.
  - Caddy's automatic-HTTPS is the canonical Caddy design (<https://caddyserver.com/docs/automatic-https>),
    not a third-party plugin. Cert provision + renewal Just Works given the DNS
    A-record + port 80 + 443 invariants.
  - Single binary, single config file, deterministic startup. Healthcheck via `curl
    https://<domain>/health` once Caddy is up.
  - Compose-native — `caddy_data` named volume preserves issued certs across
    container restarts (avoid LE rate limits).
- Cons (concrete):
  - DNS A-record is a hard prerequisite; operator must point DNS at the VPS BEFORE
    install.sh. install.sh validates the A-record + port 80 reachability before
    bringing the stack up (failure mode: clear error and abort).
  - Adds one container to the compose stack; adds 80 / 443 to the public attack
    surface (matters when threat model assumes lock-down).
  - LE rate limits (5 duplicate certs/week, 50 certs/week per registered domain —
    <https://letsencrypt.org/docs/rate-limits/>) are a real failure mode on
    repeated install.sh runs against the same domain. Mitigation: `caddy_data`
    volume persists; install.sh is idempotent (§10.4) and won't re-issue if a valid
    cert is in the volume.
- Cost / latency / ops burden: low — one new container, one new volume.

### Option B: Cloudflare Tunnel (cloudflared) as the default

- Description: Replace public-port exposure entirely. `cloudflared` connects out to
  Cloudflare; CF terminates TLS at the edge; the VPS doesn't open ports 80 / 443.
  Operator runs `cloudflared tunnel login` once and registers a hostname.
- Pros (concrete):
  - VPS firewall stays closed. Useful for NAT-bound VPSes or when the operator wants
    a CF-fronted security perimeter (DDoS protection, WAF, etc.).
  - No ACME / port-80 dependency on the VPS.
- Cons (concrete):
  - Adds a Cloudflare account + tunnel registration to the operator path. PO is
    explicit: this is an override, not the default; install.sh's happy path must work
    without a Cloudflare account.
  - Tunnel state (token, cert) must persist; `cloudflared` config file ships the
    tunnel token, which is a runtime secret.
  - Outbound dependency on Cloudflare's edge network; not a problem most of the
    time but a different threat model than a self-managed Caddy.
- Cost / latency / ops burden: medium — adds an external account + tunnel
  registration ritual.

### Option C: Manual nginx + Certbot

- Description: Run nginx in a container, run Certbot manually, mount the certs into
  nginx, set up a renewal cron.
- Pros: maximally explicit; nginx is well-understood.
- Cons:
  - Multi-step setup (Certbot install, ACME challenge, cert mount, renewal cron)
    that breaks install.sh single-command goal.
  - Two services (nginx + Certbot) doing what one Caddy service does.
- Cost / latency / ops burden: medium-high — operator-maintained renewal cron is a
  long-tail failure surface.

### Option D: Telegram setWebhook with a self-signed cert

- Description: Telegram allows webhook with a self-signed cert if you upload the
  public certificate body. No CA, no DNS A-record requirement.
- Pros: no ACME, no public DNS dependency.
- Cons:
  - Operator has to generate the cert, upload its public key to Telegram via
    setWebhook's `certificate` parameter, and rotate annually.
  - Self-signed certs trip every browser and most monitoring tools; debugging the
    deploy from a laptop becomes harder.
  - Not a fit for production-quality pilot; we want a real cert and a real
    domain.
- Cost / latency / ops burden: low at compose time; high at debugging time.

## Decision

We will use **Option A: Caddy + automatic Let's Encrypt as a Compose service** as the
default install.sh path. **Option B: Cloudflare Tunnel** is documented as a
first-class override via a compose overlay file (`docker-compose.cf-tunnel.yml`).

### Default path (Caddy)

`docker-compose.yml` adds a `caddy` service:

```yaml
caddy:
  image: caddy:2-alpine@sha256:<digest>
  ports:
    - "80:80"
    - "443:443"
  volumes:
    - ./Caddyfile:/etc/caddy/Caddyfile:ro
    - caddy_data:/data
    - caddy_config:/config
  environment:
    KBJU_PUBLIC_DOMAIN: ${KBJU_PUBLIC_DOMAIN}
  depends_on:
    openclaw-gateway:
      condition: service_started
  networks:
    - internal
  restart: unless-stopped
```

`Caddyfile` (the literal file, written by TKT-039@0.1.0):

```
{$KBJU_PUBLIC_DOMAIN} {
  encode zstd gzip
  reverse_proxy /telegram openclaw-gateway:18789
  reverse_proxy /telegram/* openclaw-gateway:18789
  handle /health {
    respond "kbju-caddy-ok" 200
  }
}
```

The exact upstream port (`openclaw-gateway:18789` above) and the `/telegram` path
mirror the OpenClaw gateway's existing webhook surface; if a future PR moves the
gateway port, the Caddyfile path moves with it.

**Invariants:**

- Caddy's `caddy_data` volume persists `/data` (Let's Encrypt account + issued
  certs); without this, repeat installs hit LE rate limits.
- `KBJU_PUBLIC_DOMAIN` is required in `.env.production` before install.sh runs.
- DNS A-record for `KBJU_PUBLIC_DOMAIN` MUST resolve to the VPS public IPv4 BEFORE
  install.sh. install.sh validates this with `dig +short <domain>` against
  `curl ifconfig.me`.
- Ports 80 and 443 MUST be open on the VPS firewall (UFW / cloud-provider security
  group). install.sh validates port-80 reachability via a self-loopback check before
  starting Caddy.

### Override path (Cloudflare Tunnel)

`docker-compose.cf-tunnel.yml` is a compose overlay file:

```yaml
services:
  caddy:
    profiles: ["disabled"]    # disables Caddy when the overlay is active

  cloudflared:
    image: cloudflare/cloudflared:latest@sha256:<digest>
    command: tunnel --no-autoupdate run --token ${CLOUDFLARED_TUNNEL_TOKEN}
    restart: unless-stopped
    networks:
      - internal
```

Operator activates the override with:
`docker compose -f docker-compose.yml -f docker-compose.cf-tunnel.yml up -d`.

The tunnel routes the public CF hostname to `openclaw-gateway:18789/telegram` via CF's
ingress rules (configured at the Cloudflare dashboard, not in this compose file —
PRD-001@0.3.0 §3 NG5 forbids admin web UIs in v0.1, but this is the operator's CF
dashboard, not the application's).

### install.sh path

ADR-020 §10.4 install.sh enforces the Caddy invariants by default:

1. Validates `KBJU_PUBLIC_DOMAIN` is set.
2. Resolves DNS for `KBJU_PUBLIC_DOMAIN`; compares to public IP via `curl
   https://api.ipify.org` (tolerant of CDN-fronted addresses; warns if mismatch).
3. Tests port 80 self-reachability (binds a temporary listener on `:80`, opens a
   loopback request).
4. Runs `docker compose up -d caddy openclaw-gateway`.
5. Polls `https://<KBJU_PUBLIC_DOMAIN>/health` until 200 (cert issuance can take 30–
   90 s on first run).
6. Calls Telegram `setWebhook` with `https://<KBJU_PUBLIC_DOMAIN>/telegram`.
7. Calls `getWebhookInfo`; fails fast on `last_error_date != null`.

Override mode is selected by `INSTALL_TLS_MODE=cloudflare-tunnel` in
`.env.production`; install.sh skips DNS / port validation and uses the
docker-compose overlay file instead.

## Why the losers lost

- **Cloudflare Tunnel as default:** operator-account dependency conflicts with the
  PO's stated preference for Caddy + auto-LE; preserved as a documented override.
- **Manual nginx + Certbot:** more pieces, longer install.sh, no advantage over
  Caddy's auto-HTTPS in single-domain pilot.
- **Self-signed cert:** operator UX is hostile; Telegram tooling and curl debugging
  break.

## Consequences

**Positive:**

- One reverse-proxy container, one Caddyfile, real public TLS cert, automatic
  renewal. Matches PO preference.
- install.sh single-command path produces a working HTTPS endpoint without
  certificate-management rituals.
- CF-Tunnel operators have a documented, supported override; not a hack.

**Negative / trade-offs accepted:**

- Caddy adds attack surface (open ports 80 / 443). LE rate limits are a documented
  failure mode on aggressive re-installs; mitigated by `caddy_data` volume + install.sh
  idempotency.
- DNS A-record + ports 80 / 443 are install-time prerequisites the operator must
  satisfy; install.sh validates them with clear errors.

**Follow-up work:**

- TKT-039@0.1.0 implements the `caddy` service, `Caddyfile`, `docker-compose.cf-tunnel.yml`
  overlay, and the README guidance for both modes.
- TKT-040@0.1.0 implements `install.sh`, including the DNS / port-80 / setWebhook
  validation flow.
- TKT-043@0.1.0 pins the `caddy:2-alpine` image to a digest (per dispatch B6).

## References

- PRD-001@0.3.0 §7 (single-command install path)
- ADR-008@0.1.0 (Docker Compose VPS deployment — extended additively)
- Telegram setWebhook reference: <https://core.telegram.org/bots/api#setwebhook>
- Caddy automatic HTTPS: <https://caddyserver.com/docs/automatic-https>
- Caddy Docker image: <https://hub.docker.com/_/caddy>
- Let's Encrypt rate limits: <https://letsencrypt.org/docs/rate-limits/>
- Cloudflare Tunnel docs: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
- cloudflared Docker image: <https://hub.docker.com/r/cloudflare/cloudflared>

## Revision Log

- 2026-05-25 — 0.1.1: corrected upstream port from 8080 to 18789 in §Default path Caddyfile (lines 157-158), §Default path prose (line 165), and §Override path tunnel target (line 201) to match the OpenClaw gateway runtime contract (HEALTHCHECK http://127.0.0.1:18789/healthz, CLI --port 18789 default, canonical -p 18789:18789 exposure in upstream docker-compose.yml). Drift surfaced by RV-CODE-017 F-H1 against TKT-039@0.1.0. Patch-level: no design change.
