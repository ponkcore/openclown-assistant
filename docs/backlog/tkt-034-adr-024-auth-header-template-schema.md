---
id: BACKLOG-008
title: Document `auth_header_template` knob in ADR-024 §Schema example (TKT-034 carry-forward)
status: open
spec_ref: TKT-034@0.1.0
created: 2026-05-25
---

# BACKLOG-008: Formalise `auth_header_template` in ADR-024@0.1.0 §Schema example

Carried forward from RV-CODE-020 finding F-M1 (verdict `pass_with_changes`, deferred).

## Summary
TKT-034@0.1.0 §2 In-Scope explicitly cites the `auth_header_template` knob on `providers[*]` in the model registry: "if `providers[*].auth_header_template` is set, use it instead of the default `Authorization: Bearer <key>`". The TKT-034 executor wired this in by extending `ProviderEntry` and `Resolved` types in `src/llm/registry.ts` and exercising the variant case in tests (§6 AC #4 covers `auth_header_template: "Token {key}"`).

The knob is justified by TKT-034@0.1.0 §2 prose, but ADR-024@0.1.0 §Schema example does not document it — only `base_url` and `api_key_env` appear in the schema spec. As a result the registry's authoritative contract is described in two places (the ADR schema example and the ticket prose) that are not yet reconciled.

## Why backlogged (not iterated)
- The runtime behaviour is correct and tested.
- TKT-034@0.1.0 has already merged (commit forthcoming on `main`).
- The fix is a docs-zone edit on ADR-024 — outside any code-executor's write-zone, and outside `architect-consult` unless the orchestrator requests it. The `external Architect` (PO-curated outside opencode) is the natural author for a clean ADR-024 §Schema patch bump.

## Follow-up
Two acceptable paths:
1. **PO opens an external Architect session** to amend ADR-024@0.1.0 §Schema example with the `auth_header_template?: string` knob, bump ADR-024 patch (0.1.0 → 0.1.1), append to revision log: `corrected §Schema example to document auth_header_template knob already implemented in TKT-034@0.1.0`. The new pinning will then cascade into ARCH-001 if any §3.5 / §6 prose still references `ADR-024@0.1.0`.
2. **Sisyphus auto-call architect-consult** if/when a future ticket re-touches the registry; the auto-call's write-zone covers `docs/architecture/**` patch fixes per CONTRIBUTING.md.

Either way the runtime behaviour does not change — this is a documentation/contract reconciliation only.

## Status
- 2026-05-25 BACKLOG-008 opened during TKT-034 close-out.
