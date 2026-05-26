---
id: TKT-045
title: 'scripts/diag-bundle.sh (operator-side incident bundle)'
status: in_review
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: scripts / IncidentDiagnostic
depends_on:
- TKT-044@0.1.0
blocks: []
estimate: S
created: 2026-05-25
updated: 2026-05-25
---

# TKT-045: scripts/diag-bundle.sh (operator-side incident bundle)

## 1. Goal
Implement `scripts/diag-bundle.sh <telegram_user_id?>` that collects a redacted, self-contained incident archive at `incidents/INC-<UTC-timestamp>.tgz` per ADR-021@0.1.0 §`diag-bundle.sh` contract.

## 2. In Scope
The script (bash, runs on the VPS host) produces a tarball with the layout in ADR-021@0.1.0 §`diag-bundle.sh` contract:

```
INC-<UTC-timestamp>/
  manifest.json
  docker-compose-ps.txt
  healthchecks.txt
  docker-logs/{kbju-sidecar,openclaw-gateway,caddy,postgres}.log
  telegram/getWebhookInfo.json
  db/{metric_events,cost_events,audit_events}.csv   # only when telegram_user_id provided
```

- `manifest.json` carries `version`, `build_sha`, `generated_at_utc`, `args`, `redaction_schema_version`.
- Docker logs are collected via `docker compose logs --since=30m <service>` and piped through the SAME `redactPii` helper used at runtime (NOT a re-implementation in shell). The shell script invokes a thin Node wrapper (`node dist/src/incident/redactStream.js` or equivalent that TKT-044@0.1.0's outputs add as a side helper, or that this ticket adds as a small standalone) to perform redaction; raw shell `sed` regex redaction is forbidden because the allowlist is the source of truth.
- `healthchecks.txt`: concatenated output of `curl -fsS http://localhost:3000/kbju/health`, `curl -fsS https://${KBJU_PUBLIC_DOMAIN}/health`, `docker compose exec -T postgres pg_isready -U $POSTGRES_USER`.
- `telegram/getWebhookInfo.json`: live `curl -fsS https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo`.
- `db/*.csv` (only when `<telegram_user_id>` is provided): `docker compose exec -T postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -c "\COPY (SELECT ... WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200) TO STDOUT WITH CSV HEADER"`. The CSV columns are pre-redacted at the SQL level (no `meal_text`, no `comment_text`, no `raw_text`, no `raw_description`, no `transcript_text`).
- Tarball file mode: `0600`; `incidents/` directory mode: `0700`.
- `incidents/` added to `.gitignore`.
- The script is idempotent across runs; each invocation produces a new INC-<UTC-timestamp>.tgz.

## 3. NOT In Scope
- Uploading the tarball to GitHub / cloud storage automatically — operator does that manually.
- Sending a Telegram alert — that's an alerting feature, not in ADR-021@0.1.0 scope.
- Including raw audio / photo bytes (forbidden per ARCH-001@0.7.0 §9.5).

## 4. Inputs
- ADR-021@0.1.0 §`diag-bundle.sh` contract (the source layout)
- TKT-044@0.1.0 (`/diag` handler — the same `redactPii` boundary; depends_on)
- TKT-015@0.1.0 + TKT-026@0.1.0 (redaction allowlist)
- ARCH-001@0.7.0 §10 (operational procedures the bundle samples)
- Existing `scripts/backup-kbju.sh`, `scripts/migrate-vps.sh` for shell conventions

## 5. Outputs
- [ ] `scripts/diag-bundle.sh` (new), executable mode 0755.
- [ ] `src/incident/redactStream.ts` (or analogous helper) reading stdin, applying redactPii, writing stdout — used by the shell script via `docker compose exec`.
- [ ] `.gitignore` includes `incidents/`.
- [ ] `tests/incident/diagBundle.test.ts` (or shell-level smoke test) asserting:
  - The script with no args produces the global slice (no `db/` directory).
  - The script with a telegram_user_id produces the `db/` slice and the CSVs do NOT contain any forbidden column names.
  - The tarball is created with mode 0600.
  - The redactStream helper drops every forbidden field from the test fixture.

## 6. Acceptance Criteria
- [ ] `bash -n scripts/diag-bundle.sh` clean.
- [ ] `shellcheck scripts/diag-bundle.sh` clean (no error / warning level).
- [ ] `npm test -- tests/incident/diagBundle.test.ts` passes.
- [ ] Manual smoke: `./scripts/diag-bundle.sh` produces `incidents/INC-*.tgz` containing the global slice; `tar tzf incidents/INC-*.tgz` shows the layout from §2.
- [ ] No raw user text in any file inside the tarball (verified via grep against the test fixture).
- [ ] File mode of the tarball is `0600`.

## 7. Constraints
- Use `set -euo pipefail`.
- Use `bash` not POSIX sh.
- Do NOT include any file outside the documented layout (no `.env*`, no `config/llm.json`, no `config/allowlist.json`).
- Do NOT reach into Postgres internals beyond the documented columns; write the SQL queries explicitly so reviewers can audit.
- Redaction is applied via the runtime `redactPii` allowlist, not a re-implementation; if the executor finds the runtime helper isn't easily piped, the cleanest fix is a tiny `src/incident/redactStream.ts` in this ticket.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->

- 2026-05-26T00:00:00Z opencode-executor: started

- 2026-05-26T03:57:00Z opencode-executor: in_review; tests 14 pass; lint clean; typecheck clean
