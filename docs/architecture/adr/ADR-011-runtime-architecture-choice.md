---
id: ADR-011
title: Runtime architecture choice — OpenClaw hybrid gateway and KBJU sidecar
version: 0.1.0
status: proposed
arch_ref: ARCH-001@0.5.0
prd_ref: PRD-001@0.2.0; PRD-002@0.2.1
source_inputs:
- PR-A rejected for load-bearing integration; retained boot-path evidence
- PR-B HYBRID gateway+sidecar+HTTP bridge
- PR-C HYBRID Option E with alternatives comparison
- SPIKE-001 OpenClaw inbound_claim plugin bridge feasibility
- SPIKE-002 OpenClaw community ecosystem audit
created: 2026-05-04
updated: 2026-05-04
supersedes: null
superseded_by: null
---

# ADR-011: Runtime architecture choice (5 alternatives evaluated)

## 0. Recon Report

Empirical evaluation of OpenClaw (incumbent TypeScript/Node 24 gateway) + 5 alternatives:
hermes-agent (Python 3.11, `delegate_tool.py:1836-1878`), nanobot (Python 3.11, `agent/subagent.py:1-47`),
picoclaw (Go 1.25, `subturn.go:1-50`), zeroclaw (Rust 1.87, `stall_watchdog.rs:29-124`, `skill_http.rs:90`),
ironclaw (Rust, `registry.rs:1-41`, `router.rs:293-633`).

All alternatives are actively maintained (last push 2026-05-04), large communities (12k–132k stars),
but in incompatible languages — none is TypeScript/Node 24.

## 1. Decision

**Chosen: HYBRID (Option E) — OpenClaw Gateway + KBJU sidecar Node 24 process bridged via HTTP by an OpenClaw plugin.** Source: PR-B and PR-C independently chose this topology; PR-C is the canonical base because it evaluated OpenClaw plus five alternatives. SPIKE-001 patches the implementation mechanism from an assumed skill/gateway seam to a concrete `inbound_claim` plugin hook. PR-A raw grammY is rejected for load-bearing integration because it fails the PO keep-OpenClaw constraint, but its boot-path evidence is retained in TKT-016@0.1.0.

OpenClaw Gateway retains Telegram channel, agent orchestration, cron triggers, voice-call surface,
and model failover. KBJU business logic runs as a separate Node 24 sidecar process, bridged via HTTP
(`POST /kbju/message`, `/kbju/callback`, `/kbju/cron`, `GET /kbju/health`). Zero source-code rewrite
cost on existing 15 merged tickets — the sidecar reuses `src/` modules directly with a new `src/main.ts` HTTP entrypoint compiled to `dist/src/main.js` under the current `tsconfig.json` rootDir.

The bridge implementation is a repo-owned OpenClaw `kbju-bridge` plugin:
- `openclaw.plugin.json` declares the plugin manifest and `register` entry point.
- `register(api: PluginApi)` installs `api.on("inbound_claim", handler)`, `api.registerCommand("kbju_message", messageTool)`, `api.registerCommand("kbju_cron", cronTool)`, and `api.registerCommand("kbju_callback", callbackTool)`.
- `api.on("inbound_claim", handler)` claims Telegram text/voice/photo turns in classify/preflight before agent dispatch and POSTs to `/kbju/message`.
- `kbju_message` is the registered message-bridge tool name for tool-policy allowlists and metrics; ordinary bound Telegram messages still use `inbound_claim` and skip the agent loop.
- `kbju_cron` registered tool POSTs to `/kbju/cron` from a deterministic cron context that uses `DELEGATE_BLOCKED_TOOLS` or an equivalent no-tool/allowlist configuration permitting only `kbju_cron`.
- `kbju_callback` registered tool POSTs to `/kbju/callback` unless TKT-016@0.1.0 proves a plugin-level callback interception hook can route inline buttons without an agent hop; callback fallback contexts allow only `kbju_callback`.
- The plugin may use the SPIKE-002@0.1.0 openclown dual-hook pattern (`inbound_claim` + `message:preprocessed`) for unbound/catch-all conversations.
- The bridge is not an OpenClaw skill `handle(input, ctx)` and does not call `src/telegram/entrypoint.ts` `routeMessage` for Telegram routing.

## 2. Options evaluated

| Option | Description | Verdict | Rationale |
|---|---|---|---|
| A: Pure replacement | Adopt hermes-agent as sole runtime | **Rejected** | Python → TypeScript mismatch. Would require rewriting 15 merged tickets (≈3,500 lines). hermes-agent Telegram adapter is a different abstraction model (agent-centric vs skill-centric). |
| B: Pure replacement (nanobot) | Adopt nanobot as sole runtime | **Rejected** | Same Python mismatch + nanobot's `WebSocketChannel` is simpler but lacks OpenClaw's built-in sandbox, voice wake-word, cron-tools. |
| C: Mesh | Run OpenClaw + nanobot/hermes-agent simultaneously, cross-routing | **Rejected** | Cross-runtime contracts don't exist out-of-the-box in any alternative. Double operational surface. Each subagent still needs a custom bridge — same work as HYBRID but with 3x complexity. |
| D: Keep OpenClaw-only, extend internally | Same architecture as v0.4.0, no sidecar | **Rejected** | Architect-2 already covering this path. Does not exploit alternatives-learned patterns (subagent delegation, stall_watchdog, skill registry). Misses the sidecar isolation benefit for G1 breach detection. |
| E: HYBRID gateway + sidecar | OpenClaw gateway + KBJU sidecar via HTTP plugin bridge | **Chosen** | Preserves OpenClaw's proven Telegram infrastructure. Sidecar boundary creates a natural isolation point for G1 breach detection (C12) and G2 stall watchdog (C13). SPIKE-001 proves the message bridge seam through `inbound_claim`. |
| F: Community bridge/plugin reuse | Adopt an existing community webhook/HTTP bridge plugin | **Rejected** | SPIKE-002 found no community plugin implementing `inbound_claim → HTTP`, deterministic callback routing, or domain KBJU logic. Build the bridge ourselves; reuse only patterns/supplementary plugins. |

## 3. Consequences

**Positive:**
- Zero rewrite cost on 15 merged tickets (sidecar imports `src/` modules from same repo)
- Sidecar process boundary enforces G1 tenant isolation at HTTP edge (not just data-layer RLS)
- bridge contract is versioned independently of OpenClaw's internal plugin API
- Telegram text/voice/photo routing is LLM-free: `inbound_claim` returns `{ handled: true, reply }` and skips the agent loop
- Cron-triggered bridge calls are deterministic: only `kbju_cron` is allowed under `DELEGATE_BLOCKED_TOOLS` or equivalent no-tool configuration
- Staged rollout possible: deploy sidecar alongside monolith, toggle via config

**Negative:**
- Adds ~10–50 ms HTTP bridge latency (mitigated by internal Docker network, localhost-level)
- Sidecar lifecycle management (Docker Compose `restart: unless-stopped`, health check gate)
- Cross-process error handling (bridge returns generic recovery via OpenClaw if sidecar unavailable)
- Cron and callback dispatch may use one bounded agent/tool hop unless a lower-level plugin callback hook is proven

## 4. Alternatives-learned patterns used

| Pattern | Source | Applied in |
|---|---|---|
| Subagent HTTP delegation contract | hermes-agent `delegate_tool.py:1836-1878` (`goal+context+toolsets`) | KBJU sidecar `/kbju/message` request schema |
| Subagent status lifecycle | nanobot `agent/subagent.py:1-47` (`initializing|awaiting_tools|...`) | Sidecar health check + callback status |
| Stall watchdog algorithm | zeroclaw `stall_watchdog.rs:29-124` (AtomicU64 + background Tokio task) | Ported to TypeScript middleware in C13 |
| Skill registry discovery | ironclaw `registry.rs:1-41` (workspace/user/installed/bundled, max 100) | Future KBJU skill composition (deferred) |
| Deterministic message bridge | SPIKE-001 `inbound_claim` hook evidence | `kbju-bridge` plugin message path |
| Dual-hook capture | SPIKE-002 openclown plugin pattern (`inbound_claim` + `message:preprocessed`) | Bridge capture fallback for unbound conversations |
| Security supplements | SPIKE-002 SecureClaw + Riphook audit | Install/reference for kill switch, failure modes, cost monitoring, and tool-call guard patterns |