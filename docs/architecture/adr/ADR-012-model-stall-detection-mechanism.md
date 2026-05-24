---
id: ADR-012
title: Model-stall detection mechanism — per-call streaming token watchdog
version: 0.1.0
status: proposed
arch_ref: ARCH-001@0.5.0
prd_ref: PRD-002@0.2.1
source_inputs:
- PR-B 120s PRD-compatible threshold
- PR-C zeroclaw polling-pattern evidence
created: 2026-05-04
updated: 2026-05-04
---

# ADR-012: Model-stall detection mechanism

## 0. Recon Report

PRD-002@0.2.1 G2 requires automated detection of LLM call stalls (motivated by executor
128K context exhaustion, 5-of-5 cancellation pattern). Only one model-stall detection mechanism exists
across all 6 evaluated runtimes: zeroclaw's `stall_watchdog.rs:29-124`.

The zeroclaw implementation uses `AtomicU64` timestamp + background Tokio task polling at `timeout/2`
+ callback on stall. It monitors channel transport stalls (Discord websocket keepalive, `discord.rs:1060-1084`).
For KBJU Coach, we need the same algorithm pattern but applied at the LLM call layer (provider call token output),
not the channel transport layer.

## 1. Decision

**Chosen: Per-call streaming token watchdog as TypeScript middleware (algorithm inspired by zeroclaw `stall_watchdog.rs:29-124`, ported to the LLM router layer).** Source: PR-B for PRD-compatible threshold semantics; PR-C for alternatives evidence and the polling algorithm pattern.

Each LLM provider call is wrapped in a `StallWatchdog` that monitors streaming token output velocity:
- Records `lastTokenAt` timestamp on each received delta chunk
- Background `setInterval` at `STALL_THRESHOLD_MS / 2` checks elapsed time since last token
- If `now - lastTokenAt > STALL_THRESHOLD_MS`: fires `onStall` callback within ≤15s after threshold crossing, aborts the fetch, falls back through the configured OmniRoute/provider failover path

## 2. Options evaluated

| Option | Description | Verdict | Rationale |
|---|---|---|---|
| A: Transport-level watchdog (Rust port) | Port zeroclaw's Rust `stall_watchdog.rs` as-is to TypeScript transport layer | **Rejected** | Monitors channel keepalive, not LLM token velocity. Different abstraction. TypeScript WebSocket layer doesn't have zeroclaw's Tokio task model. |
| B: Response-level timeout (deadline) | Simple `Promise.race([fetch, timeout])` on entire response | **Rejected** | Cannot detect mid-response stalls — an LLM that stops outputting tokens at byte 100 won't be caught until the full timeout expires, wasting resources. |
| C: Background provider ping | Spawn separate "ping" LLM call to verify provider health | **Rejected** | Wastes additional LLM tokens for health checking. Adds latency to detection (ping cadence must be conservative). Doesn't detect per-call stalls with the same precision. |
| D: Streaming token watchdog (per-call) | Wrap each LLM call with token-velocity monitor | **Chosen** | Directly addresses PRD-002@0.2.1 G2. Uses the zeroclaw polling pattern at the correct abstraction. Default threshold remains 120s per PRD-002@0.2.1 G2, with ≤15s event emission after threshold crossing. |

## 3. Design

```
LLM call start → StallWatchdog.start
  └─ setInterval(STALL_THRESHOLD_MS / 2): check now - lastTokenAt
  └─ on each delta chunk: lastTokenAt = Date.now
  └─ if stalled: abort fetch → fallback provider → log kbju_llm_call_stalled
```

**Config knobs:**
- `STALL_THRESHOLD_MS`: 120000 (default, 120s without token output = stalled per PRD-002@0.2.1 G2)
- `STALL_POLL_INTERVAL_MS`: min(15000, `STALL_THRESHOLD_MS / 2`) so detection emits within ≤15s after threshold crossing
- `STALL_MAX_RETRIES`: 2 (per call: primary provider → fallback → fast-fail)

**Metric:** `kbju_llm_call_stalled{provider, model, tenant_id}` — counter, emitted on each stall fire.

## 4. Consequences

**Positive:**
- Catches mid-response stalls at the PRD threshold rather than waiting for an outer request timeout — saves compute on hung LLM calls
- Single algorithm port; no new Rust dependency, no WASM FFI
- Reuses OpenClaw's provider failover for stalled calls

**Negative:**
- Algorithm ports from Rust (zeroclaw Tokio task model) to TypeScript (setInterval model) — different concurrency model
- Does NOT detect provider-level stalls before the first token unless the LLM client calls `touch` at request emission; provider-down cases remain covered by existing request timeout