---
id: TKT-047
title: 'Mood-comment overflow alignment (200 silent → 280 with friendly notice)'
status: in_review
arch_ref: ARCH-001@0.7.0
prd_ref: PRD-001@0.3.0
component: C20 Mood Logger
depends_on: []
blocks: []
estimate: S
created: 2026-05-25
updated: 2026-05-25
---

# TKT-047: Mood-comment overflow alignment (200 silent → 280 with friendly notice)

## 1. Goal
Align `src/modality/mood/` shipped behaviour with the canonical contract picked in Q-TKT-031-01: `limit=280`, `behaviour=truncate-to-280-chars`, `reply="Сократила комментарий до 280 символов. Записала настроение N/10."` per ARCH-001@0.6.2 §6.2.2 C20 + PRD-003@0.1.3 §2 G4 + the schema CHECK already on `main`.

## 2. In Scope
- `src/modality/mood/logger.ts` (or wherever the truncation lives; TKT-031@0.1.0 outputs are the source of truth) updated:
  - Limit changed from 200 to 280 chars.
  - Behaviour changed from "drop comment if overlength" to "truncate comment to first 280 chars".
  - On overflow, emit the friendly Russian reply: `Сократила комментарий до 280 символов. Записала настроение N/10.` per ARCH-001@0.6.2 §6.2.2 C20 verbatim string.
- `src/modality/mood/copy.ru.ts`: add the `COMMENT_TRUNCATED_REPLY` template string verbatim.
- TKT-031@0.1.0 §2 In-Scope text drift fix: change "Optional comment: truncate to ≤200 chars; drop comment if overlength rather than fail-open." to "Optional comment: truncate to ≤280 chars; emit friendly Russian notice on overflow." This is a docs-zone edit (`docs/tickets/`), so the *executor* may NOT do it under standard guardrails — but the ticket explicitly lists it in §5 Outputs, so per CONTRIBUTING.md §6 the executor is authorised for this specific file.
- Tests:
  - `tests/modality/mood/logger.test.ts` extended:
    - Comment of length 281: persisted as the first 280 chars; reply matches the new copy.
    - Comment of length ≤280: persisted unchanged; reply unchanged.
    - Comment of length exactly 280: persisted unchanged (boundary).
- Q-TKT-031-01.md frontmatter and answer block already updated by the Architect in ARCH-001@0.7.0; this ticket does NOT touch the Q-file.

## 3. NOT In Scope
- Changing the 1-10 score-range guardrail (PRD-003@0.1.3 §2 G4 unchanged).
- Changing the 5-minute pending-inference TTL.
- Changing the inferred-score confirmation flow.
- Changing the modality-OFF gate.
- Touching any other `src/modality/` directory.

## 4. Inputs
- Q-TKT-031-01@latest (the architect's answer; this ticket is the §D3 follow-up)
- ARCH-001@0.7.0 §6.2.2 C20 (verbatim Russian copy)
- PRD-003@0.1.3 §2 G4, §5 US-4 (the 280 limit)
- TKT-031@0.1.0 (the source of the current 200 silent behaviour and the §2 text drift)
- `src/modality/mood/logger.ts` (existing — the file being adjusted)
- `src/modality/mood/copy.ru.ts` (existing — receives the new string)
- `src/store/schema.sql` (existing — the schema CHECK is already 280, no change here)

## 5. Outputs
- [ ] `src/modality/mood/logger.ts` updated: limit 200→280, drop→truncate, silent→friendly notice.
- [ ] `src/modality/mood/copy.ru.ts` adds `COMMENT_TRUNCATED_REPLY = "Сократила комментарий до 280 символов. Записала настроение {score}/10."`.
- [ ] `tests/modality/mood/logger.test.ts` extended with the three boundary cases in §2.
- [ ] `docs/tickets/TKT-031-c20-mood-logger.md` §2 line "Optional comment: truncate to ≤200 chars; drop comment if overlength rather than fail-open." replaced with "Optional comment: truncate to ≤280 chars; emit friendly Russian notice on overflow."

## 6. Acceptance Criteria
- [ ] `npm test -- tests/modality/mood/logger.test.ts` passes.
- [ ] `npm run lint` clean. `npm run typecheck` clean (strict).
- [ ] Schema CHECK (length ≤280) accepts every truncated value (the new behaviour never produces a value over 280).
- [ ] Manual smoke: a Telegram mood event with a 285-char Russian comment persists `comment_text` of length 280; reply matches the verbatim friendly-notice string.
- [ ] No silent-drop path remains.
- [ ] TKT-031@0.1.0 §2 text drift fixed.

## 7. Constraints
- Do NOT change the schema (already 280 on `main`; verified per BACKLOG-001 / Q-TKT-031-01 context).
- Do NOT change the score-range or TTL behaviour.
- The friendly-notice string is the verbatim ARCH-001@0.6.2 §6.2.2 C20 copy — copy it character-for-character (curly quotes, em-dash usage, etc., follow whatever the current §6.2.2 spec uses).
- Truncation is by character (Unicode code-point), not by byte; Russian is Cyrillic and a `String.prototype.slice(0, 280)` on JS strings is correct because JS strings are UTF-16 code-unit indexed and the Russian alphabet's BMP code points are 1 code unit each — but be defensive: any `Array.from(s).slice(0, 280).join("")` is equivalent and preserves astral characters if a user pastes emoji. Pick whichever passes the test; document the choice in the PR body.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass.
- [ ] PR opened with link to this TKT in description (version-pinned).
- [ ] Executor filled §10 Execution Log.
- [ ] Ticket frontmatter `status: in_review` in a separate commit.

## 10. Execution Log
<!-- executor fills as work proceeds -->

- 2026-05-25T12:00:00Z opencode-executor: started

- 2026-05-25T12:30:00Z opencode-executor: in_review; tests 37 pass; lint clean; typecheck clean. No divergence between ARCH-001@0.7.0 §6.2.2 C20 and TKT-047@0.1.0 §5 Outputs — both agree on the {score} placeholder pattern per existing copy.ru.ts convention. Truncation uses Array.from(s).slice(0,280).join("") per §7 constraint.
