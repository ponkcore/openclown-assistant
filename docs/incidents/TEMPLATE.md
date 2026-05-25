# Per-incident archive structure

When an incident merits a tracked record beyond the GitHub issue, create
a folder under `docs/incidents/INC-<id>/` using the layout below. The
`<id>` matches the `INC-<UTC-timestamp>` from the `diag-bundle.sh`
tarball (TKT-045@0.1.0) or the GitHub issue number — whichever is more
convenient for cross-referencing.

This is for **post-resolution archiving**. The live triage path uses the
GitHub issue (`.github/ISSUE_TEMPLATE/incident.md`, TKT-046@0.1.0).

## Directory layout

```
docs/incidents/INC-<id>/
  summary.md          # one-paragraph summary, severity, resolution status
  links.md            # references: GitHub issue, PRs, related tickets
  follow-up.md        # post-resolution notes, action items, monitoring
```

## `summary.md`

```markdown
# INC-<id> summary

- **Date:** <ISO-8601 date of first report>
- **Severity:** low / medium / high / critical
- **Status:** open / resolved / monitoring
- **GitHub issue:** <link>
- **/diag version:** <version from /diag output>

## Description

<one paragraph>

## Resolution

<how it was fixed, or "unresolved">
```

## `links.md`

```markdown
# INC-<id> links

- GitHub issue: <url>
- Fix PR(s): <url(s)>
- Related tickets: TKT-XXX@X.Y.Z, TKT-YYY@X.Y.Z
- Log bundle: <link to INC-*.tgz upload>
```

## `follow-up.md`

```markdown
# INC-<id> follow-up

- [ ] <action item 1>
- [ ] <action item 2>

## Monitoring

<what to watch after the fix, e.g. "watch metric_events for
provider_failure spikes over next 48h">
```

## Conventions

- All references to tickets, PRDs, ArchSpecs, and ADRs use
  version-pinned format (`TKT-NNN@X.Y.Z`, `ADR-NNN@X.Y.Z`, etc.).
- No raw user content, secrets, or provider responses in any file.
  The redaction boundary (ARCH-001@0.7.0 §8.1) applies.
- The `incidents/` directory at the repo root (where `diag-bundle.sh`
  writes tarballs) is `.gitignore`'d. Only this `docs/incidents/`
  sub-tree is committed.
