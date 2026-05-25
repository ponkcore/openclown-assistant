---
id: ARCH-IMAGES-001
title: Operator-facing image-digest update guide
version: 0.1.0
status: draft
prd_ref: PRD-001@0.3.0
owner: '@po'
arch_ref: ARCH-001@0.7.1
created: 2026-05-26
updated: 2026-05-26
---

# Operator-facing image-digest update guide

Per ARCH-001@0.7.1 §10.2, the runtime topology uses pinned `image@sha256:<digest>` references in `docker-compose.yml`, `docker-compose.cf-tunnel.yml`, and `Dockerfile` to ensure reproducible deploys that do not drift on `docker compose pull`.

## Pinned images

| Service | Image reference | Pinned at |
|---|---|---|
| openclaw-gateway | `ghcr.io/openclaw/openclaw@sha256:dcfd148777401d1bbdc63eab5c2f280bbfa912dfb1818566f9d66bb96ffb3f95` | 2026-05-26 |
| postgres | `postgres@sha256:0027bef26712baaee437a4ea48fdf3d2d2e2bc5f0d81615374408ca320f3c7e3` | 2026-05-26 |
| caddy | `caddy@sha256:86deaf5e3d3408a6ccec08fbb79989783dd26e206ae10bcf78a801dc8c9ab794` | 2026-05-26 |
| cloudflared | `cloudflare/cloudflared@sha256:a5b5e6fd9a372f054b9a843c219bfbcdceb54691605312a8b1ee72978bdf1aa1` | 2026-05-26 |
| Dockerfile base | `node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf` | 2026-05-26 |

All digests are **OCI image-index (multi-arch list) digests**, not per-platform digests. Docker Compose and `docker buildx` automatically select the correct platform (linux/amd64 or linux/arm64) from the index.

## How to update a digest (CVE patch or version bump)

1. **Pull the new tag** to verify it resolves:
   ```bash
   docker pull <image>:<tag>
   ```

2. **Get the multi-arch index digest**:
   ```bash
   docker buildx imagetools inspect <image>:<tag>
   ```
   Look for the `Digest:` line in the output — this is the OCI image-index digest.

3. **Update the compose file or Dockerfile**:
   - For `docker-compose.yml` / `docker-compose.cf-tunnel.yml`: replace the `image: <name>@sha256:<old-digest>` line with the new digest.
   - For `Dockerfile`: replace the `FROM <image>@sha256:<old-digest>` line with the new digest.

   Use the canonical `image@sha256:<digest>` form (no `:tag` prefix before `@sha256:`). The tag is unnecessary noise; the digest uniquely identifies the image.

4. **Verify locally**:
   ```bash
   docker compose pull
   docker compose config
   ```

5. **Commit the change** with a message noting the image and reason (e.g. `chore: bump postgres digest for CVE-2026-XXXX`).

## Constraints

- Every digest must be independently retrievable from a public registry at PR-merge time (ARCH-001@0.7.1 §7 Operational Constraints).
- Never use `:latest` or any tag-only reference in production compose files — always pin to a digest.
- For multi-arch images, always use the image-index digest (what `docker buildx imagetools inspect` returns), not a per-platform manifest digest. This ensures both amd64 and arm64 hosts resolve correctly.
