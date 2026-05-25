---
id: ADR-021
title: Pilot incident reporting flow
status: proposed
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
created: 2026-05-25
updated: 2026-05-25
superseded_by: null
---

# ADR-021: Pilot incident reporting flow

## Context

PRD-001@0.3.0 ships to a 2-user pilot with no admin UI (§3 NG5). When a user reports a
bug ("the bot didn't respond to my voice message yesterday at 18:30"), the operator
currently has to:

1. SSH to the VPS.
2. `docker compose logs --since=24h kbju-sidecar | grep <something>` and hope the
   timestamps line up with the user's recollection.
3. Cross-reference Telegram `getWebhookInfo` for delivery errors.
4. Reconstruct the request lifecycle by reading raw JSON logs.

This is operator-hostile, slow, and inconsistent across incidents. It also produces
zero shareable artefact for follow-up by the Architect or by code review of a
fix-PR — every incident becomes a re-investigation.

The PO needs a structured incident reporting flow that:

- Lets the user trigger a redacted, auto-redacting diagnostic from inside Telegram
  with a single command (`/diag`).
- Lets the operator collect a self-contained incident bundle (logs + DB events for
  the affected user + getWebhookInfo + healthchecks) with one shell command.
- Produces a forwardable artefact compatible with a `.github/ISSUE_TEMPLATE/incident.md`
  so the Architect / code-review path has a uniform input.

The redaction allowlist (ARCH-001@0.7.0 §8.1, TKT-015@0.1.0, TKT-026@0.1.0) is the existing
trust boundary; everything in the incident pipeline routes through it.

## Options Considered (≥3 real options, no strawmen)

### Option A: Telegram `/diag` command + `scripts/diag-bundle.sh` + GitHub issue template

- Description:
  - User sends `/diag` (or `/diag <last_event_id?>`); bot replies with a
    plain-text-block, redacted, forwardable structured report (version, build-sha,
    started-at, telegram_user_id, last-event-id, last-error-id, db-ping-ms,
    llm-ping-ms).
  - Operator runs `scripts/diag-bundle.sh <telegram_user_id?>` on the VPS; the
    script tarballs last-N-minutes Docker logs, last-N DB events for the affected
    user (when telegram_id is provided), `getWebhookInfo`, and per-service
    healthchecks into `incidents/INC-<UTC-timestamp>.tgz`. Raw user content
    (meal_text, mood_comment_text, raw transcripts, raw photos) is excluded by
    re-applying the §8.1 emit-boundary redaction allowlist.
  - `.github/ISSUE_TEMPLATE/incident.md` requires: version, repro steps, /diag
    output, expected vs observed, log bundle attached.
  - `docs/incidents/README.md` describes the flow and `docs/incidents/TEMPLATE.md`
    is the per-incident archive structure.
- Pros (concrete):
  - User-side `/diag` is a Telegram-native action; no SSH, no extra tool. PO can ask
    a pilot user "send me /diag" and forward the reply.
  - Operator-side `diag-bundle.sh` is one command; produces a self-contained tarball.
  - The issue template forces consistent input for triage; the Architect can wedge
    backlog entries / Q-files against a known shape.
  - Reuses the existing `redactPii` allowlist (TKT-015@0.1.0) and the modality-
    specific extension (TKT-026@0.1.0); no new redaction rules.
  - `incidents/` directory is `.gitignore`'d (the bundles contain user-specific event
    counts; only the issue itself is committed if the operator chooses).
- Cons (concrete):
  - Three deliverables instead of one. Acceptable: each closes a different gap.
  - `/diag` adds a Telegram command surface that needs C1 routing + redaction.
- Cost / latency / ops burden: low — three small artefacts, all reusing existing
  infrastructure.

### Option B: Single Telegram command with embedded log retrieval

- Description: Make `/diag` return everything (recent logs, DB events, healthchecks)
  as one Telegram message thread.
- Pros: one user-action; no shell.
- Cons:
  - Telegram message body limit is 4096 characters; even a redacted log slice doesn't
    fit in one message. Multi-message-thread replies are operator-hostile to forward.
  - Sending log content to a user (even redacted) widens the trust boundary; the
    `/diag` plain-text block intentionally omits log slices.
  - No tarball produces no artefact for git-attached issues / PR comments.
- Cost / latency / ops burden: medium — but lower utility than Option A.

### Option C: External SaaS error tracker (Sentry / Datadog / Logflare)

- Description: Wire a SaaS error tracker into the sidecar; user-facing `/diag` returns
  a session URL that links to the SaaS dashboard.
- Pros: rich ad-hoc query language; charts; existing tooling.
- Cons:
  - PRD-001@0.3.0 §9 + ARCH-001@0.7.0 §9.3 forbid sending user metadata to observability
    SaaS. PRD-001@0.3.0 §3 NG5 forbids admin dashboards.
  - Adds a SaaS account dependency; out of scope for this PR.
- Cost / latency / ops burden: medium ops; high data-egress concern.

### Option D: Just enrich the existing Docker logs (no new commands)

- Description: Improve log fields and rely on `docker compose logs` for triage.
- Pros: zero new code paths.
- Cons:
  - Still operator-hostile; still no user-side action; still no shareable artefact.
  - Doesn't solve the "user reports a bug → 30 min later operator finds the relevant
    log line" friction.
- Cost / latency / ops burden: low; insufficient.

## Decision

We will use **Option A: a three-part incident pipeline**:

1. **Telegram `/diag` command** (TKT-044@0.1.0) — the user surface.
2. **`scripts/diag-bundle.sh`** (TKT-045@0.1.0) — the operator surface.
3. **GitHub issue template + `docs/incidents/`** (TKT-046@0.1.0) — the artefact
   surface.

### `/diag` command contract (TKT-044@0.1.0)

- C1 routes `/diag` to a new `IncidentDiagnostic` handler. The handler is allowlisted
  to `TELEGRAM_PILOT_USER_IDS`-equivalent entries (C15 allowlist); non-allowlisted
  users get the standard Russian "not allowed" message.
- The handler returns one Telegram message body, plain text (no Markdown, no inline
  keyboard), formatted as a forwardable block:

  ```
  --- KBJU diag ---
  version: <package.json version>
  build_sha: <git SHA at image build, baked at Dockerfile build time>
  started_at_utc: <ISO-8601>
  telegram_user_id: <numeric>
  last_event_id: <UUID or "none">
  last_error_id: <UUID or "none">
  db_ping_ms: <integer>
  llm_ping_ms_default: <integer or "n/a">
  llm_ping_ms_voice: <integer or "n/a">
  webhook_last_error_date: <ISO-8601 or "none">
  webhook_last_error_message: <string or "none">
  redaction_version: <ARCH-001@0.7.0 §8.1 schema version>
  --- end ---
  ```

- All values pass through `redactPii` allowlist before serialisation; no raw user
  text, no raw secrets, no raw provider responses.
- `last_event_id` and `last_error_id` are pulled from `metric_events` (latest
  successful event) and from the most recent `metric_events` row with `outcome =
  provider_failure | validation_blocked | budget_blocked` for the requesting user
  in the last 24 h. UUIDs are project-internal IDs, not Telegram message IDs.
- `db_ping_ms` is `SELECT 1` round-trip; `llm_ping_ms_default` is a 1-token "ok"
  completion against `kbju.modality_router_classifier` (the cheapest call-type per
  ADR-024@0.1.0); `llm_ping_ms_voice` is a tiny audio probe — or "n/a" if voice is
  not currently configured.
- `webhook_last_error_*` is from a cached `getWebhookInfo` poll (refreshed every 60
  s by a background tick) so `/diag` doesn't make a Telegram API call per user
  invocation.

### `diag-bundle.sh` contract (TKT-045@0.1.0)

```bash
scripts/diag-bundle.sh [<telegram_user_id>]
```

- With no argument: collects the global slice (recent logs, healthchecks,
  getWebhookInfo, no per-user data).
- With a `<telegram_user_id>` argument: also includes the last N=200 redacted
  `metric_events`, `cost_events`, and `audit_events` rows for that user.
- Output: `incidents/INC-<UTC-timestamp>.tgz` with the following layout:

  ```
  INC-2026-05-25T17-30Z/
    manifest.json            # version, build_sha, generated_at_utc, args, schema_version
    docker-compose-ps.txt
    healthchecks.txt         # /kbju/health, /metrics health, caddy /health, postgres pg_isready
    docker-logs/
      kbju-sidecar.log       # last 30 min, redacted by `redactPii` (run as a docker compose exec)
      openclaw-gateway.log   # last 30 min, redacted
      caddy.log              # last 30 min, redacted (less PII risk; same allowlist)
      postgres.log           # last 30 min, redacted
    telegram/
      getWebhookInfo.json
    db/                      # only when telegram_user_id is provided
      metric_events.csv
      cost_events.csv
      audit_events.csv
  ```

- Raw user content (`meal_text`, `comment_text`, `raw_text`, `raw_description`,
  `transcript_text`, `username`) is excluded by re-applying the §8.1 + §10.7
  emit-boundary redaction allowlist (TKT-015@0.1.0 + TKT-026@0.1.0).
- The script enforces the redaction by piping every output through the same
  `redactPii` helper used at runtime, NOT by re-implementing it in shell.
- `incidents/` is added to `.gitignore` (TKT-045@0.1.0); operators attach the
  tarball to issues, they don't commit it.

### Issue template + docs (TKT-046@0.1.0)

`.github/ISSUE_TEMPLATE/incident.md` requires:

- Version (matches the `/diag` `version` line).
- Repro steps (numbered).
- `/diag` output (the plain-text block, pasted verbatim).
- Expected vs observed.
- Log bundle attached (link to the `INC-*.tgz` upload).

`docs/incidents/README.md` describes the flow:

1. User reports bug in Telegram.
2. PO asks for `/diag`; user pastes back.
3. PO runs `scripts/diag-bundle.sh <telegram_user_id>` if a deeper slice is
   needed.
4. PO opens a GitHub issue using the template.
5. Architect / code review work proceeds with the issue's redacted artefact, not a
   live VPS session.

`docs/incidents/TEMPLATE.md` is the per-incident archive structure (one folder per
incident, with the manifest + the tarball link + any follow-up notes).

### Why the losers lost

- **Option B (single Telegram command + embedded logs):** Telegram message size
  limit; operator-hostile to forward; broadens the trust boundary by sending log
  content to user.
- **Option C (SaaS error tracker):** PRD-001@0.3.0 §9 / ARCH-001@0.7.0 §9.3 forbid SaaS
  egress for user metadata; PRD §3 NG5 forbids admin dashboards.
- **Option D (just better Docker logs):** doesn't solve the user-side gap.

## Consequences

**Positive:**

- User-side `/diag` is a Telegram-native action; one message, forwardable.
- Operator-side `diag-bundle.sh` is one command; produces a self-contained,
  redacted tarball.
- GitHub issue template gives Architect / code review a uniform input shape.
- All three deliverables reuse existing redaction; no new trust boundary.

**Negative / trade-offs accepted:**

- `/diag` adds a small live LLM ping cost ($0.0001 per invocation, well inside
  PRD-001@0.3.0 §7 ceiling).
- `diag-bundle.sh` runs as the operator (root-equivalent on the VPS); the tarball is
  generated in plaintext and the operator must store / transmit it responsibly. The
  `INC-*.tgz` file mode is `0600` and `incidents/` is `.gitignore`'d.
- `webhook_last_error_*` cached at 60-s; a brand-new error is up to 60 s stale in a
  `/diag` call. Acceptable for triage; live `getWebhookInfo` is in the bundle for
  precise debugging.

**Follow-up work:**

- TKT-044@0.1.0 implements `/diag` (C1 routing + IncidentDiagnostic handler).
- TKT-045@0.1.0 implements `scripts/diag-bundle.sh` and the `incidents/.gitignore`
  entry.
- TKT-046@0.1.0 implements `.github/ISSUE_TEMPLATE/incident.md` and
  `docs/incidents/{README,TEMPLATE}.md`.
- A future PRD may add automatic alerting (Telegram alert on critical-severity log
  events) that wraps the same diag pipeline; out of scope for v0.7.0.

## References

- PRD-001@0.3.0 §3 NG5 (no admin web UI), §3 NG7 (no medical advice; this is purely
  ops scope), §7 (no SaaS egress for user metadata)
- ARCH-001@0.7.0 §8.1 + §10.7 + §10.8 (emit-boundary redaction; `redactPii` allowlist)
- TKT-015@0.1.0 (observability hardening — emit-boundary redaction)
- TKT-026@0.1.0 (PRD-003@0.1.3 redaction allowlist extension — modality-specific PII)
- ADR-024@0.1.0 (model registry — `kbju.modality_router_classifier` cheapest call-
  type used for llm_ping)
- ADR-020@0.1.0 (Caddy + getWebhookInfo flow)
- Telegram getWebhookInfo reference: <https://core.telegram.org/bots/api#getwebhookinfo>
