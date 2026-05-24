---
id: PRD-001
title: KBJU Coach v0.1
version: 0.2.0
status: approved
owner: '@po'
created: 2026-04-25
updated: 2026-04-26
supersedes: null
superseded_by: null
related: []
---

# PRD-001: KBJU Coach v0.1

## 1. Problem Statement
The Product Owner and one partner user want a low-friction way to track daily food intake (calories, protein, fat, carbs — KBJU) on Telegram in Russian. Existing trackers force tedious manual entry, which both users abandon within days. The pilot's job is to validate that voice / text / photo logging with confirmation gates is durable enough to become the foundation of a future per-user subscription product. v0.1 is scoped to two pilot users on a closed channel; subscription, billing, and public sign-up are explicitly deferred. The product must be designed multi-tenant from day 1 so the same data model carries cleanly into the paid product without rework.

## 2. Goals (SMART)
- **G1 — Logging volume.** By the end of a 30-day pilot starting at first `/start`, each pilot user logs ≥3 confirmed meals per day on ≥5 of any rolling 7-day window. Measured server-side from confirmed meal records (US-2, US-3, US-4).
- **G2 — Time-to-first-value.** From the moment a user sends their first meal-content message (voice, text, or photo — not `/start`), the bot returns a draft KBJU estimate within ≤120 seconds end-to-end during the entire 30-day pilot. Measured from server-side timestamps of inbound message ↔ outbound KBJU reply.
- **G3 — Voice round-trip latency.** For voice messages ≤15 seconds long, the bot's KBJU draft reply is delivered within ≤8 seconds (p95) and ≤30 seconds (p100, hard cap) over a rolling 7-day window for the entire 30-day pilot. The bot MUST display a Telegram "typing…" indicator continuously while processing.
- **G4 — Tenant isolation.** Across the 30-day pilot, zero cross-user data leaks (any case where one user's bot reply, summary, or history view contains data attributable to another user). Verified by an end-of-pilot audit of stored events for cross-user references.
- **G5 — Cost ceiling.** Total LLM and voice-transcription spend for the 2-user pilot stays within $10/month. Measured monthly against provider invoices. On overage, the system MUST auto-degrade (cheaper model and/or skip optional database lookup) and notify the PO; the system MUST NOT silently overspend.

## 3. Non-Goals (explicitly NOT in this epic)
- **NG1.** No calendar integration of any kind (Google Calendar, iCal, native calendars). Daily / weekly / monthly summaries are delivered as plain Telegram messages on schedule.
- **NG2.** No fitness, exercise, or step tracking. Calorie target factors in self-reported activity level at onboarding, but the bot does not log workouts.
- **NG3.** No public release, bot marketplace listing, or open sign-up. New pilot users are added by the PO out-of-band.
- **NG4.** No payment, subscription, billing, promo-code, or referral functionality.
- **NG5.** No admin web UI or per-user dashboard outside of Telegram.
- **NG6.** No nutrition coaching beyond KBJU (no vitamins, glycemic-index advice, supplement recommendations, hydration tracking).
- **NG7.** No medical or clinical advice. The bot must include a disclaimer in onboarding (US-1) that it is not a medical product.
- **NG8.** No barcode or packaged-goods scanning.
- **NG9.** No social sharing, friend leaderboards, or public profiles. Considered for a future revision (see §10).
- **NG10.** No per-user assistant personality customization. v0.1 ships a single curated personality written by the PO; customization is a candidate for the premium tier of the future paid product (§10).

## 4. Target Users / Personas
- **P1 — Product Owner (primary pilot user).** Male, 30, works remotely from home with occasional bouts of physical labor. High tech comfort: confidently uses voice / photo / text in any bot. No allergies, omnivore, no avoided foods. Primary motivation: weight loss. Uses the bot daily to maintain a calorie deficit; values speed of logging over feature breadth.
- **P2 — Partner (secondary pilot user).** Female, 28, full-time student. Medium tech comfort: comfortable in Telegram but a new bot flow that fails twice will lose her. No allergies, omnivore, no avoided foods. Primary motivation: general health-tracking with no specific weight target. Most likely to log meals at home in the evening; less likely to log on-the-go.

## 5. User Stories & Acceptance Criteria

### US-1: Onboarding and personalized targets
**As a new user**, I want the bot, on my first interaction, to ask for the biometric and lifestyle data needed to compute personalized daily KBJU targets, **so that** my subsequent meal logs are evaluated against my own targets, not generic ones, and so the bot can offer informed daily recommendations.

**Acceptance:**
- [ ] Given a Telegram user has never interacted with the bot, when they send `/start`, then the bot greets them in Russian, briefly explains what it does, and includes a one-sentence non-medical disclaimer.
- [ ] The bot collects, in a guided step-by-step intake: sex, age, height (cm), weight (kg), self-reported activity level (sedentary / light / moderate / active / very active), weight goal (lose / maintain / gain), and desired pace per week in kg (the pace step is optional; if skipped, the bot applies the default pace of 0.5 kg/week — moderate, not aggressive — and tells the user what was assumed).
- [ ] All fields are validated against the following ranges; invalid input prompts a re-ask in Russian with a clear example, not a generic error: age 10–120 years; height 100–250 cm; weight 20–300 kg; pace 0.1–2.0 kg/week (applies to both lose and gain goals; ignored when goal = maintain).
- [ ] At completion of the biometric intake, the bot proposes a default delivery time for daily reports framed as a confirmation question in Russian (e.g. «Удобно ли получать ежедневный отчёт в 22:00?», offered alongside the locale-appropriate timezone the bot inferred from the Telegram client). The user confirms or selects an alternative time / timezone in the same message thread.
- [ ] The bot computes and displays the user's personalized daily targets (calories, protein, fat, carbs) in Russian and asks for explicit confirmation before transitioning to logging mode. The user can request a re-explanation or restart onboarding.
- [ ] All onboarding answers are stored under the user's tenant scope only (US-9).

### US-2: Voice meal logging
**As a user**, I want to send a voice message describing what I just ate, **so that** the bot returns a KBJU estimate without requiring me to type.

**Acceptance:**
- [ ] Given the user has completed onboarding, when they send a voice message ≤15 seconds describing a meal in Russian, then the bot transcribes the speech, parses meal contents, and replies with a draft KBJU estimate within the §7 latency budget.
- [ ] The bot displays a Telegram "typing…" indicator continuously while processing.
- [ ] The reply lists each detected food item with portion estimate and KBJU breakdown, plus a total, plus an inline confirm / edit affordance.
- [ ] On user confirmation, the meal is persisted under the user's tenant scope; on user edit, the bot recomputes from the corrected list before persisting.
- [ ] If transcription fails, the bot follows US-7.

### US-3: Text meal logging
**As a user**, I want to send a free-form Russian text message describing what I just ate, **so that** the bot returns a KBJU estimate.

**Acceptance:**
- [ ] Given onboarding is complete, when the user sends a Russian text message describing a meal, the bot replies with a draft KBJU estimate within the §7 text round-trip budget.
- [ ] Reply includes itemized food list with KBJU breakdown, total, and confirm / edit affordance identical to US-2.
- [ ] Persistence behavior matches US-2.

### US-4: Photo meal logging with mandatory confirmation
**As a user**, I want to photograph my meal and have the bot estimate the contents and KBJU, **so that** I can log a meal without typing or speaking — but I want to review and correct before anything is saved.

**Acceptance:**
- [ ] Given the user sends a photo of a meal, when the bot processes it, then the bot replies with an estimated list of food items, portion estimates, and a KBJU breakdown.
- [ ] If the bot's confidence in its identification is below the project's low-confidence threshold (Architect sets the numeric threshold and the explicit user-facing label), the reply is visibly tagged as «низкая уверенность» so the user knows to scrutinize.
- [ ] The bot ALWAYS asks the user to confirm or edit the items list before persisting any KBJU record from a photo, regardless of confidence level. There is no auto-save path for photo logs in v0.1.
- [ ] The user can correct items, portions, or remove items inline; the bot recomputes KBJU from the corrected list and presents the updated draft for final confirmation.

### US-5: Daily / weekly / monthly summary
**As a user**, I want to receive periodic summaries of my eating with totals, comparison to my target, comparison to the previous period, and short personalized recommendations, **so that** I can see trends and act on them.

**Acceptance:**
- [ ] Given the user has logged at least one confirmed meal in the period, the bot delivers a Russian-language summary message at the user-confirmed delivery time. Default times are 22:00 daily, Sunday 21:00 weekly, and the 1st of the next month at 21:00 monthly, all in the user's confirmed timezone.
- [ ] Each summary includes: raw totals (calories, protein, fat, carbs); delta vs. the user's daily / weekly / monthly target; comparison to the previous period of the same length; a short personalized recommendation derived from the data. Recommendations MUST be limited to calorie and macronutrient balance relative to the user's target (e.g. "you ran a 400 kcal deficit on average — consistent with your 0.5 kg/week pace", "your protein was 30 g below target on 4 of 7 days"). Recommendations MUST NOT mention vitamins, supplements, hydration, glycemic index, meal timing, micronutrients, or any clinical / medical advice — those topics are deferred per §3 NG6 / NG7.
- [ ] If the user logged zero confirmed meals in the period, the summary is replaced by a single short Russian nudge.
- [ ] Summary content is generated per-user from that user's data only (US-9).

### US-6: Edit / delete past entries with no time limit
**As a user**, I want to view, correct, or delete any of my past meal entries — at any depth in my history — **so that** I can fix misrecognized meals at any time without time-window constraints.

**Acceptance:**
- [ ] Given the user requests history (via command or natural-language ask), when the bot returns a paginated list (page size: 5 meals per page, newest first), then the user can select any past confirmed meal record to edit (items / portions / KBJU) or delete.
- [ ] After an edit or delete, future summaries reflect the corrected data; already-delivered summaries are NOT retroactively rewritten — instead, the next periodic summary surfaces the delta between the previously reported figure and the corrected one.
- [ ] Each edit and delete is recorded in a per-user audit log retained alongside the meal record.

### US-7: Failure UX with manual fallbacks
**As a user**, I want clear recovery paths when the bot fails to transcribe my voice, fails to recognize my photo, or fails to compute KBJU, **so that** I am never stuck and can always log the meal.

**Acceptance:**
- [ ] If voice transcription fails on first attempt, the bot replies in Russian: «Не расслышал, напиши текстом» and waits for text. After a second consecutive transcription failure on a follow-up voice message, the bot offers «Введи КБЖУ вручную» and presents a guided manual-entry form.
- [ ] If KBJU computation fails (the lookup-and-LLM path returns no usable answer), the bot apologizes in Russian and offers a guided manual-entry form for calories, protein, fat, carbs.
- [ ] Transient transport-layer failures auto-retry once before being shown to the user. Retries on "the model returned a suspicious response" are not allowed (Architect enforces in skill code).
- [ ] All manual-entry meals are stored under the user's tenant scope, marked as `manual_entry`, and treated equivalently for summaries.

### US-8: Right-to-delete
**As a user**, I want a single command that permanently deletes all my data, **so that** I can leave the service whenever I want.

**Acceptance:**
- [ ] The bot exposes a Russian-language command (e.g. `/forget_me`) and a corresponding natural-language phrase that triggers the same flow.
- [ ] On invocation, the bot asks for explicit confirmation in Russian (single yes / no, not multi-step), and on confirmation deletes all records linked to the user (biometric profile, meal records, summaries, audit log) and stops sending future summaries.
- [ ] After deletion, a subsequent `/start` from the same Telegram account begins onboarding from scratch with no residual personalization.

### US-9: Multi-tenant data isolation
**As either pilot user**, I want a guarantee that my data is invisible to the other user, **so that** I can use the bot without privacy concerns and so the same data model can support a paid multi-tenant product later.

**Acceptance:**
- [ ] Every persistent record (biometric profile, meal record, summary, audit log entry, transcript, manual-entry meal) is scoped at the storage layer to a single user identity. Unscoped queries that return data across users are not permitted.
- [ ] No bot reply, periodic summary, or history view ever contains data attributable to a user other than the recipient.
- [ ] At end of pilot, an audit query designed to find any cross-user reference in stored data returns zero results.

## 6. Success Metrics / KPIs

| # | Metric | Baseline | Target | Measurement method |
|---|---|---|---|---|
| K1 | Daily confirmed meals logged per active pilot user | 0 (new product, no prior data) | ≥3/day on ≥5 of any rolling 7-day window, sustained for the 30-day pilot | Server-side count of confirmed meal records per user per calendar day |
| K2 | Time-to-first-value (first user meal-content message → first KBJU draft reply) | n/a | ≤120 seconds end-to-end, every user in the pilot | Server-side timestamps of inbound message and outbound KBJU reply for each user's first meal-content event |
| K3 | Voice round-trip latency p95, voice messages ≤15 s long | n/a | ≤8 s soft (p95), ≤30 s hard (p100) over rolling 7-day windows for 30-day pilot | Server-side timestamps from voice receipt to KBJU draft reply; computed nightly |
| K4 | Cross-user data leaks during 30-day pilot | n/a | 0 | End-of-pilot manual audit of the primary user-data store (the records enumerated in US-9 AC1: biometric profiles, meal records, summaries, audit log entries, transcripts, manual-entry meals) for cross-user references. Application logs, observability traces, and router billing records are NOT in K4 scope and are governed separately by §7 data-retention rules and §8 legal-exposure risk |
| K5 | Monthly LLM + voice-transcription spend (2-user pilot) | n/a | ≤$10/month total; auto-degrade triggers on overage | Provider invoices / router billing reports, reviewed monthly |
| K6 | Weekly retention of pilot users | n/a | Both pilot users active ≥7/7 days/week for 4 of 4 pilot weeks. "Active" = ≥1 confirmed meal logged that day | Server-side count of distinct days with ≥1 confirmed meal per user |
| K7 | KBJU estimation accuracy (per-meal and per-day targets) | n/a | TBD by §9 Open Q after Architect feasibility analysis | Manual labelling sample of pilot logs vs. ground-truth references; method finalized after target is set |

## 7. Technical Envelope (constraints Architect must respect)

- **Channel (PO-locked):** Telegram, exclusively.
- **Runtime (PO-locked):** openclaw skill runtime on TypeScript / Node 24, hosted on the PO's existing self-hosted VPS. Architect designs within this envelope and does not revisit it.
- **Resource ceiling on the VPS:** the KBJU Coach skill stack must hold ≤25% of VPS CPU at p95 and ≤2 GB resident RAM at steady state for the 2-user pilot. Concrete VPS specs to be verified by Architect against the live host.
- **Cost ceiling:** hard ceiling of **$10 / month** total for LLM inference plus voice transcription combined for the 2-user pilot. The skill manifest MUST declare per-call input and output token budgets such that exceeding them is a runtime error rather than silent overspend. On monthly trend pointing at overage, the system MUST auto-degrade (cheaper model and / or skip the optional lookup leg of the hybrid KBJU path) and emit an alert to the PO.
- **Latency budget (all measured server-side, end-to-end from inbound user message to first user-facing reply):**
  - Voice round-trip (voice ≤15 s long): soft ≤8 s p95, hard ≤30 s p100. Telegram "typing…" indicator MUST be shown continuously during processing.
  - Text round-trip (text meal description): soft ≤5 s p95, hard ≤15 s p100.
  - Photo round-trip (photo → estimate-with-confirm-prompt): soft ≤12 s p95, hard ≤45 s p100.
- **Localization:** Russian-only UX in v0.1.
- **Multi-tenant data isolation:** every persistent record MUST be scoped by user identity at the storage layer from day 1 (US-9). Cross-user queries are forbidden by design. The data model is expected to support tenant counts well beyond 2 without rework.
- **Data retention and compliance:**
  - Raw voice clips and raw photo bytes MUST be deleted immediately after KBJU extraction completes. No archival of raw media.
  - Transcripts and confirmed meal records (including manual-entry records) are retained indefinitely until the user invokes right-to-delete (US-8).
  - Right-to-delete (US-8) is mandatory in v0.1.
  - Russian-language non-medical disclaimer MUST be shown at onboarding (US-1).
  - Telegram Bot Platform Terms of Service apply; the Architect's specification must call out any obligations they impose (e.g. on automated messaging, on data subjects who do not initiate).
  - Data hosting jurisdiction for stored user records: PO selects from a shortlist provided by the Architect in the ArchSpec; the choice affects §8 legal-exposure risk and §7 latency.
- **External dependencies that the Architect must integrate against (the choice of provider for each is the Architect's, not the Business Planner's):**
  - Telegram Bot Platform (channel; PO-locked).
  - openclaw runtime (PO-locked).
  - A voice-transcription service capable of conversational Russian at the §6 K3 latency budget and the §7 cost ceiling.
  - A food / nutrition reference database to support the hybrid KBJU lookup path (lookup → LLM fallback). If integration cost exceeds the §7 cost ceiling, degradation to LLM-only is permitted; Architect documents the call in an ADR.
  - An LLM provider routing layer aligned with the project-wide router policy (`docs/knowledge/llm-routing.md`) — Architect chooses concrete models in an ADR.
- **Observability minimums:** per-user latency, per-call cost, transcription success / failure rate, KBJU computation success / failure rate, and confirmation rates on US-2 / US-3 / US-4 must be measurable at end-of-pilot. Architect specifies the concrete logging schema in the ArchSpec.

## 8. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| KBJU estimation accuracy below user expectation | Med | High | Mandatory user confirmation gate on photo logs (US-4); itemized estimate visible on every voice / text log with edit affordance (US-2, US-3); edit-anytime on past records (US-6); §9 Open Q closes accuracy target after Architect feasibility |
| Voice transcription unreliable on Russian conversational speech | High | Med | Failure UX with text and manual KBJU fallbacks (US-7); soft latency target leaves headroom; Architect chooses provider with proven Russian quality |
| Monthly cost overrun beyond $10/month ceiling | Med | Med | Auto-degrade path defined (§7); per-call token budgets enforced at runtime; monthly review against invoices (K5); PO alert before hard breach |
| Cross-user data leak | Critical | Low | Multi-tenant scoping mandatory at storage layer from day 1 (US-9); end-of-pilot audit (K4); pilot starts with only 2 users so blast radius is bounded |
| Pilot user attrition (low retention) | Med | Med | Personalized targets at onboarding (US-1); short personalized recommendations in summaries (US-5); failure UX never strands a user (US-7); soft latency targets prioritize feel over feature breadth |
| Single curated assistant personality misses both pilot users' preferences | Med | Med | Personality is editable by the PO between weekly checkpoints in the pilot; v0.1 explicitly defers per-user personality customization to a future tier (NG10) |
| VPS or runtime outage interrupts logging | Med | Low | Failure UX includes manual entry as a final fallback (US-7); right-to-delete is non-time-critical and can recover after outage; informal monthly uptime expectation ≥99% — Architect formalizes target in ArchSpec §8 |
| Personal-data legal exposure varies by hosting jurisdiction | Med | Low | Hosting jurisdiction is a PO choice from Architect's shortlist (§7); right-to-delete shipped in v0.1 (US-8); raw voice / photo deleted post-extraction so the long-tail dataset is text-only |
| Onboarding intake feels long and users abandon before first meal log | Med | Med | Optional fields kept optional with disclosed defaults (US-1); explicit re-ask on validation failure rather than dead-end errors; onboarding can be re-entered later if user skipped at first attempt |

## 9. Open Questions (resolve BEFORE handoff to Architect)
- **OQ-1 — KBJU estimation accuracy target.** Numeric per-meal and daily-aggregate accuracy targets for K7 are not yet set. The PO declined to commit a number without grounding; the Business Planner declined to fabricate one. Resolution: the Architect produces a feasibility bound based on the chosen voice / vision / lookup / LLM stack, then the PO ratifies a target before the ArchSpec is frozen. Until then, K7 is recorded as TBD and the rest of the PRD does not depend on a specific numeric accuracy target.
- **OQ-2 — Partner user's personal logging-volume target (G1, K1).** The G1 target of ≥3 meals/day per user inherits the PO's preference; the partner's own preference has not yet been confirmed by her directly. Resolution (PO-escalated, 2026-04-26): PO will confirm with the partner before pilot start. Until confirmed, G1 / K1 use the PO's value (≥3/day) as a working default for both pilot users; if the partner asks for a different number on her side, K1 splits into per-user values without re-opening this PRD. This OQ remains `open` until PO records the partner's response in a follow-up commit (or marks it `answered` on confirmation).
- **OQ-3 — Data hosting jurisdiction.** Choice between candidate jurisdictions for stored user records (affects §8 legal-exposure risk, §7 latency). Resolution: Architect produces a shortlist with cost / latency / legal trade-offs in the ArchSpec; PO selects.

## 10. Out of Scope (explicitly deferred)
- Calendar integration of any kind (NG1).
- Fitness, exercise, and step tracking (NG2). May be added as a separate epic if pilot retention demands it.
- Public release / open sign-up / bot marketplace (NG3). Required before any paid product launch — separate epic.
- Payment, subscription, billing, and promo flows (NG4). The data model is multi-tenant from day 1 (US-9, §7) so that billing can be added as a separate epic without rework.
- Admin web UI / dashboards (NG5).
- Nutrition coaching beyond KBJU (NG6).
- Medical / clinical advice (NG7).
- Barcode / packaged-goods scanning (NG8).
- Social sharing / friend leaderboards / public profiles (NG9). Strong candidate for a follow-up revision once the pilot proves logging volume; requires a consent and anonymization design that does not exist yet.
- Per-user assistant personality customization (NG10). Strong candidate for the premium tier of the future paid product.
- Multi-language UX (Russian only in v0.1).
- Multi-channel delivery (Telegram only in v0.1).

---

## Handoff Checklist (author ticks all before setting status to `approved`)
- [ ] All sections filled; no TODO / TBD outside §9 Open Questions — K7 target column in §6 reads `TBD by §9 Open Q after Architect feasibility analysis`; this is intentional and tracked in OQ-1, but the assertion as written cannot be ticked. reviewer is asked to validate that this is the only outstanding TBD.
- [x] Non-Goals explicitly listed (≥1)
- [x] Each User Story has testable Acceptance Criteria
- [x] KPIs are measurable (numeric target and window)
- [x] Technical Envelope contains concrete numbers
- [ ] Open Questions are closed or explicitly escalated to PO — currently 3 escalated; PO closes before approval
- [x] No tech stack, no schemas, no API endpoints anywhere in the document
