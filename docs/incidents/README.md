# Incident reporting flow

This directory documents the pilot incident reporting flow defined in
ADR-021@0.1.0. The live triage path uses a GitHub issue; this directory
holds reference material and the per-incident archive template.

## Flow

1. **User reports a bug in Telegram.** The user messages the bot or the
   PO directly describing the issue (e.g. "the bot didn't respond to my
   voice message yesterday at 18:30").

2. **PO asks for `/diag`; user pastes back.** The PO asks the user to
   send the `/diag` command to the bot. The bot replies with a
   forwardable, redacted plain-text diagnostic block (version,
   build_sha, started_at_utc, telegram_user_id, last_event_id,
   last_error_id, db_ping_ms, llm_ping_ms_default, llm_ping_ms_voice,
   webhook_last_error_date, webhook_last_error_message,
   redaction_version). The user forwards or pastes this block back to
   the PO. The `/diag` command is implemented in TKT-044@0.1.0.

3. **PO runs `scripts/diag-bundle.sh <telegram_user_id>` if a deeper
   slice is needed.** When the `/diag` block alone is insufficient, the
   PO runs `scripts/diag-bundle.sh` (optionally with a Telegram user ID)
   on the VPS. The script produces a redacted, self-contained tarball at
   `incidents/INC-<UTC-timestamp>.tgz` containing Docker logs,
   healthchecks, getWebhookInfo, and per-user DB events (when a user ID
   is given). The script is implemented in TKT-045@0.1.0.

4. **PO opens a GitHub issue using the `incident` template.** The PO
   fills in `.github/ISSUE_TEMPLATE/incident.md` with the version,
   repro steps, the verbatim `/diag` output (fenced code block), expected
   vs observed behaviour, and a link to the uploaded `INC-*.tgz` bundle.
   The `incident` label is auto-applied.

5. **Architect / code review work proceeds against the redacted
   artefact.** The issue's structured input allows the Architect and
   reviewers to investigate without a live VPS session. Follow-up PRs,
   questions, and backlog entries reference the GitHub issue number.

## Related tickets

- TKT-044@0.1.0 — `/diag` Telegram command (user-side diagnostic block)
- TKT-045@0.1.0 — `scripts/diag-bundle.sh` (operator-side incident
  bundle)
- TKT-046@0.1.0 — GitHub incident issue template + this README

## Redaction boundary

All diagnostic output passes through the existing `redactPii` allowlist
(ARCH-001@0.7.0 §8.1, TKT-015@0.1.0, TKT-026@0.1.0). No raw user
content, raw secrets, or raw provider responses appear in `/diag`
output or in `diag-bundle.sh` tarballs.

## What lives here

- `README.md` — this file (flow description)
- `TEMPLATE.md` — per-incident archive structure for post-resolution
  record-keeping

The `incidents/` directory at the repo root (where `diag-bundle.sh`
writes its `INC-*.tgz` files) is `.gitignore`'d. Operators attach
bundles to GitHub issues; they are never committed to the repository.
