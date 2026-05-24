---
id: TKT-001
title: TypeScript OpenClaw Project Scaffold
status: done
arch_ref: ARCH-001@0.2.0
component: Shared runtime scaffold
depends_on: []
blocks:
- TKT-002@0.1.0
- TKT-003@0.1.0
- TKT-004@0.1.0
- TKT-005@0.1.0
- TKT-006@0.1.0
- TKT-007@0.1.0
- TKT-008@0.1.0
- TKT-013@0.1.0
estimate: M
created: 2026-04-26
updated: 2026-04-26
closed_at: 2026-04-26
closed_by: orchestrator (PO-delegated)
review_ref: null
---

# TKT-001: TypeScript OpenClaw Project Scaffold

## 1. Goal (one sentence, no "and")
Create the Node 24 TypeScript project scaffold for OpenClaw skill modules.

## 2. In Scope
- Initialize the root Node package for TypeScript source under `src/` and Vitest tests under `tests/`.
- Define shared OpenClaw-facing types for Telegram events, skill context, provider calls, config, and Russian reply envelopes.
- Add deterministic configuration parsing for required environment variable names without reading real secret values in tests.
- Add a minimal root export that future tickets can import.

## 3. NOT In Scope (Executor must NOT touch these — Reviewer fails on violation)
- No database schema or repository implementation; that belongs to TKT-002@0.1.0.
- No Telegram routing behavior; that belongs to TKT-004@0.1.0.
- No production Docker or Compose files; that belongs to TKT-013@0.1.0.

## 4. Inputs (Executor MUST read before writing code; nothing else)
- ARCH-001@0.2.0 §2 Architecture Overview
- ARCH-001@0.2.0 §3 Components C1 through C11
- ARCH-001@0.2.0 §9 Security
- docs/knowledge/openclaw.md
- README.md
- CONTRIBUTING.md
- AGENTS.md

## 5. Outputs (deliverables — Executor's diff MUST match this list exactly)
- [ ] `package.json` with scripts `test`, `lint`, `typecheck`, and `build`
- [ ] `package-lock.json`
- [ ] `tsconfig.json` configured for Node 24, strict TypeScript, `src/`, and `tests/`
- [ ] `src/index.ts` exporting the scaffolded public symbols
- [ ] `src/shared/types.ts` exporting OpenClaw, Telegram, KBJU, provider, and result types
- [ ] `src/shared/config.ts` exporting config parsing without logging secret values
- [ ] `tests/scaffold/config.test.ts` covering required config parsing and secret redaction

## 6. Acceptance Criteria (machine-checkable)
- [ ] `npm install` completes and creates `package-lock.json`.
- [ ] `npm test -- tests/scaffold/config.test.ts` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes with `strict` enabled.
- [ ] `npm run build` emits compiled files without TypeScript errors.
- [ ] Tests prove missing required config names fail with field names only, never secret values.

## 7. Constraints (hard rules for Executor)
- Allowed new dev dependencies: `typescript`, `tsx`, `vitest`, `@types/node`.
- Do NOT add runtime dependencies in this ticket.
- Use Node 24 built-ins where possible.
- Do NOT create `src/` modules for business flows beyond shared types/config.
- All exported types must be reusable by later tickets without importing test-only code.
- GLM assignment is appropriate because this is low-risk project scaffolding.

## 8. Definition of Done
- [ ] All Acceptance Criteria pass
- [ ] PR opened with link to this TKT in description (version-pinned)
- [ ] No `TODO` / `FIXME` left in code without a follow-up TKT suggestion logged in PR body
- [ ] Executor filled §10 Execution Log
- [ ] Ticket frontmatter `status: in_review` in a separate commit
