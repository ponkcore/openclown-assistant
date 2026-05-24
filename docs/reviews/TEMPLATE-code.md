---
id: RV-CODE-XXX
type: code_review
target_pr: "<PR URL>"
ticket_ref: TKT-XXX@X.Y.Z
status: in_review
created: YYYY-MM-DD
---

# Code Review — PR #NN (TKT-XXX)

## Summary
<Overall verdict in 2-3 sentences.>

## Verdict
- [ ] pass
- [ ] pass_with_changes
- [ ] fail

One-sentence justification: <…>
Recommendation to PO: <approve & merge | request changes from Executor | block until Architect clarifies>.

## Contract compliance (each must be ticked or marked finding)
- [ ] PR modifies ONLY files listed in TKT §5 Outputs
- [ ] No changes to TKT §3 NOT-In-Scope items
- [ ] No new runtime dependencies beyond TKT §7 Constraints allowlist
- [ ] All Acceptance Criteria from TKT §6 are verifiably satisfied (file:line or test name cited)
- [ ] CI green (lint, typecheck, tests, coverage)
- [ ] Definition of Done complete
- [ ] Ticket frontmatter `status: in_review` in a separate commit

## Findings

### High (blocking)
- **F-H1 (file:line):** <issue> — *Responsible role:* Executor. *Suggested remediation:* <concrete>.

### Medium
- **F-M1 (file:line):** <issue>.

### Low
- **F-L1 (file:line):** <nit>.

## Red-team probes (Reviewer must address each)
- Error paths: what happens on Telegram/OpenFoodFacts/Whisper API failure, DB lock, LLM timeout?
- Concurrency: can two messages from the same user be processed simultaneously?
- Input validation: malformed voice / corrupt photo / huge text / unicode edge cases?
- Prompt injection: does any external string reach an LLM unsanitised (vs ARCH §9)?
- Secrets: any credential committed, logged, or leaked through error messages?
- Observability: can a 3am operator debug an incident from logs alone?
