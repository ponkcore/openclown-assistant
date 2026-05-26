---
id: RV-CODE-023
type: code_review
target_pr: "https://github.com/code-yeongyu/openclown-assistant/pull/34"
ticket_ref: TKT-045@0.1.0
status: in_review
created: 2026-05-26
---

# Code Review — PR #34 (TKT-045@0.1.0)

## Summary

The PR delivers `scripts/diag-bundle.sh` per ADR-021@0.1.0 §`diag-bundle.sh` contract — a 152-line bash script that collects a redacted incident tarball from the VPS, backed by a thin `src/incident/redactStream.ts` Node.js wrapper that pipes Docker logs through the existing `redactPii` allowlist. Tests are thorough (14 passing, covering both the Node helper and shell script via mocked docker/curl), typecheck is clean, and the two-commit split is correct. However, a **critical SQL injection vector** blocks merge: the operator-provided `TELEGRAM_USER_ID` argument is string-interpolated into three `\COPY` SQL queries with no numeric validation whatsoever, violating §7 Constraints ("write the SQL queries explicitly so reviewers can audit" — which implicitly forbids unsanitised interpolation).

## Verdict

- [ ] pass
- [ ] pass_with_changes
- [x] fail

One-sentence justification: F-H1 (SQL injection via unvalidated TELEGRAM_USER_ID into `\COPY` queries) is a verifiable information-disclosure risk that violates the implicit security contract of §7 Constraints — must be fixed before merge.

Recommendation to PO: **iterate** — have the Executor add a numeric regex guard before any `TELEGRAM_USER_ID` use, then re-submit for iteration 2.

## Contract compliance (each must be ticked or marked finding)

- [x] PR modifies ONLY files listed in TKT §5 Outputs. Changed: `scripts/diag-bundle.sh` (+152 new, 755), `src/incident/redactStream.ts` (+69 new), `tests/incident/diagBundle.test.ts` (+462 new), the assigned ticket file TKT-045@0.1.0 (frontmatter + §10 append). All match §5. `.gitignore` already had `/incidents/` on `origin/main` (line 56); no modification needed.
- [x] No changes to TKT §3 NOT-In-Scope items. No upload step, no Telegram alert, no raw audio/photo bytes. Script does not reach into any audio/photo storage path. Verified via `grep -rn "audio|photo|curl.*POST|Telegram.*alert" scripts/diag-bundle.sh` — no hits.
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist. `package.json`/`package-lock.json` unchanged. Only Node.js built-ins used in `redactStream.ts`.
- [ ] All Acceptance Criteria from TKT §6 are verifiably satisfied — **blocked by F-H1**: §6 AC #4 (manual smoke with user_id) exercises the `\COPY` queries; unvalidated interpolation into them means the condition "No raw user text in any file inside the tarball" cannot be guaranteed when the operator passes a malicious/typo'd argument.
  - §6 AC #1 (`bash -n` clean): ✅ verified — `bash -n scripts/diag-bundle.sh` PASS.
  - §6 AC #2 (`shellcheck` clean): shellcheck not available in sandbox; manual lint pass performed (see F-M1 note on FG-H3 below). All other shell hygiene aspects pass.
  - §6 AC #3 (`npm test -- tests/incident/diagBundle.test.ts` passes): ✅ verified — 14/14 tests pass.
  - §6 AC #4 (manual smoke): tarball invocation (`tar -czf` on line 145) and `chmod 0600` on line 146 verified by static analysis; test at line 394-403 verifies mode check.
  - §6 AC #5 (no raw user text): SELECT lists verified via static analysis (lines 443-449 in test) — forbidden columns excluded by name. RedactStream test at lines 148-213 verifies `redactPii` drops all 19 forbidden fields from the fixture.
  - §6 AC #6 (tarball mode 0600): ✅ `chmod 0600 "${WORK_DIR}/${INC_DIR}.tgz"` at line 146; test at line 374-404 verifies stat mode.
- [x] CI green (lint, typecheck, tests, coverage). Typecheck: `tsc --noEmit` clean (no output). Tests: 14/14 diagBundle passes; 48/48 diagHandler passes (no regression on TKT-044@0.1.0).
- [ ] Definition of Done complete — **blocked by F-H1**: AC #4/#5 cannot be fully satisfied while the `\COPY` queries accept unvalidated input.
- [ ] Ticket frontmatter `status: in_review` in a separate commit. Commit `880baaf` flips `ready → in_review` and appends §10. This is the second commit after `012c5c1` (code). However, the status flip commit also appends §10 Execution Log — DoD says "separate commit" which implies *only* the status change, not extra content. ⚠ See F-M2 below.

## Findings

### High (blocking)

- **F-H1 (`scripts/diag-bundle.sh:31,123,131,139`)**: **SQL injection via unvalidated TELEGRAM_USER_ID.** The operator-provided `$1` is captured at line 31 (`TELEGRAM_USER_ID="${1:-}"`) and then string-interpolated directly into three `\COPY` SQL queries:

  - Line 123: `` `WHERE user_id = '${TELEGRAM_USER_ID}'` `` in `metric_events`
  - Line 131: `` `WHERE user_id = '${TELEGRAM_USER_ID}'` `` in `cost_events`
  - Line 139: `` `WHERE user_id = '${TELEGRAM_USER_ID}'` `` in `audit_events`

  No numeric validation is performed before interpolation. The only guard is `[[ -n "${TELEGRAM_USER_ID}" ]]` at line 116 — which accepts any non-empty string.

  **Exploit example:** `` `./scripts/diag-bundle.sh "1' OR '1'='1"` `` would construct:
  ```sql
  \COPY (SELECT ... FROM metric_events WHERE user_id = '1' OR '1'='1' ... ) TO STDOUT WITH CSV HEADER
  ```
  This bypasses the per-user filter and **exfiltrates all rows** from all three tables into the tarball — including data from the second pilot user. An operator typo or paste error transforms a targeted diagnostic into a full information disclosure.

  **Remediation:** Insert validation **before line 33** (before `INC_DIR` variable construction or any use):
  ```bash
  if [[ -n "${TELEGRAM_USER_ID}" ]] && [[ ! "${TELEGRAM_USER_ID}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: telegram_user_id must be numeric, got '${TELEGRAM_USER_ID}'" >&2
    exit 1
  fi
  ```

  This must execute before the `INC_DIR` assignment, before `ARGS_JSON` construction (which would also produce invalid JSON), and before any `\COPY` command. Validate once, early.

  *Responsible role:* Executor. *Suggested remediation:* Add the regex guard as shown above. The test at lines 315-371 already exercises the user_id path; add a test case passing `1'--` (or similar) to assert the script exits non-zero.

### Medium

- **F-M1 (`src/incident/redactStream.ts:27-30`, repeat of RV-CODE-022 F-M1):** **`error_code` carrier-key fragility.** The `redactStringValue` function wraps arbitrary strings under `error_code` to pass them through `redactPii`'s allowlist (`ALLOWED_EXTRA_KEYS`). This is the same structural pattern flagged in RV-CODE-022 F-M1 (`diagHandler.ts:180-184`). If `error_code` is ever removed from `ALLOWED_EXTRA_KEYS`, all non-JSON-line redaction in `redactStream.ts` silently breaks (the `typeof redacted === "string"` guard at line 30 would catch the worst case — dropping to the unredacted original — but the result is still a silent failure of the redaction contract).

  *Severity rationale:* Same as RV-CODE-022 F-M1 — deferred there, not gating. Here too it's a latent risk, not a current functional failure. The `error_code` key is stable in `ALLOWED_EXTRA_KEYS` (line 51 of `events.ts`). Backlogged.

- **F-M2 (assigned ticket TKT-045@0.1.0, commit `880baaf`):** **Status flip commit bundles §10 Execution Log.** The DoD checklist box says "Ticket frontmatter `status: in_review` in a separate commit." The second commit (`880baaf`) flips `status: ready → in_review` and also appends §10 Execution Log entries. The intent of "separate commit" is that the status-flip commit is atomic and *only* contains the status change, making it trivially reverting. Including §10 additions in the same commit muddies the commit boundary.

  *Severity rationale:* DoD process hygiene — not a code defect. The status flip and log entries are both ticket-file-only, so this is a borderline finding. Medium for strict process compliance.

### Low

- **F-L1 (`scripts/diag-bundle.sh:56`): Hardcoded `REDACTION_SCHEMA_VERSION="1"`.** The script hardcodes the schema version string `"1"`, matching the current `LOG_SCHEMA_VERSION` in `src/observability/kpiEvents.ts:121`. If `kpiEvents.ts` bumps the schema version (e.g. `"2"`), the shell script would report a stale value in `manifest.json`. The `APP_VERSION` is fetched dynamically via `docker compose exec` — the schema version should be too, or a comment should warn of the cross-reference.

- **F-L2 (`scripts/diag-bundle.sh:96-100`): Silently masked redactStream failures.** The for-loop's `|| true` on line 99 gracefully handles Docker failures, but if `redactStream.js` is missing from the container image (old deployment), the pipe fails silently and produces an empty log file with no indication in the script's output. A `2>/dev/null` on the `docker compose exec` command in `REDACT_CMD` (line 48) or a post-hoc file-size check would make the failure visible.

- **F-L3 (`src/incident/redactStream.ts:51-53`): Chunk splitting across line boundaries.** The stream processing splits each chunk by `\n` and processes lines independently. If a very long log line (e.g., a deeply nested JSON object) spans two `stdin` chunks, the line is bisected — the first fragment is redacted as incomplete JSON (falling through to `redactStringValue`), and the second fragment is redacted as a separate non-JSON line. In practice, this is unlikely with typical Docker log line lengths (~1-4 KB), but it's a robustness edge case.

- **F-L4 (`scripts/diag-bundle.sh:70`): Unquoted ARGS_JSON insertion into heredoc.** `${ARGS_JSON}` is inserted into the manifest heredoc without surrounding quotes (`"args": ${ARGS_JSON},`). Currently safe because TELEGRAM_USER_ID can only be `""` (empty, producing `[]`) or numeric (producing `["<digits>"]`). The F-H1 fix (numeric validation) eliminates the injection concern here too, but the heredoc would benefit from quoting for defence-in-depth.

## Red-team probes (Reviewer must address each)

- **Error paths (Telegram/Whisper/Qwen-VL/OmniRoute/USDA-FDC/Postgres failure, DB lock, LLM timeout):**
  - `getWebhookInfo.json`: curl failure → writes `{}` (line 107). Token does not leak — curl passed `-s` (silent mode), and `|| echo "{}"` overwrites the file on failure.
  - Health checks: each curl/docker command has `|| echo "FAILED"` (lines 83,86,89). Partial health failures don't abort the bundle.
  - DB queries: `2>/dev/null || echo ""` produces empty CSV files on Postgres failure (lines 124,132,140). Non-destructive.
  - Docker logs: `|| true` on line 99 prevents the loop from aborting on individual service failure. Silent — see F-L2.
  - docker-compose-ps.txt: `|| true` on line 77.
  - Overall: the script is defensively coded to collect what it can. Failures produce empty/missing files but never crash the bundle.

- **Concurrency (two messages from same user, two from different users simultaneously):**
  - The script runs on the VPS host, not inside the container. No concurrency with user messages. Multiple operator invocations of the script create distinct `INC-<UTC-timestamp>` directories (timestamp is second-level precision with `%H-%MZ` — two invocations within the same minute could collide, but the odds are negligible for an operator tool). No shared state or locking needed.

- **Input validation:**
  - **CRITICAL GAP (F-H1):** TELEGRAM_USER_ID has no numeric validation — the only input validation is `[[ -n ... ]]`. This is the root cause of F-H1. All other inputs (env vars) are validated at startup with `: "${VAR:?...}"` — good.
  - Docker log redaction: malformed/corrupt log lines are caught by the `try/catch` in `processLine` (line 38-45) and fall through to regex-based PII redaction on the raw string. No crash.

- **Prompt injection (external user text reaching an LLM unsanitised):**
  - This script does not send any text to an LLM. It runs entirely on the host and pipes Docker logs through `redactPii`. No LLM call surface.
  - The `redactPii` function is the same allowlist used at runtime (TKT-015@0.1.0 + TKT-026@0.1.0). The redactStream test at line 148-213 verifies all 19 forbidden fields are dropped from a rich fixture and 2 PII regex patterns are applied.

- **Tenant isolation (per-user_id boundary, RLS):**
  - The `\COPY` queries use `WHERE user_id = '${TELEGRAM_USER_ID}'` — but without validation (F-H1), this filter is trivially bypassed. With validation (numeric regex), the filter is structurally sound for single-user scoping. RLS is not relevant here because the script connects as the Postgres superuser (`POSTGRES_USER`).

- **Secrets (credentials committed, logged, or surfaced in errors):**
  - No credentials committed — only `scripts/diag-bundle.sh`, `src/incident/redactStream.ts`, `tests/incident/diagBundle.test.ts`.
  - `TELEGRAM_BOT_TOKEN` is read from the environment (line 25), not stored in the bundle. The `getWebhookInfo.json` URL contains the token but the response body does not; curl's error messages (with `-s`) do not include the full URL.
  - `.env.example` — no new env vars beyond existing ones (POSTGRES_USER, POSTGRES_DB, etc.). `BUILD_SHA` was already required by prior work (TKT-044@0.1.0).

- **Observability (3am operator incident debugging):**
  - The script prints exactly one line: `"Incident bundle written to incidents/INC-<timestamp>.tgz"` (line 152). No progress output, no per-step feedback. If the script hangs (Docker daemon unresponsive), the operator has no indication of which step stalled. Adding `echo` statements before each collection step would make the script noticeably debuggable at 3am. Low severity — the operator has `^C` and can inspect the staging directory.

- **Rollback:**
  - If this PR breaks production: the script is standalone and has no runtime dependency (it is not called by the bot itself). Rollback is a `git revert` of the two commits. The only persistent effect is the `incidents/` directory on the VPS — operator-managed, not managed by Docker. Trivial to roll back.

## Additional notes

- **`redactStream.ts` re-use verification:** The wrapper correctly imports `redactPii` from `"../observability/events.js"` (line 16) — the same function used by `diagHandler.ts` (line 21) and `buildLogEvent` (line 146). No re-implementation. ✅
- **`redactPii` not re-implemented in shell:** The script invokes `redactStream.js` via `docker compose exec -T kbju-sidecar node /app/dist/src/incident/redactStream.js` (line 48). No `sed` regex redaction — test at line 452-456 verifies this. ✅
- **No `.env*`, `config/llm.json`, `config/allowlist.json` in bundle:** Static analysis test at lines 425-441 verifies the script doesn't copy any config files into the staging directory. ✅
- **No raw audio/photo bytes:** Script does not reference any audio or photo paths. The SQL SELECT lists exclude `raw_audio`, `raw_photo`, `raw_description`, `raw_text`, `transcript_text`, `meal_text`, and `comment_text` by name. ✅
- **`umask` approach:** The script does not set `umask` but applies explicit `chmod 0700` on the `incidents/` directory (line 39) and `chmod 0600` on the tarball (line 146). Acceptable — the tarball is created before `chmod`, creating a brief TOCTOU window, but the machine is operator-controlled. ✅
