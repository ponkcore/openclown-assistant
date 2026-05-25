#!/usr/bin/env python3
"""Validate all markdown artifacts in docs/.

Checks:
- YAML frontmatter is present and parseable
- Required fields are present per artifact type
- `status` is from the allowed set for that type
- Version-pinned references (`PRD-XXX@X.Y.Z`, `ARCH-XXX@X.Y.Z`, `ADR-XXX@X.Y.Z`,
  `TKT-XXX@X.Y.Z`) actually resolve to existing artifacts
- TEMPLATE.md files are ignored
- `supersedes` / `superseded_by` refer to real artifacts

Exit 0 on success, 1 on any failure. Used by CI.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    import yaml
except ImportError:
    print("ERROR: pyyaml is required. Install with: pip install pyyaml", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parent.parent
DOCS_ROOT = REPO_ROOT / "docs"

# Directories under docs/ that are NOT typed artifact directories (no
# frontmatter required). Files inside these are free-form meta docs.
# `personality` holds PERSONA-XXX system-prompt skeletons read at runtime
# by the recommendation skill (see ARCH-001 §6 External Interfaces).
# `roadmap` holds Business-Planner-authored roadmap / vision documents
# (ROADMAP-NNN-*.md) — strategic-direction artifacts that span multiple
# PRDs and may evolve over time without strict semver. See
# docs/roadmap/README.md.
# `drafts` holds PO-pending content drafts produced by Sisyphus (e.g.
# PRD-NNN-content-drafts.md): keyword chains, copy strings, golden test
# sets that the executor reads as ticket inputs and the PO refines on
# their own schedule.
FREEFORM_DIRS = {"prompts", "knowledge", "personality", "roadmap", "drafts"}
# Free-form top-level docs/*.md files (non-artifact reference material).
FREEFORM_TOPLEVEL: set[str] = set()

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
# A leading `(?<![A-Za-z-])` prevents matching the `TKT-002` substring inside
# a Q-file cross-reference like `Q-TKT-002-01.md`, which is a question filename,
# not a TKT artifact reference. Without this guard, the validator false-positives
# every Q file body that mentions another Q file. The same guard on REF_RE keeps
# behaviour symmetric for pinned references.
REF_RE = re.compile(r"(?<![A-Za-z-])(PRD|ARCH|ADR|TKT)-(\d{3,})@(\d+\.\d+\.\d+)")

# (required_fields, allowed_statuses)
TYPE_RULES: dict[str, tuple[set[str], set[str]]] = {
    "prd": (
        {"id", "title", "version", "status", "owner", "created"},
        {"draft", "in_review", "approved", "superseded"},
    ),
    "architecture": (
        {"id", "title", "version", "status", "prd_ref", "owner", "created"},
        {"draft", "in_review", "approved", "superseded"},
    ),
    "adr": (
        {"id", "title", "status", "arch_ref", "created"},
        {"proposed", "accepted", "rejected", "superseded"},
    ),
    "tickets": (
        {"id", "title", "status", "arch_ref", "created"},
        {"draft", "ready", "in_progress", "in_review", "done", "blocked"},
    ),
    "reviews": (
        {"id", "type", "status", "created"},
        {"in_review", "approved", "changes_requested"},
    ),
    "questions": (
        {"id", "status", "ticket_ref", "asker_model", "created"},
        {"open", "answered", "superseded"},
    ),
    "backlog": (
        {"id", "title", "status", "spec_ref", "created"},
        {"open", "in_progress", "closed"},
    ),
}

ID_PREFIX_FOR_TYPE = {
    "prd": "PRD",
    "architecture": "ARCH",
    "adr": "ADR",
    "tickets": "TKT",
    "reviews": "RV",
    "questions": "Q",
    "backlog": "BACKLOG",
}


@dataclass
class Artifact:
    path: Path
    type_: str
    frontmatter: dict
    body: str


def load_artifact(path: Path) -> Artifact | None:
    text = path.read_text(encoding="utf-8")
    m = FRONTMATTER_RE.match(text)
    if not m:
        return None
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError as e:
        raise ValueError(f"YAML parse error in {path}: {e}") from e
    body = text[m.end():]
    rel = path.relative_to(DOCS_ROOT)
    parts = rel.parts
    type_ = parts[0]
    # adr is under architecture/adr
    if type_ == "architecture" and len(parts) > 1 and parts[1] == "adr":
        type_ = "adr"
    return Artifact(path=path, type_=type_, frontmatter=fm, body=body)


def collect_known_ids() -> set[str]:
    known: set[str] = set()
    for md in DOCS_ROOT.rglob("*.md"):
        if md.name.startswith("TEMPLATE"):
            continue
        try:
            art = load_artifact(md)
        except ValueError:
            continue
        if art is None:
            continue
        art_id = art.frontmatter.get("id")
        if isinstance(art_id, str):
            known.add(art_id)
    return known


def validate_artifact(art: Artifact, known_ids: set[str]) -> list[str]:
    errors: list[str] = []
    rules = TYPE_RULES.get(art.type_)
    if rules is None:
        return [f"unknown artifact type directory: {art.type_}"]
    required, statuses = rules

    for field in required:
        if field not in art.frontmatter or art.frontmatter[field] in (None, ""):
            errors.append(f"missing required frontmatter field: {field}")

    status = art.frontmatter.get("status")
    if status and status not in statuses:
        errors.append(f"invalid status '{status}'; allowed: {sorted(statuses)}")

    art_id = art.frontmatter.get("id", "")
    expected_prefix = ID_PREFIX_FOR_TYPE.get(art.type_)
    if expected_prefix and isinstance(art_id, str) and art_id != f"{expected_prefix}-XXX":
        if not art_id.startswith(expected_prefix + "-"):
            errors.append(
                f"id '{art_id}' does not match directory prefix '{expected_prefix}-'"
            )

    sby = art.frontmatter.get("superseded_by")
    if sby and isinstance(sby, str) and sby not in known_ids:
        errors.append(f"superseded_by refers to unknown artifact: {sby}")

    sup = art.frontmatter.get("supersedes")
    if sup and isinstance(sup, str) and sup not in known_ids:
        errors.append(f"supersedes refers to unknown artifact: {sup}")

    # Reviews legitimately reference the artifacts under review by ID, even
    # when the targets are not yet on `main` (e.g. a SPEC-mode review of a
    # `proposed` ADR sitting on its own arch-branch). Per
    # `docs/prompts/reviewer.md` §A.15 / §B.15 review-PR branches are forked
    # from `main`, so the target artefacts' files may not exist on the
    # rv-branch tree and would not appear in `known_ids`. Exempt the
    # artifact-ids named in:
    #   - `target_ref` (or `ticket_ref`, for code reviews) — single primary.
    #   - `target_secondary_refs` — list of additional artefacts, used by
    #     bundle-reviews where an ArchSpec extension brings new ADRs and
    #     Tickets along (first usage: RV-SPEC-013 reviewing ARCH-001@0.6.0
    #     plus ADR-014..018 plus TKT-021..028 as one coherent bundle).
    # All other references must still resolve.
    target_artifact_ids: set[str] = set()
    if art.type_ == "reviews":
        for ref_field in ("target_ref", "ticket_ref"):
            value = art.frontmatter.get(ref_field)
            if isinstance(value, str):
                m = re.match(r"\s*((?:PRD|ARCH|ADR|TKT)-\d{3,})", value)
                if m:
                    target_artifact_ids.add(m.group(1))
                    break
        secondary = art.frontmatter.get("target_secondary_refs")
        if isinstance(secondary, list):
            for entry in secondary:
                if isinstance(entry, str):
                    m = re.match(r"\s*((?:PRD|ARCH|ADR|TKT)-\d{3,})", entry)
                    if m:
                        target_artifact_ids.add(m.group(1))

    body_no_fences = re.sub(r"```.*?```", "", art.body, flags=re.DOTALL)
    # Inline-code spans (single backticks) are file paths / config keys / shell
    # tokens, not artefact references. A path like `docs/drafts/PRD-003-...md`
    # would otherwise trip the `bare_re` unpinned-reference rule. Strip them
    # before scanning for cross-references.
    body_no_fences = re.sub(r"`[^`\n]+`", "", body_no_fences)
    # Tickets carry an append-only `§10 Execution Log` of orchestrator and
    # subagent activity. Those entries are historical narrative ("PRD-003
    # walk complete", "TKT-021 merged"), not normative cross-references, and
    # the orchestrator does not version-pin them. Strip the §10 section
    # before the unpinned-reference scan so closed tickets stay valid as
    # the run history accumulates.
    if art.type_ == "tickets":
        body_no_fences = re.sub(
            r"##\s*10\.?\s*Execution Log.*?(?=\n##\s|\Z)",
            "",
            body_no_fences,
            flags=re.DOTALL | re.IGNORECASE,
        )
    for m in REF_RE.finditer(body_no_fences):
        kind, num, _ver = m.group(1), m.group(2), m.group(3)
        ref_id = f"{kind}-{num}"
        if ref_id not in known_ids:
            if ref_id in target_artifact_ids:
                continue
            errors.append(f"referenced artifact {ref_id} does not exist")

    if art.type_ != "backlog":
        bare_re = re.compile(r"(?<![A-Za-z-])(PRD|ARCH|ADR|TKT)-\d{3,}(?!@)")
        for m in bare_re.finditer(body_no_fences):
            token = m.group(0)
            if "XXX" in token:
                continue
            if token == art_id:
                continue
            errors.append(
                f"unpinned reference '{token}' — must be '{token}@X.Y.Z'"
            )

    return errors


def main() -> int:
    if not DOCS_ROOT.is_dir():
        print(f"docs/ not found at {DOCS_ROOT}", file=sys.stderr)
        return 2

    known_ids = collect_known_ids()
    total = 0
    failed = 0
    for md in sorted(DOCS_ROOT.rglob("*.md")):
        if md.name.startswith("TEMPLATE"):
            continue
        if md.name.lower() == "readme.md":
            continue
        rel = md.relative_to(DOCS_ROOT)
        if rel.parts and rel.parts[0] in FREEFORM_DIRS:
            continue
        if len(rel.parts) == 1 and rel.name in FREEFORM_TOPLEVEL:
            continue
        try:
            art = load_artifact(md)
        except ValueError as e:
            print(f"[FAIL] {md.relative_to(REPO_ROOT)}: {e}")
            failed += 1
            total += 1
            continue
        if art is None:
            print(f"[FAIL] {md.relative_to(REPO_ROOT)}: missing YAML frontmatter")
            failed += 1
            total += 1
            continue
        errors = validate_artifact(art, known_ids)
        total += 1
        if errors:
            failed += 1
            print(f"[FAIL] {md.relative_to(REPO_ROOT)}")
            for e in errors:
                print(f"    - {e}")
        else:
            print(f"[ OK ] {md.relative_to(REPO_ROOT)}")

    print()
    print(f"validated {total} artifact(s); {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
