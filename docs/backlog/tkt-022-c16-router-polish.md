---
id: BACKLOG-002
title: TKT-022 C16 Modality Router low-priority polish
status: open
spec_ref: PRD-003@0.1.3
created: 2026-05-24
---

# TKT-022 C16 Modality Router — Low-priority polish

Carried forward from RV-CODE-002 iter-2. All four findings are Low-severity stylistic / minor-correctness items that did not block merge.

## L1. Redundant `\s` alternative in router lookbehind

- Source finding: RV-CODE-002 F-L1 (`src/modality/router.ts:133`).
- The lookbehind `(?<=^|\s|[^\p{L}])` contains a redundant `\s` alternative — `[^\p{L}]` already covers all whitespace characters (whitespace is not a letter). The `\s` alternative is dead code in the alternation.
- Required action: drop the `\s` alternative.

## L2. Misleading `classifierResult` in deterministic-only golden case

- Source finding: RV-CODE-002 F-L2 (`tests/modality/router.golden.test.ts:439–444`).
- The golden test case "det: вздремнул → SLEEP (deterministic)" provides a `classifierResult` in its test data but expects `deterministic_single`. The classifier mock is never invoked on this path, making the provided `classifierResult` misleading.
- Required action: remove the unused `classifierResult` from the deterministic-only golden case.

## L3. Naming inconsistency between prompt instruction and JSON key

- Source finding: RV-CODE-002 F-L3 (`src/modality/router-classifier.ts:186`).
- `buildUserContent` serialises the message as `JSON.stringify({ message_text: text })` but the system prompt template in `config/modality-router-classifier.json` refers to `message_text_ru`. Minor naming inconsistency.
- Required action: align the JSON key with the prompt's reference (either rename the key or update the prompt template).
