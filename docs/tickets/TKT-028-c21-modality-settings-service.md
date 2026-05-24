---
id: TKT-028
title: C21 Modality Settings Service with /settings command + ≤30s propagation
version: 0.1.0
status: done
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
component: C21
depends_on:
- TKT-021@0.1.0
blocks: []
estimate: M
created: 2026-05-06
updated: 2026-05-06
---

# TKT-028: C21 Modality Settings Service with /settings command + ≤30s propagation

## 1. Goal
Land the C21 Modality Settings Service exposing a `/settings` Telegram command surface that toggles each of the four PRD-003@0.1.3 modalities ON / OFF with ≤30 s propagation per PRD-003@0.1.3 §5 US-5.

## 2. In Scope
- New module `src/modality/settings/service.ts` exporting `getSettings(userId)`, `setSetting(userId, modality, value)` reading / writing the `modality_settings` table from TKT-021@0.1.0.
- New `/settings` Telegram command surface (or equivalent menu entry — exact label PO-ratified before sign-off) showing four toggles labelled in Russian for water / sleep / workout / mood (KBJU NOT shown — always-on per PRD-003@0.1.3 §3 NG6 + §5 US-5 6th AC bullet).
- An in-process settings cache with TTL ≤30 s honouring PRD-003@0.1.3 §5 US-5 K5 ≤30s propagation. The TTL ensures any external write to `modality_settings` (e.g. by a future PRD's settings API) propagates through within budget.
- Settings audit row in `modality_settings_audit` (TKT-021@0.1.0 schema) per toggle change.
- All four modalities default ON for new users (PRD-003@0.1.3 §5 US-5 5th AC bullet); existing v0.1 users (PO + partner) inherit ON-on-deploy via a one-time migration in TKT-021@0.1.0 (or here if Executor judges the seed belongs with the service module).
- Russian-language `/settings` reply copy in `src/modality/settings/copy.ru.ts`.

## 3. NOT In Scope
- The `modality_settings` + `modality_settings_audit` tables themselves (TKT-021@0.1.0).
- Per-modality OFF-state acceptance bullets in C17/C18/C19/C20 (each handler enforces OFF-state independently — TKT-023@0.1.0 + TKT-029@0.1.0 / TKT-030@0.1.0 / TKT-031@0.1.0).
- The C22 Adaptive Summary Composer's settings read (TKT-027@0.1.0 reads `modality_settings` directly via `getSettings`).
- Personality / preset customization (PRD-003@0.1.3 §3 NG9 explicit non-goal — preserved).
- Future settings API (web view, /settings via REST, etc.) — out of scope per PRD-003@0.1.3 §3 NG5 (no new channel).
- **Soft-dep rationale for C16/C18/C19/C20/C22**: C21 Modality Settings Service is a runtime configuration provider, NOT a compile-time dependency. Handlers (C16 via TKT-022@0.1.0, C18 via TKT-023@0.1.0, C19 via TKT-030@0.1.0, C20 via TKT-031@0.1.0, C22 via TKT-027@0.1.0) can be built and unit-tested with mocked settings; integration tests that need live settings will naturally run after C21 is deployed. Therefore downstream Tickets do NOT list TKT-028@0.1.0 in `depends_on`.

## 4. Inputs
- ARCH-001@0.6.0 §3.21 (C21 component spec)
- PRD-003@0.1.3 §2 G5 (verbatim per-modality on/off goal)
- PRD-003@0.1.3 §5 US-5 (verbatim AC bullets)
- PRD-003@0.1.3 §6 K5 (≤30s propagation KPI)
- PRD-003@0.1.3 §3 NG6 (KBJU is NOT a toggleable modality)
- TKT-021@0.1.0 `modality_settings` + `modality_settings_audit` schemas
- Existing `src/telegram/entrypoint.ts` (the C1 entrypoint where `/settings` command will be routed)
- Existing `src/skills/cron-tools/...` (precedent for an in-process cache with TTL)

## 5. Outputs
- [ ] `src/modality/settings/service.ts` exporting `getSettings(userId)`, `setSetting(userId, modality, value)` and the in-process cache with TTL.
- [ ] `src/modality/settings/telegramCommand.ts` exporting the `/settings` command handler + inline-keyboard wiring.
- [ ] `src/modality/settings/copy.ru.ts` Russian-language reply copy.
- [ ] `src/telegram/entrypoint.ts` extended to route `/settings` to the new handler (additive; no changes to existing command routing).
- [ ] `tests/modality/settings/service.test.ts` covering: get-default-ON, set-ON-to-OFF, set-OFF-to-ON, audit-row-written, settings-cache-TTL ≤30 s.
- [ ] `tests/modality/settings/telegramCommand.test.ts` covering the inline-keyboard flow + Russian-copy assertions.
- [ ] `tests/modality/settings/propagation.test.ts` covering K5 ≤30s propagation: write to `modality_settings` directly, then `getSettings` reflects the change within 30 s without explicit cache invalidation.

## 6. Acceptance Criteria
- [ ] `npm test -- tests/modality/settings/` passes.
- [ ] `npm run lint` clean.
- [ ] `npm run typecheck` clean (strict).
- [ ] Manual smoke: `/settings` command → bot replies with the four-toggle inline keyboard. Tap "Sleep: OFF" → bot confirms, sleep-modality input is rejected within 30 s, the next summary suppresses the sleep section.
- [ ] Manual smoke: tap "Sleep: ON" → bot confirms, subsequent sleep events are accepted, the next summary includes sleep section.
- [ ] Manual smoke: KBJU is NOT shown in the settings keyboard (verify the keyboard has exactly four buttons).
- [ ] All four modalities default ON for a freshly-created user fixture.
- [ ] An audit row is written to `modality_settings_audit` for every toggle change with `(user_id, modality, old_value, new_value, ts)`.

## 7. Constraints
- Do NOT delete historical events when a modality is toggled OFF (PRD-003@0.1.3 §5 US-5 4th AC bullet — pre-toggle data preserved).
- Do NOT show KBJU in the `/settings` keyboard.
- Do NOT use a session-scoped cache that would persist beyond the TTL boundary; the propagation contract is global, not per-session.
- The `/settings` command MUST be Russian-only at the user-facing layer (PRD-003@0.1.3 §7 Localization).
- All SQL parameterised; all RLS-policy-scoped reads via the existing user-context middleware.
- `assigned_executor: "executor"` justified: a Telegram command handler + a service module + a TTL cache; no security boundary beyond standard RLS-scoped reads (the security boundary lives in TKT-021@0.1.0); GLM-typical TypeScript module work.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body.
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
- 2026-05-25T00:00:00Z opencode-executor: started
- 2026-05-25T01:55:00Z opencode-executor: in_review; tests 25 pass; lint clean; typecheck clean
- 2026-05-25T02:15:00Z opencode-executor iter2: closed F-H1 (added getModalitySettings + setModalitySetting to TenantScopedRepository in src/store/types.ts + tenantStore.ts; refactored service.ts to use them; removed extractQueryable + (as unknown as) cast). F-M1 (RouteKind extension) deferred to future TKT — out of scope. PO-authorised carve-out of TKT-028@0.1.0 §5 Outputs for type-safety repair.
- 2026-05-24T23:25:00Z opencode-orchestrator: merged in commit aceaf99 (PR #9); RV-CODE-005 verdict iter2=pass_with_changes (F-H1 closed; F-M1 + Lows deferred)
