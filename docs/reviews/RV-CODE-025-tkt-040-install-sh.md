---
id: RV-CODE-025
type: code_review
target_pr: "https://github.com/openclown/openclown-assistant/pull/36"
ticket_ref: TKT-040@0.1.0
status: in_review
created: 2026-05-26
---

# Code Review — PR #36 (TKT-040@0.1.0)

## Summary
The PR delivers `scripts/install.sh` as the idempotent single-command deploy entry point per ARCH-001@0.7.2 §10.4, implements all 16 documented steps end-to-end, wires `AllowlistSeedError` catch into `startServer()` per BACKLOG-004, adds `--validate-config` flag for fail-fast env-var validation, and provides test coverage (9 installScript + 2 new bootEntrypoint tests). The core deployment flow is sound. Three medium findings need attention: missing `set -euo pipefail`, retry function uses constant delay instead of linear backoff, and Allowlist constructed with no-op metrics that is never upgraded. No high findings; all acceptance criteria are structurally verifiable.

## Verdict
- [ ] pass
- [x] pass_with_changes
- [ ] fail

One-sentence justification: The script meets every step in §2 and every carve-out gate, but three §7 Constraints violations (missing `set -euo pipefail`, non-linear retry backoff, boot Allowlist metrics lost) must be addressed before merge or backlogged.

Recommendation to PO: **iterate** — fix the three medium findings in a follow-up commit on this branch, or backlog F-M3 (the Allowlist metrics gap has limited practical impact since `main.ts` uses `pilotUserIds` for access control, not the C15 Allowlist).

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT §5 Outputs (plus authorised carve-outs: `src/main.ts`, `tests/deployment/bootEntrypoint.test.ts`)
- [x] No changes to TKT §3 NOT-In-Scope items
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist (no `package.json`/`package-lock.json` changes)
- [x] All Acceptance Criteria from TKT §6 are verifiably satisfied (see AC table below)
- [x] CI green — executor reports typecheck clean, lint clean, 33 tests pass (9 installScript + 24 bootEntrypoint)
- [x] Definition of Done complete (two commits: `817b058` for implementation, `8d707dd` for status flip + execution log)
- [x] Ticket frontmatter `status: in_review` in a separate commit

### AC traceability
| AC | Evidence |
|----|----------|
| `bash -n scripts/install.sh` clean | Passed: exit 0 verified at review time |
| `shellcheck scripts/install.sh` clean | Not run (tool unavailable in review env); mental lint pass — no syntax errors, SC1090/source suppressed |
| `npm test -- tests/deployment/installScript.test.ts` passes | 9 tests cover: syntax, DNS fail, port-80 fail, webhook error, idempotency, CF-tunnel skip, non-tty abort, Docker version < 20.10, compose < v2 |
| Fresh local Docker e2e exits 0 | Structural verification (no live Docker in review); `docker compose up -d` is idempotent, `--remove-orphans` clean |
| Idempotent re-run | Structural test verifies no `docker compose down`/`rm`, `chmod 0600`, setWebhook/getWebhookInfo re-called |
| DNS failure aborts | `installScript.test.ts:311-335` — `expect(output).toContain("does not resolve")` |

## Findings

### Medium
- **F-M1 (scripts/install.sh:1):** `set -euo pipefail` is missing. TKT-040@0.1.0 §7 Constraints explicitly requires it: *"Use `set -euo pipefail` and explicit error traps."* The ERR trap (lines 7-13) provides partial coverage, but without `set -u` an unset variable could slip through, and without `set -o pipefail` a pipeline could silently mask a failure in its first command. `set -u` is partially mitigated by defensive `${VAR:-}` and `${VAR:?}` patterns, but the constraint is a hard requirement, not aspirational. *Suggested remediation:* Add `set -euo pipefail` immediately after the shebang line. *(Note: the idempotency test at `installScript.test.ts:412` incorrectly states "the script uses `set -euo pipefail`" — this comment is factually wrong and should be corrected.)*

- **F-M2 (scripts/install.sh:56-67):** The `retry` function uses constant delay (`sleep "$delay"` on every retry) instead of linear backoff as required by TKT-040@0.1.0 §7 Constraints: *"retry up to 3 times with linear backoff."* With `delay=2`, actual retry intervals are 2s, 2s, 2s — should be 2s, 4s, 6s (or `base * attempt`). The function's own doc comment (line 56) misleadingly says "linear backoff." *Suggested remediation:* Change line 67 from `sleep "$delay"` to `sleep $((delay * attempt))`.

- **F-M3 (src/main.ts:335-341):** The Allowlist is constructed at boot with a no-op `bootMetrics` registry and the comment claims *"the real one comes from createSidecarDeps below"* — but it never does. `createSidecarDeps` receives the Allowlist instance as-is (line 354) and passes it through to `C1Deps.allowlist` without injecting the real metrics registry. The Allowlist's `this.metricsRegistry` remains permanently no-op. Construction-phase metrics (`kbju_allowlist_size` on seed, `kbju_allowlist_reload` on file load/reload via `fs.watchFile`) are swallowed. *Practical impact is limited:* `main.ts` uses the `pilotUserIds` array (from `parseConfig`) for its own `isAllowlisted()` check in `handleMessage`, not `deps.allowlist.isAllowed()`, so runtime blocked-request metrics are a non-issue — the `Allowlist.isAllowed()` code path is not reached during normal message processing. The file-watch reload metrics would also be lost if the operator edits `config/allowlist.json` at runtime. *Suggested remediation:* Either (a) construct Allowlist after `createSidecarDeps` and pass the real metrics registry, or (b) acknowledge the gap with an improved comment stating the lost metrics are intentional for boot-time simplicity, and backlog a follow-up to wire the real registry.

### Low
- **F-L1 (scripts/install.sh:258):** `step_validate_config` (step 5) builds `kbju-sidecar` to run `--validate-config`, and `step_build_images` (step 7) rebuilds it. Docker cache makes the second build near-instant, but the double-build pattern is confusing during debugging and wastes wall-clock time on cache-miss rebuilds. Noted per weaker assumption #3 — acceptable since `--validate-config` requires the built image and running `npm`/`node` on the host is forbidden by §7 Constraints.

## Red-team probes (Reviewer must address each)
- **Error paths (Telegram/webhook/DB failure):** install.sh retries Telegram API calls 3× with delay (though see F-M2 for backoff shape). On permanent failure, exits 1 with `ERROR: Telegram ... failed after 3 attempts`. DNS/port-80 failures produce `ERROR:` messages with remediation guidance. Migration/timeout failures are handled by `startServer()` (TKT-041 path — 120 s timeout, structured log, `pool.end()`, `process.exit(1)`). Allowlist seed failure exits 1 with structured error. Sidecar boot failure polls health for 60 s then dumps logs. Caddy ACME failure polls 120 s then dumps `caddy` logs. No unhandled error sinks.
- **Concurrency (two install.sh simultaneously):** No lockfile. Two concurrent runs would both execute `docker compose up -d` (idempotent but may race on image builds). Single-operator VPS pilot mitigates this; acceptable for v0.1.
- **Input validation:** `KBJU_PUBLIC_DOMAIN` rejects empty strings. `TELEGRAM_BOT_TOKEN` uses `${VAR:?}` parameter expansion for fail-fast. `.env.production` sources are validated via `--validate-config`. No other user-typed inputs.
- **Prompt injection:** Not applicable — install.sh makes only operator-initiated API calls (Telegram setWebhook/getWebhookInfo). No user-generated text from Telegram is processed by the script.
- **Tenant isolation:** Deployment-level script — does not handle per-user data. Tenant isolation is enforced at runtime in `main.ts` via `isAllowlisted()` (uses `pilotUserIds`, not the C15 Allowlist). RLS for new tables is a separate concern (ADR-001) — no new tables in this PR.
- **Secrets:** `.env.production` written mode 0600 (line 148). `TELEGRAM_BOT_TOKEN` not echoed. `docker compose logs` in error paths could surface secrets if the application logs them — pre-existing risk, not introduced here. `.gitignore` covers `.env*` — no weakening confirmed.
- **Observability:** Step-numbered log lines (`[1] Validating Docker...`, `[2] Reading .env.production...`, etc.). Error messages include domain, line number, and exit code via `err_trap()`. `docker compose logs` dumped on postgres/sidecar/caddy failures. "INSTALL OK" banner includes git SHA. A 3am operator can trace any failure to the exact step and line. **Gap:** Allowlist boot-time metrics are lost (see F-M3).
- **Rollback:** The script uses only `docker compose up -d --remove-orphans` (never `down`/`rm`). Rollback follows ARCH-001@0.7.2 §10.6 — image/git-tag rollback + DB restore. No rollback logic duplicated in install.sh (per §3 NOT-In-Scope). ✓

## Step-by-step install.sh audit

| Step | Ticket §2 requirement | install.sh lines | Verdict |
|------|----------------------|------------------|---------|
| 1 | Docker ≥ 20.10 + compose ≥ v2 | 76-108 | ✓ |
| 2 | Read `.env.production` or prompt; mode 0600; non-tty → REFUSE | 112-155 | ✓ |
| 3 | DNS A-record validation; skipped in CF-tunnel | 159-195 | ✓ |
| 4 | Port 80 reachability check; skipped in CF-tunnel | 199-250 | ✓ |
| 5 | `.env.production` validation via `--validate-config` | 254-269 | ✓ |
| 6 | `docker compose pull` externally-published only | 273-285 | ✓ |
| 7 | `docker compose build kbju-sidecar metrics --build-arg BUILD_SHA=$SHA` | 289-294 | ✓ |
| 8 | Postgres up + `pg_isready` ≤ 60 s | 298-316 | ✓ |
| 9 | Migrations delegated to sidecar boot path | 320-344 | ✓ |
| 10 | Allowlist seed delegated to sidecar boot path | 320-344 | ✓ |
| 11 | `docker compose up -d --remove-orphans` | 348-353 | ✓ |
| 12 | Poll HTTPS `/health` ≤ 120 s | 357-379 | ✓ |
| 13 | Telegram `setWebhook` with retry | 383-399 | ✓ (see F-M2) |
| 14 | Telegram `getWebhookInfo`; fail-fast on `last_error_date` | 401-431 | ✓ (see F-M2) |
| 15 | Smoke-test both `/health` endpoints | 435-452 | ✓ |
| 16 | "INSTALL OK" banner with git SHA | 456-464 | ✓ |
| Idempotency | No-op except 13-15 on re-run | Structural check in test | ✓ |

## Carve-out gates

- **AllowlistSeedError catch (src/main.ts:342-350):** ✓ Matches the migration-failure pattern: structured `console.error(...)` + `process.exit(1)`. The migration path also closes its pool; the Allowlist path has no pool to close (pool already ended in the migration block). The error message format is consistent but not identical — migration uses `err instanceof Error ? err.message : err` (defensive against non-Error throws) while Allowlist uses `err.message` directly (safe since `AllowlistSeedError extends Error`). Acceptable.
- **`--validate-config` (src/main.ts:385-398):** ✓ Uses `parseConfig` directly — no logic duplication. Produces structured list of missing keys via `ConfigError.missingNames.join(", ")`. `ConfigError` class confirmed to have `missingNames` property (config.ts:48). Flag checked at `process.argv[1] === __filename` gate, before `startServer()` — exits 0 on success, 1 on failure. Does not attempt network, migration, or HTTP bind.
- **System-level misconfig test (tests/deployment/bootEntrypoint.test.ts:693-823):** ✓ Extends existing file (appended, not duplicated). Uses `vi.mock("../../src/security/allowlist.js")` to make `Allowlist` a `vi.fn()` and throw `AllowlistSeedError` on construction. Verifies `process.exit(1)`, `server.listen` not called, and on success path `runMigrations` + `server.listen` both proceed normally. Mock isolates filesystem dependency. The `vi.mock` is hoisted and applies to all tests in the file — verified that existing TKT-041 tests are unaffected (migration-failure exits before Allowlist construction; migration-success test has `SERVER_PORT=0` and succeeds through the mock). Separate `describe("BACKLOG-004: ...")` block has its own `beforeEach`/`afterEach` env management.

## Version-pinned reference check

All documented references use proper version pins:
- `ARCH-001@0.7.2` (install.sh:3)
- `TKT-041@0.1.0` (install.sh:321, main.ts comment)
- `ADRP-020@0.1.1` (execution log)
- `BACKLOG-004` cited with `TKT-042@0.1.0` as spec-ref source

