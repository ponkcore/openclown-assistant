---
id: BACKLOG-004
title: Wire AllowlistSeedError into main.ts boot path (system-level AC for TKT-042)
status: open
spec_ref: TKT-042@0.1.0
created: 2026-05-25
---

# BACKLOG-004: AllowlistSeedError → boot-path exit (TKT-042 follow-up)

Carried forward from RV-CODE-013 finding F-M1 (verdict `pass_with_changes`).

## Summary
TKT-042@0.1.0 implemented the C15 Allowlist seed-from-env path, the named `kbju_config` volume, gitignore hygiene, and the seed-test triplet. The class-level AC (`AllowlistSeedError` is thrown when both env var and file are absent) is met. The system-level AC (#5: "Misconfig scenario: with neither env var nor file, boot exits non-zero within 5 s") is NOT yet met because `main.ts` does not catch `AllowlistSeedError` and translate it to `process.exit(1)`.

## Why backlogged (not iterated)
TKT-042@0.1.0 blocks TKT-040@0.1.0 (`install.sh` single-command deploy). TKT-040@0.1.0 already needs to wire the boot path together (migrations + allowlist seed + listen) and is the natural home for the missing wiring. Iterating TKT-042@0.1.0 to add it would either duplicate TKT-040@0.1.0's scope or pre-empt it.

## Follow-up
When dispatching TKT-040@0.1.0, include in the executor prompt:
- Wire `AllowlistSeedError` (or whatever the C15 surface throws) so that `startServer()` catches it, logs structured, and exits non-zero — same shape as the existing migration-failure path that landed in TKT-041@0.1.0.
- Add a system-level test that exercises the misconfig scenario end-to-end (boot the process with no env var and no file → asserts exit code 1 within 5 s).

## Status
- 2026-05-25 BACKLOG-004 opened during TKT-042 close-out.
