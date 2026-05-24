---
id: RV-SPEC-ARCH-XXX
type: spec_review
target_ref: ARCH-XXX@X.Y.Z
status: in_review
created: YYYY-MM-DD
---

# Spec Review — ARCH-XXX

## Summary
<Overall verdict in 2-3 sentences. No fluff.>

## Verdict
- [ ] pass
- [ ] pass_with_changes
- [ ] fail

One-sentence justification: <…>

## Findings

### High (blocking)
- **F-H1 (§section, file:line):** <issue> — *Responsible role:* <Architect | PRD author>. *Suggested remediation:* <concrete action>.

### Medium
- **F-M1 (§section):** <issue> — *Responsible role:* <…>. *Suggested remediation:* <…>.

### Low (nit / cosmetic)
- **F-L1 (§section):** <issue>.

### Questions for Architect
- **Q1:** <clarification needed>.

## Cross-reference checklist (Reviewer ticks)
- [ ] §0 Recon Report present, ≥3 fork-candidates audited per major capability
- [ ] All PRD sections claimed as "implemented" actually have a covering component (Trace matrix walk)
- [ ] All Non-Goals from PRD are respected (grep against ArchSpec + Tickets)
- [ ] Resource budget fits PRD Technical Envelope (numeric)
- [ ] Every Ticket in Work Breakdown is atomic (one-sentence Goal)
- [ ] Every ADR evaluates ≥3 real options with concrete trade-offs
- [ ] All references are version-pinned (`@X.Y.Z`)
- [ ] §8/§9/§10 (Observability/Security/Deployment) non-empty with concrete choices
- [ ] Rollback procedure is a real command sequence, not "revert"

## Red-team probes (Reviewer must address each)
- What happens if openclaw / VPS goes down mid-flow?
- How does the system behave at 10× expected user count?
- Which prompt-injection vectors apply to LLM-fed components?
- What is the data-retention story? Where is PII stored, for how long, deletable how?
- Concurrency: can two updates race for the same DB row?
