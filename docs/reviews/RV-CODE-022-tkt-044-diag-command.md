---
id: RV-CODE-022
type: code_review
target_pr: "https://github.com/code-yeongyu/openclown-assistant/pull/33"
ticket_ref: TKT-044@0.1.0
status: in_review
created: 2026-05-26
---

# Code Review — PR #33 (TKT-044@0.1.0)

## Summary

The PR implements the Telegram `/diag` command per ADR-021@0.1.0 with a redacted plain-text diagnostic block, cached webhook info, light-weight LLM pings, and thorough tests. The design is sound, the test coverage is excellent (47 tests covering allowlist gate, field set, redaction, graceful degradation, webhook cache, metric hashing, and LLM pings), and the code is clean. However, two High-severity contract violations in production codepaths block merge: the audio probe fixture is not copied into the Docker runtime image, and the `telegram_user_id_hashed` metric label is silently stripped by the existing label allowlist.

## Verdict

- [ ] pass
- [ ] pass_with_changes
- [x] fail

One-sentence justification: Two High findings — audio probe unreachable in production Docker image and `telegram_user_id_hashed` metric label stripped at runtime — each independently violate the ticket's §2 design contract and §7 Constraints.

Recommendation to PO: **block until Executor fixes both High findings and re-submits for iteration 2**.

## Contract compliance (each must be ticked or marked finding)

- [x] PR modifies ONLY files listed in TKT §5 Outputs. Changed: `Dockerfile`, ticket frontmatter, `src/incident/diagHandler.ts`, `src/incident/fixtures/diag-probe.wav`, `src/observability/webhookInfoCache.ts`, `src/telegram/entrypoint.ts`, `tests/incident/diagHandler.test.ts`. All match §5.
- [x] No changes to TKT §3 NOT-In-Scope items. No touch of `scripts/diag-bundle.sh`, `docs/incidents/`, `incident.md` template, or alerting. TKT-045@0.1.0 and TKT-046@0.1.0 files untouched. Verified via `git diff origin/main...HEAD --name-only`.
- [x] No new runtime dependencies beyond TKT §7 Constraints allowlist. `package.json`/`package-lock.json` unchanged. Only new dev-dependency usage is `node:fs`, `node:url`, `node:path` (built-in Node.js modules).
- [ ] All Acceptance Criteria from TKT §6 are verifiably satisfied (file:line or test name cited) — **blocked by F-H1**: the voice-ping path (`llm_ping_ms_voice`) can never exercise the audio probe in the Docker image, only the `"n/a"` fallback. AC #3 (provider unreachable → `"n/a"` and rest of block renders) passes in tests, but the expected *success* path (`llm_ping_ms_voice: <integer>`) is unreachable in production.
- [x] CI green (lint, typecheck, tests, coverage). Executor reports `tests 47 pass; lint clean; typecheck clean` in §10 Execution Log.
- [ ] Definition of Done complete — **blocked by F-H1/F-H2**: two of four gating criteria (ACs pass in production codepath, metric label registered correctly) not fully met.
- [x] Ticket frontmatter `status: in_review` in a separate commit. Verified: commit `1387f37` (status flip + §10 log) is distinct from `b9f8183` (code changes).

## Findings

### High (blocking)

- **F-H1 (`src/incident/diagHandler.ts:34`, `tsconfig.json:18`, `Dockerfile:28`): Audio probe unreachable in Docker production image.** The `tsconfig.json` includes only `src/**/*.ts` (plus `tests/**/*.ts`, `scripts/**/*.ts`, `packages/**/*.ts`). The `tsc` compiler outputs `.js`/`.d.ts`/`.map` files into `dist/` but does **not** copy non-TS asset files (`.wav`). The builder stage runs `npm run build` (= `tsc`), then the runtime stage copies only `COPY --from=builder /app/dist ./dist`. At runtime, `fileURLToPath(import.meta.url)` resolves to `dist/src/incident/diagHandler.js`, so `__dirname` is `dist/src/incident/`, and `loadAudioProbe()` will attempt `readFileSync("dist/src/incident/fixtures/diag-probe.wav")` which does not exist → `ENOENT` → `measureLlmPingVoice` catch returns `"n/a"`. The handler gracefully degrades, but the **voice ping success path is permanently unreachable in production**; only the fallback `"n/a"` string is ever emitted. This violates §2 In Scope ("project-bundled fixture") and makes AC #3's expected steady-state output unverifiable in the Docker image. *Responsible role:* Executor. *Suggested remediation:* Add a `COPY src/incident/fixtures/diag-probe.wav` directive to the builder stage that writes the `.wav` to `dist/src/incident/fixtures/` before `npm run build` output, OR use a multi-stage `COPY --from=builder` that copies the fixture alongside compiled JS. Alternative: store the audio as a base64-encoded constant so no filesystem read is needed.

- **F-H2 (`src/observability/kpiEvents.ts:87-98`, `src/observability/metricsEndpoint.ts:30-42`, `src/incident/diagHandler.ts:251-254`): `telegram_user_id_hashed` metric label stripped at runtime.** `handleDiag` emits `kbju_diag_invocations_total{telegram_user_id_hashed=<sha256Half>}` but the label `telegram_user_id_hashed` is **not** present in `ALLOWED_METRIC_LABELS` (line 87). Additionally, the `FORBIDDEN_METRIC_LABELS` substring matching at `metricsEndpoint.ts:34-35` catches it: `key.toLowerCase().includes("user_id")` is `true` for `"telegram_user_id_hashed"`. The `validateLabels` function strips the label on both grounds (`!isAllowed` and `isForbidden`), so the counter is emitted without any discriminator. This violates §7 Constraints: "The `kbju_diag_invocations_total` metric label MUST hash the Telegram user ID." The metric works in unit tests only because the mock `MetricsRegistry` does not invoke `validateLabels`. *Responsible role:* Executor. *Suggested remediation:* (1) Add `"telegram_user_id_hashed"` to `ALLOWED_METRIC_LABELS` in `kpiEvents.ts`. (2) Because `FORBIDDEN_METRIC_LABELS` uses substring matching and `user_id` is a forbidden substring, rename the label to `tg_uid_hash` (or similar) that avoids the `user_id` substring, OR update the `validateLabels` logic so that an explicit ALLOWED entry overrides the substring-based FORBIDDEN check. The simpler approach (rename) avoids touching the security-sensitive validateLabels function.

### Medium

- **F-M1 (`src/incident/diagHandler.ts:185-191`): `redactStringValue` abuses `error_code` as a carrier key for PII redaction.** The function wraps a generic string value under the key `error_code` solely because `error_code` is in `ALLOWED_EXTRA_KEYS` and passes through `redactPii`. This works today but is fragile: if `error_code` is renamed or removed from `ALLOWED_EXTRA_KEYS` (which is semantically intended for actual error codes, not a general-purpose redaction carrier), `wrapped.error_code` returns `undefined` and the `typeof redacted === "string"` guard falls back to the unredacted original value. The entire diag block's redaction would silently break. Additionally, the `error_code` key has a specific semantic meaning throughout the codebase; reusing it for arbitrary diag-block values is confusing. *Responsible role:* Executor. *Suggested remediation:* Add a dedicated key (e.g., `diag_field_value`) to `ALLOWED_EXTRA_KEYS` and use it instead of `error_code`, OR export `PII_PATTERNS` / `redactStringValues` from `events.ts` so `redactStringValue` can call it directly without the carrier-key indirection. The latter is cleaner and eliminates the fragility entirely.

### Low

- **F-L1 (`src/incident/diagHandler.ts:291`): `redaction_version` uses `LOG_SCHEMA_VERSION` (`"1"`) instead of an independent `REDACTION_VERSION` constant.** ADR-021@0.1.0 specifies `redaction_version: <ARCH-001@0.7.0 §8.1 schema version>`. While `"1"` is currently correct, the log schema version and the redaction allowlist version are conceptually independent — a future log schema bump should not automatically increment the redaction version. Low — no functional bug, but semantic conflation.

- **F-L2 (`src/incident/diagHandler.ts:251`): Per-invocation metric salt makes `kbju_diag_invocations_total` non-aggregatable.** The `sha256Half(userId:requestId)` means every `/diag` invocation generates a new metric time series (since `requestId` is unique per webhook delivery). Prometheus counters with unique labels per request balloon in cardinality. The design per ADR-021@0.1.0 calls for `salted with request_id` (detective use), but this means the counter cannot answer "how many times has user X called /diag?" without summing across many series. Low — explicit design tradeoff per ADR, unlikely to cause issues at pilot scale (2 users, low invocation rate).

- **F-L3 (`src/incident/diagHandler.ts:234-303`): No explicit diag-specific log event.** The handler does not emit a log event for the invocation; the entrypoint's `invokeWithTyping` wrapper emits a general C1 `logRouteOutcome` event but does not capture diag-specific fields (ping latencies, which pings ran, webhook cache state). A 3am operator can get the diag block from the user but has no server-side record of the same data. Low — acceptable for P1, but restricts forensics.

## Red-team probes (Reviewer must address each)

- **Error paths:** DB query failure → `catch(() => "none")` for event/error IDs; `measureDbPing` catch → `-1` → `"n/a"`. LLM ping failure → `"n/a"`. Webhook cache refresh failure → stale data retained (swallowed in `start()` and `refresh()`). Telegram sendMessage failure → retried once via `sendWithRetry` in entrypoint, then logged as `telegram_send_failed`. All error paths degrade gracefully — no crash, no leaked data. ✓

- **Concurrency:** Two simultaneous `/diag` from the same user are handled by independent `handleDiag` invocations. The `WebhookInfoCache` has shared mutable state but the handler only reads (`getCachedInfo()`), never writes. No race condition risk. The `sha256Half` uses per-request `requestId` for uniqueness. ✓

- **Input validation:** `/diag` command matches any text starting with `/diag` (including `/diag foo`). Handler ignores extra arguments. No parsing risks. The audio probe is a project-bundled fixture, not user-supplied. No malformed-voice/photo/oversized-payload surfaces. Unicode edge cases: all string fields pass through `redactStringValue` which applies regex-based PII patterns — benign values pass through unchanged. ✓

- **Prompt injection:** No external user text reaches an LLM. The `chatCompletion` prompt is the hardcoded string `"ok"`. The voice transcription uses the project-bundled audio probe, not user audio. No prompt-injection surface. ✓

- **Tenant isolation:** All DB queries are scoped to `user_id = $1` (the requesting Telegram user ID). The `WebhookInfoCache` is global (not per-user) by design — it caches `getWebhookInfo` for the bot as a whole, not per-user Telegram API calls. The `MetricsRegistry` is global but the hashed label prevents cross-user correlation. ✓

- **Secrets:** `BUILD_SHA` is a public git commit SHA — not a secret. Read from env var at runtime, not logged (only placed in the diag block). The `redactPii` patterns catch Telegram bot tokens, provider API keys, and Bearer tokens in diagnostic string values. No credentials committed in the diff. The `.env.example` is not modified (no new env vars beyond `BUILD_SHA` which is already in the Dockerfile). ✓

- **Observability:** A 3am operator can request `/diag` from a pilot user to get the diagnostic block. Server-side logs: entrypoint emits C1 `logRouteOutcome` on success with `source: "command:/diag"` (from `normalizeMessage` path). The `kbju_diag_invocations_total` metric **will be label-stripped** in production (see F-H2) — after fix, it will carry the hashed user ID. No diag-specific log event capturing latency breakdowns — acceptable for P1. The `WebhookInfoCache` doesn't log refreshes — only a 3am operator checking the Telegraph `/diag` output would see webhook errors. Barely adequate but not under-scoped. ✓

- **Rollback:** Reverting this PR is a plain `git revert` of the two commits. The Dockerfile change (`ARG BUILD_SHA`) is backward-compatible (not supplying the arg → `unknown`). No DB migrations, no schema changes. The entrypoint dynamic import means the module is only loaded when `/diag` is invoked — removing the routing code prevents load. Clean. ✓
