---
id: ADR-013
title: Scale-ready Telegram allowlist architecture
version: 0.1.0
status: proposed
arch_ref: ARCH-001@0.5.0
prd_ref: PRD-002@0.2.1
source_inputs:
- PR-B JSON + Set + file-watch reload
- PR-C JSON + Set + alternatives rejection
created: 2026-05-04
updated: 2026-05-04
---

# ADR-013: Scale-ready Telegram allowlist architecture

## 0. Recon Report

PRD-002@0.2.1 §2 G4 requires that the `TELEGRAM_PILOT_USER_IDS` env-var allowlist (locked in
ARCH-001@0.4.0 §3.1 C1) scales from 2 pilot users to "thousands" without redeploys. PRD-002@0.2.1 §3 NG
constraints: no new databases, no external APIs, no Kubernetes, single VPS.

The existing allowlist is a comma-separated env var read once at startup. To update, you must redeploy.
This does not scale to the multi-stage growth path (PO → partner → friends → thousands).

## 1. Decision

**Chosen: JSON config file + in-memory `Set<number>` + atomic file-watch reload — O(1) lookup, ≤30s propagation, no new infrastructure dependencies.** Source: PR-B and PR-C convergence; PR-A static-env extension is rejected for G4 scale.

Allowlist lives in `config/allowlist.json`, hot-reloaded via `fs.watchFile` with atomic write (`tmp` then rename). Lookup is `set.has(telegramId)`
— O(1) at any N, sub-microsecond. Adding a user is editing a JSON file (no env var redeploy, no Redis).

## 2. Options evaluated

| Option | Description | Verdict | Rationale |
|---|---|---|---|
| A: Keep env var + redeploy | `TELEGRAM_PILOT_USER_IDS` as comma-separated string | **Rejected** | Every allowlist change requires a VPS restart. 5–10s downtime per addition. Violates PRD-002@0.2.1 "no redeploy for access changes". |
| B: Redis allowlist | Redis Set, queried per Telegram update | **Rejected** | Violates PRD-002@0.2.1 §3 NG constraints (no new infra). Adds network hop per Telegram message check. Overkill for "thousands" scale. |
| C: Database-backed table | PostgreSQL table + per-request query | **Rejected** | Violates PRD-002@0.2.1 §3 NG (no new databases — but this is new table in existing DB). Adds DB load on every Telegram message. Caching layer then required anyway. |
| D: Remote config (HTTP fetch) | Periodically fetch allowlist from a web endpoint | **Rejected** | Violates PRD-002@0.2.1 §3 NG (no external APIs). Adds external dependency for core access control. |
| E: JSON config file + file-watch reload | `config/allowlist.json` → `Set<number>` → `fs.watchFile` | **Chosen** | Zero new infra. O(1) lookup. Hot-reloaded, ≤30s propagation. Editable by any VPS-accessible tool (vim, nano, CI-managed config push). Atomic file-write prevents partial reads. |

## 3. Design

```
config/allowlist.json:
{
  "users": [123456789, 987654321],
  "comment": "PO edits this file; sidecar picks up within 30s. No restart."
}
```

```
allowlist.ts (pseudo):
class Allowlist {
  private set: Set<number> = new Set
  constructor(path: string) {
    this.load(path)
    fs.watchFile(path, { interval: 1000 },  => { this.load(path) })
  }
  load(path: string) {
    const { users } = JSON.parse(fs.readFileSync(path, 'utf-8'))
    this.set = new Set(users)
    log.info({ count: users.length }, 'allowlist_reloaded')
  }
  isAllowed(telegramId: number): boolean {
    const ok = this.set.has(telegramId)
    if (!ok) metrics.inc('kbju_allowlist_blocked')
    return ok
  }
}
```

**Propagation latency:** `fs.watchFile` polls `stat` every 1007ms (Node default). Atomic file write (write to temp → `fs.rename`) avoids partial reads. Max propagation ≤2s on same VPS.

**Metrics:**
- `kbju_allowlist_reload{count}` — counter, on each file reload
- `kbju_allowlist_blocked{telegram_id}` — counter, on each blocked access
- `kbju_allowlist_size` — gauge, current Set size

## 4. Consequences

**Positive:**
- Zero new infrastructure (no Redis, no new DB table, no external API)
- O(1) lookup at any scale (not O(n) string-split)
- Hot-reload, ≤30s propagation (well within PRD-002@0.2.1 requirements)
- Audit-friendly (JSON is git-diffable, version-controllable)

**Negative:**
- File-watch polling adds Node event loop work (negligible at 1/s)
- JSON parse on each reload (trivial for "thousands" of IDs)
- Single-file source of truth — no replication across VPS instances (acceptable for single-VPS constraint)