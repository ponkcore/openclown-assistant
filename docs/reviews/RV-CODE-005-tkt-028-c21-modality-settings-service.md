---
id: RV-CODE-005
type: code_review
target_pr: "https://github.com/ponkcore/openclown-assistant/pull/9"
ticket_ref: TKT-028@0.1.0
status: in_review
created: 2026-05-25
---

# Code Review — PR #9 (TKT-028@0.1.0)

## Summary

The C21 Modality Settings Service implementation is functionally correct: all four acceptance criteria in TKT-028@0.1.0 §6 are met by automated tests, the inline keyboard shows exactly four toggles (KBJU excluded per PRD-003@0.1.3 §3 NG6), the TTL cache propagates within ≤30 s (vitest fake timers), and default-ON for new users is verified. However, the production DB adapter in `src/modality/settings/service.ts` reaches into the `TenantScopedRepositoryImpl`'s private `db` field via `(repo as unknown as { db: TenantQueryable }).db` — a type-safety violation that bypasses the `TenantScopedRepository` interface contract (ARCH-001@0.6.2 §3.21). The proper fix requires extending `src/store/types.ts` and `src/store/tenantStore.ts`, which are outside TKT-028@0.1.0 §5 Outputs. This architectural tension must be resolved before merge.

## Verdict
- [ ] pass
- [ ] pass_with_changes
- [x] fail

One-sentence justification: The `extractQueryable` pattern in `service.ts:153-155` violates type safety by reaching into a private implementation field via `(repo as unknown as { db: TenantQueryable }).db`, bypassing the closed `TenantScopedRepository` interface — a High finding per CONTRIBUTING.md type-safety hard rule.

Recommendation to PO: request changes from Executor (add `getModalitySettings`/`setModalitySetting` to `TenantScopedRepository` in a paired scope-expansion commit to `src/store/types.ts` + `src/store/tenantStore.ts`, OR escalate to Architect for a dedicated TKT to extend the repository interface).

## Contract compliance (each must be ticked or marked finding)
- [x] PR modifies ONLY files listed in TKT-028@0.1.0 §5 Outputs. Files changed: `docs/tickets/TKT-028-c21-modality-settings-service.md` (frontmatter + §10), `src/modality/settings/service.ts`, `src/modality/settings/telegramCommand.ts`, `src/modality/settings/copy.ru.ts`, `src/telegram/entrypoint.ts` (additive), `tests/modality/settings/service.test.ts`, `tests/modality/settings/telegramCommand.test.ts`, `tests/modality/settings/propagation.test.ts`. All match §5 Outputs.
- [x] No changes to TKT-028@0.1.0 §3 NOT-In-Scope items. Diff contains no references to `modality_settings`/`modality_settings_audit` table DDL (TKT-021@0.1.0), no C17/C18/C19/C20 handler changes, no C22 integration, no personality/preset customization, no REST API.
- [x] No new runtime dependencies beyond TKT-028@0.1.0 §7 Constraints allowlist. Only `pg` (existing) and internal imports.
- [ ] **FINDING:** All Acceptance Criteria from TKT-028@0.1.0 §6 are verifiably satisfied — **except** the production adapter does not implement the ARCH-001@0.6.2 §3.21 failure-mode contract for `getSettings` (return cached value on DB read failure; fall back to all-ON on cache miss). This is a contract deviation (Low — see F-L1).
- [x] CI: lint, typecheck, tests — executor reports 25 tests pass, lint clean, typecheck clean in §10 Execution Log. (Node/npm not available in reviewer environment for independent verification; trust executor's log entry.)
- [x] Definition of Done complete: all ACs pass (with Low caveat above), PR opened with TKT-028@0.1.0 link, no bare `TODO`/`FIXME`, §10 Execution Log filled, `status: in_review` in diff.
- [x] Ticket frontmatter `status: in_review` present in diff (`docs/tickets/TKT-028-c21-modality-settings-service.md` line 5: `status: in_review`).

## Findings

### High (blocking)

- **F-H1 (`src/modality/settings/service.ts:153-155`):** The `extractQueryable` function uses `(repo as unknown as { db: TenantQueryable }).db` to reach into `TenantScopedRepositoryImpl`'s private `db` field via double type assertion. `TenantScopedRepository` (defined in `src/store/types.ts:506-536`) is a closed interface with no generic `query()` method — only pre-defined domain methods. The production adapter then executes arbitrary raw SQL (`SELECT`, `INSERT ... ON CONFLICT`) through this extracted queryable (`service.ts:167-169`, `193-198`, `201-203`, `207-209`). This is a type-safety violation per CONTRIBUTING.md hard rules (private-field access via `as unknown as`). The correct fix is to add `getModalitySettings(userId)` and `setModalitySetting(userId, modality, value, oldValue)` methods to `TenantScopedRepository` in `src/store/types.ts` and implement them in `TenantScopedRepositoryImpl` in `src/store/tenantStore.ts`. However, both files are outside TKT-028@0.1.0 §5 Outputs — this is the architectural tension. *Responsible role:* Executor. *Suggested remediation:* Either (a) expand the ticket's §5 Outputs to include `src/store/types.ts` and `src/store/tenantStore.ts` and add the proper methods, or (b) create a follow-up TKT to extend `TenantScopedRepository` with modality-settings methods and refactor `service.ts` to use them.

### Medium

- **F-M1 (`src/telegram/entrypoint.ts:153`):** The `/settings` command logs its observability event via `logRouteOutcome` with `update.routeKind === "text_meal"` (the default when `normalizeMessage` parses `/settings` text), mapping to `KPI_EVENT_NAMES.meal_content_received` through `ROUTE_KIND_EVENT_NAME`. Settings invocations are therefore indistinguishable from actual meal-content messages in structured logs. The executor's §10 Execution Log entry ("logs as `meal_content_received` until a future ticket adds a settings-specific `event_name`") acknowledges this but no follow-up TKT is tracked. *Suggested remediation:* Either add a `"settings"` entry to `RouteKind` in a follow-up TKT, or emit a distinct log event before the `invokeWithTyping` call at line 262.

### Low

- **F-L1 (`src/modality/settings/service.ts:106-107`):** ARCH-001@0.6.2 §3.21 specifies failure modes for `getSettings`: "(a) DB read failure → return cached value if available; on cache miss return safe default (all-ON) and emit observability counter." The current implementation lets `db.fetchSettings(userId)` errors propagate uncaught to the entrypoint's generic error handler (which sends `MSG_GENERIC_RECOVERY`). On cache miss with a DB failure, the user receives an error instead of the all-ON safe default. Not a TKT-028@0.1.0 §6 AC violation (the ACs don't require this fallback), but a deviation from the architectural contract. *Suggested remediation:* Wrap `db.fetchSettings` in a try-catch inside `getSettings`; on failure, return cached value if available, otherwise return `ALL_ON` + emit an observability counter.

## Red-team probes (Reviewer must address each)

- **Error paths:** On DB read failure in `getSettings`, the error propagates to `entrypoint.ts:154` catch block, which sends `MSG_GENERIC_RECOVERY` to the user and logs an error event. On DB write failure in `setSetting`, same path. On Telegram API failure in `sendWithRetry`, the existing double-retry + error-log pattern handles it (lines 116-134). No silent failures. The ARCH-001@0.6.2 §3.21 "return cached value on DB failure" contract is NOT implemented (see F-L1).

- **Concurrency:** Two simultaneous `/settings` callbacks from the same user could both read the same `current` setting value in `handleSettingsCallback` (`telegramCommand.ts:103`) and both attempt to toggle — but `setSetting` calls `getSettings` again inside the service layer (`service.ts:122`), and the DB transaction in `tenantStore.withTransaction` serialises writes per-user via RLS + `BEGIN`/`COMMIT`. The second toggle sees the first toggle's result. Correct. Two different users are isolated by RLS (`app.user_id` set_config per transaction in `tenantStore.ts:126`).

- **Input validation:** The callback data is validated against `CALLBACK_PREFIX` (`telegramCommand.ts:97`) and the modality name is checked against `MODALITIES` array (`telegramCommand.ts:100`). Unknown modality returns `null`. The `callbackData` is sliced to 256 chars by `normalizeCallbackQuery` (`types.ts:179`). No injection vector.

- **Prompt injection:** No external user text reaches any LLM. The `/settings` command only reads/writes boolean flags. The toggle confirmation text is from the hardcoded `copy.ru.ts`, not from user input. No LLM usage in C21 per ARCH-001@0.6.2 §3.21.

- **Tenant isolation:** All SQL in `createTenantStoreSettingsDb` runs inside `tenantStore.withTransaction(userId, ...)` which sets `app.user_id` via `set_config` (`tenantStore.ts:126`). RLS policies on `modality_settings` and `modality_settings_audit` enforce `current_setting('app.user_id')::uuid = user_id` (`schema.sql:567-570`). The `extractQueryable` type-safety violation (F-H1) does NOT bypass RLS — the transaction context is still active.

- **Secrets:** No credentials committed, logged, or surfaced. The service uses the existing `TenantStore` injected at construction. No `.env` changes. No API keys.

- **Observability:** The `/settings` command logs via `logRouteOutcome` (as `meal_content_received` — see F-M1). Errors are logged with `error_code` in the extra fields. The `emitLog` + `buildRedactedEvent` pattern is consistent with the existing `src/observability/events.ts` approach. A 3am operator could trace a settings failure via `requestId`, but would need to filter by the generic `meal_content_received` event name.

- **Rollback:** The PR adds four new files (`src/modality/settings/service.ts`, `telegramCommand.ts`, `copy.ru.ts`, and three test files) and makes additive-only changes to `entrypoint.ts`. Rollback is a `git revert` of the PR commit. The `registerSettingsHandler` pattern means if the handler is never registered (reverted), `settingsHandler` stays `null` and the `/settings` interception at line 261 is skipped — existing routing is unaffected.

- **Tenant isolation (new tables):** No new tables introduced (tables are from TKT-021@0.1.0). RLS is already enabled on `modality_settings` and `modality_settings_audit` (`schema.sql:495-496`). The new code reads/writes through the RLS-scoped transaction.

- **Version-pinned references:** All references in this review use `@X.Y.Z` format: TKT-028@0.1.0, ARCH-001@0.6.2, PRD-003@0.1.3, TKT-021@0.1.0.
