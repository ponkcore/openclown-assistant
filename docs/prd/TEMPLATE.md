---
id: PRD-XXX
title: ''
version: 0.1.0
status: draft
owner: '@po'
created: YYYY-MM-DD
updated: YYYY-MM-DD
supersedes: null
superseded_by: null
related: []
---

# PRD-XXX: <Title>

## 1. Problem Statement
<One paragraph. What user/business problem are we solving, and why now?>

## 2. Goals (SMART)
- G1: <measurable goal with metric and deadline>
- G2:...

## 3. Non-Goals (explicitly NOT in this epic)
- NG1: <to prevent scope creep>
- NG2:...

## 4. Target Users / Personas
- P1: <who, context, motivation>

## 5. User Stories & Acceptance Criteria
### US-1: <As a..., I want..., so that...>
**Acceptance:**
- [ ] Given..., when..., then...
- [ ]...

## 6. Success Metrics / KPIs
| Metric | Baseline | Target | Measurement method |
|---|---|---|---|
| <metric> | <now> | <target> | <how measured> |

## 7. Technical Envelope (constraints Architect must respect)
- Infra: <e.g. shared VPS 6c/8GB>
- LLM budget: <tokens/day or $/month>
- Latency budget: <soft/hard targets>
- Compliance: <GDPR / Telegram ToS / local law / personal data handling>
- External dependencies: <APIs this must integrate with — Telegram, OpenFoodFacts, Whisper, etc.>

## 8. Risks & Mitigations
| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|

## 9. Open Questions (resolve BEFORE handoff to Architect)
- Q1:...

## 10. Out of Scope (explicitly deferred)
-...

---

## Handoff Checklist (author ticks all before setting status to `approved`)
- [ ] All sections filled; no TODO / TBD outside §9 Open Questions
- [ ] Non-Goals explicitly listed (≥1)
- [ ] Each User Story has testable Acceptance Criteria
- [ ] KPIs are measurable (not "improve" — numeric target and window)
- [ ] Technical Envelope contains concrete numbers
- [ ] Open Questions are closed or explicitly escalated to PO
- [ ] No tech stack, no schemas, no API endpoints anywhere in the document
