---
id: TKT-042
title: Allowlist seed from TELEGRAM_PILOT_USER_IDS + persistent volume bind
status: ready
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: C15 Allowlist / Deployment
depends_on: []
blocks:
- TKT-040@0.1.0
estimate: S
created: 2026-05-25
updated: 2026-05-25
---

# TKT-042: Allowlist seed from TELEGRAM_PILOT_USER_IDS + persistent volume bind

## 1. Goal
Make `config/allowlist.json` seed itself from `TELEGRAM_PILOT_USER_IDS` on first boot if absent, and persist via a Docker named volume so re-deploys do not lose operator-edited entries.

## 2. In Scope
- C15 Allowlist (existing — TKT-020@0.1.0 outputs) extends its boot path: if `config/allowlist.json` is missing, seed it from the `TELEGRAM_PILOT_USER_IDS` env var (comma-separated numeric IDs) and atomically write the file using the existing tmp-then-rename pattern. If both are unset, log an error and refuse to start (an empty allowlist + no env var is operator misconfiguration; not a silent default).
- After seeding, the file is operator-editable for hot-reload (existing ADR-013@0.1.0 path unchanged).
- `docker-compose.yml`: bind `config/` into the `kbju-sidecar` service via a named volume `kbju_config` mounted at `/app/config` so files survive container recreation. The bind direction is explicitly: the container reads `/app/config/allowlist.json`; operator edits the host-side equivalent. To avoid layering the seed on a stale image, the seed step writes to the named-volume path, not the image's COPY-of-config (the image MUST NOT bake `config/allowlist.json`).
- `.gitignore`: ensure `config/allowlist.json` is gitignored (it is operator data); ensure `config/llm.json` is gitignored too (TKT-033@0.1.0 sets this; this ticket verifies).
- A startup test in `tests/deployment/allowlistSeed.test.ts` (or extend existing) asserting:
  - On a fresh container with `TELEGRAM_PILOT_USER_IDS=123,456` and no `config/allowlist.json`, the seed writes the file and the in-memory `Set` contains both IDs.
  - When `config/allowlist.json` already exists, the seed does NOT overwrite it.
  - When both `TELEGRAM_PILOT_USER_IDS` and the file are absent, boot exits non-zero with a clear error.

## 3. NOT In Scope
- Replacing the C15 Allowlist's hot-reload mechanism (ADR-013@0.1.0 unchanged).
- Adding an admin UI for allowlist edits (PRD-001@0.3.0 §3 NG5 forbids).
- Migrating from `TELEGRAM_PILOT_USER_IDS` to a different env-var name.
- Removing `TELEGRAM_PILOT_USER_IDS` from `.env.example` — kept for the seed path; deprecation removal is a future ticket if/when the seed step retires.

## 4. Inputs
- ARCH-001@0.7.0 §3.15 C15, §9.6 Allowlist Configuration, §10.4 Deploy Sequence
- ADR-013@0.1.0 (existing allowlist topology)
- TKT-020@0.1.0 outputs (existing C15 implementation)
- Existing `docker-compose.yml`
- Existing `.env.example`
- Existing `.gitignore`

## 5. Outputs
- [ ] C15 Allowlist boot path extended in `src/access/allowlist.ts` (or wherever it lives) with the seed-from-env logic per §2.
- [ ] `docker-compose.yml` updated with the `kbju_config` named volume and the `kbju-sidecar` `volumes:` mount.
- [ ] `.gitignore` includes `config/allowlist.json` and `config/llm.json`.
- [ ] `tests/deployment/allowlistSeed.test.ts` (new or extension) asserting all three behaviours in §2.
- [ ] Update of `config/allowlist.example.json` (existing) if needed to reflect any schema notes the seed adds.

## 6. Acceptance Criteria
- [ ] `npm test` passes.
- [ ] `npm run lint` clean. `npm run typecheck` clean.
- [ ] Fresh-VPS scenario (Docker-in-Docker harness OK): `TELEGRAM_PILOT_USER_IDS=123,456 docker compose up -d kbju-sidecar` produces a `config/allowlist.json` inside the named volume containing both IDs and the sidecar accepts those Telegram IDs.
- [ ] Re-deploy scenario: with an existing operator-edited `config/allowlist.json`, the seed step is a no-op and operator edits survive `docker compose up -d --force-recreate kbju-sidecar`.
- [ ] Misconfig scenario: with neither env var nor file, boot exits non-zero within 5 s with a structured error.

## 7. Constraints
- The seed step uses atomic file write (write tmp, rename) — same as ADR-013@0.1.0 §3.
- `TELEGRAM_PILOT_USER_IDS` parsing uses the existing parser from C15 (TKT-020@0.1.0); do not duplicate.
- Do NOT mark `TELEGRAM_PILOT_USER_IDS` deprecated in this ticket; the seed step keeps using it as a first-boot bootstrap. Future deprecation is its own decision.
- The named volume MUST be `kbju_config`, not a host bind mount (ADR-008@0.1.0 forbids host bind mounts for production data).

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->
