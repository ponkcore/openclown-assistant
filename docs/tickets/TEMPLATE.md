---
id: TKT-XXX
title: ''
status: draft
arch_ref: ARCH-XXX@X.Y.Z
component: ''
depends_on: []
blocks: []
estimate: S
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# TKT-XXX: <Title>

## 1. Goal (one sentence, no "and")
<What this ticket achieves, in one atomic sentence.>

## 2. In Scope
- <file or module to create>
- <config to add>
- <migration>
- <tests>

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- <explicitly excluded item>
- <belongs to another ticket — reference TKT-YYY@X.Y.Z>

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-XXX@X.Y.Z §<section>
- ADR-XXX@X.Y.Z
- <existing file: src/path/...>

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `src/path/to/new_file.ts` exporting `<symbol>`
- [ ] `config/...yaml`
- [ ] `migrations/NNN_....sql`
- [ ] `tests/path/<file>.test.ts` (coverage ≥80% for the new module)
- [ ] Updated section of README, if and only if listed here

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm test -- tests/path/<file>.test.ts` passes
- [ ] Manual smoke: `<command>` produces `<expected output>`
- [ ] `npm run lint` clean
- [ ] `npm run typecheck` clean (strict)
- [ ] Logs in required format (see ARCH §8)

## 7. Constraints (hard rules for Executor)
- Do NOT add new runtime dependencies except: <explicit allowlist>
- Do NOT modify schemas of other tables/entities
- Do NOT touch `src/core/**` — return a Q-TKT if you think you need to
- Use existing `<helper>` from `src/core/...`
- All SQL parameterised; no string-concatenated queries
- All external text fed to an LLM passes through `<sanitiser>` per ARCH §9

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit

## 9. Questions (empty at creation; Executor appends here ONLY if blocked — do NOT start code)
<!-- Q1 (YYYY-MM-DD, model-id): question text — see docs/questions/Q-TKT-XXX-NN.md -->

## 10. Execution Log (Executor fills as work proceeds)
<!-- YYYY-MM-DD HH:MM model-id: started -->
<!-- YYYY-MM-DD HH:MM model-id: opened PR #NN -->

---

## Handoff Checklist (Architect ticks before setting status to `ready`)
- [ ] Goal is one sentence, no conjunctions
- [ ] NOT-In-Scope has ≥1 explicit item
- [ ] Acceptance Criteria are machine-checkable (no "looks good")
- [ ] Constraints explicitly list forbidden actions
- [ ] All ArchSpec / ADR references are version-pinned
- [ ] `depends_on` accurately reflects prerequisites; no cycles
- [ ] `assigned_executor` is justified (especially Codex — explain why GLM cannot)
