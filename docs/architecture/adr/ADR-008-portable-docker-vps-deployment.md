---
id: ADR-008
title: Portable Docker VPS Deployment
status: proposed
arch_ref: ARCH-001@0.2.0
created: 2026-04-26
updated: 2026-04-26
superseded_by: null
---

# ADR-008: Portable Docker VPS Deployment

## Context
PRD-001@0.2.0 §7 locks Telegram, OpenClaw, TypeScript/Node 24, and the PO's self-hosted VPS. PO Q2 states the VPS floor: 6 vCPU, 7.6 GiB RAM, about 5.7 GiB available at idle, 75 GB ext4, Ubuntu 24.04.4, Docker 29.4.0, no GPU. PO Q2 also requires portability: no host-kernel assumptions, no host file paths outside Docker volumes, no systemd-service dependencies, and a VPS migration runbook.

## Options Considered (>=3 real options, no strawmen)
### Option A: Docker Compose with OpenClaw skill containers, Postgres, and named volumes
- Description: Run OpenClaw/KBJU skill services and PostgreSQL under Docker Compose on the VPS. Persist DB data and any runtime state in named Docker volumes. Secrets come from env/runtime secret injection, not committed files.
- Pros (concrete): Matches available Docker 29.4.0 on the VPS. Docker documents volumes as the preferred mechanism for persistent container data, easier to back up or migrate than bind mounts, and independent of container lifecycle (<https://docs.docker.com/engine/storage/volumes/>). Named volumes avoid PO-forbidden host-path coupling.
- Cons (concrete, with sources): Single-host Compose is not high availability. Volume backup/restore must be scripted and tested; Docker volume removal is separate from container removal, so cleanup errors can retain data (<https://docs.docker.com/engine/storage/volumes/>).
- Cost / latency / ops burden: $0 incremental infra; expected steady RAM target under 1.2 GiB for OpenClaw/Node/Postgres/OmniRoute sidecars, leaving margin below the 2 GiB PRD ceiling; medium ops.

### Option B: Host-level Node/OpenClaw process plus host PostgreSQL under systemd
- Description: Install Node 24, OpenClaw, and PostgreSQL directly on the VPS and supervise with systemd.
- Pros: Fewer containers; can be efficient on RAM; standard Linux service management.
- Cons: PO Q2 explicitly forbids systemd-service dependencies and host-path assumptions for portability. Host-installed dependencies make migration and rollback less reproducible.
- Cost / latency / ops burden: $0 infra cost; low runtime overhead; high drift/migration risk.

### Option C: Kubernetes or k3s on the VPS
- Description: Deploy OpenClaw, skills, Postgres, and routing as Kubernetes workloads.
- Pros: Stronger primitives for health checks, rollouts, secrets, and future scale-out.
- Cons: Adds control-plane overhead and YAML/operator surface for a 2-user pilot. No PRD requirement needs multi-node orchestration.
- Cost / latency / ops burden: $0 infra cost but higher CPU/RAM and learning burden; likely unjustified within <=2 GiB steady RAM.

### Option D: Managed PaaS/serverless deployment
- Description: Move the bot skill and DB to managed app hosting or serverless functions.
- Pros: Less VPS maintenance and built-in deployment workflows.
- Cons: Violates the locked self-hosted OpenClaw VPS runtime for v0.1. Also interacts with ADR-007@0.1.0 jurisdiction and may add cost before pilot telemetry.
- Cost / latency / ops burden: Starts at low monthly cost but not $0; lower server ops, higher vendor/platform change.

## Decision
We will use **Option A: Docker Compose with OpenClaw skill containers, Postgres, and named volumes**.

Deployment rules:
- No production data in bind mounts or arbitrary host paths.
- No systemd unit files as the source of truth; Compose is the restart/deploy boundary.
- DB and OpenClaw persistent data are separate named volumes.
- Raw media temp storage is container-local or tmpfs and must not be in a persisted volume.
- Rollback is image/tag based; data rollback is restore-from-volume-backup only, never destructive git reset.

Why the losers lost:
- Option B: It directly conflicts with the PO's portability constraints.
- Option C: Kubernetes is operationally heavier than the 2-user pilot requires.
- Option D: Managed hosting reopens a PO-locked runtime decision and adds jurisdiction/cost surface.

## Consequences
- Positive: The system can be moved to a stronger VPS by copying Docker volume backups plus env/secrets, then starting the same Compose stack.
- Negative / trade-offs accepted: Single-host outage remains possible; v0.1 accepts this because PRD-001@0.2.0 does not require HA.
- Follow-up work: ARCH-001@0.2.0 §10 must include concrete commands for backup, restore, rollback, and VPS migration.

## References
- Docker volumes: <https://docs.docker.com/engine/storage/volumes/>
- Telegram Bot API HTTPS/webhook basics and supported webhook ports: <https://core.telegram.org/bots/api#setwebhook>
- Telegram `sendChatAction` for typing indicator: <https://core.telegram.org/bots/api#sendchataction>
- PO Q2 VPS and portability constraints in the Phase 2 gap report for ARCH-001@0.2.0
