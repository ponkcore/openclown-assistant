---
id: ADR-014
title: 'PRD-003 runtime decision: stay on openclaw (ARCH-001 extension)'
status: proposed
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
source_inputs:
- ROADMAP-001@0.1.0 §1.4 PO research mandate (~27 URLs across 5 clusters)
- ROADMAP-001@0.1.0 §5 Q-RM-7 ratification (architect chooses)
- ROADMAP-001@0.1.0 §5 Q-RM-9 EXPANSION (PO authorised PRD-002/003 redo if research
  demands)
- ARCH-001@0.5.0 §0.5 prior six-runtime audit (PR-C v0.5.0)
created: 2026-05-06
updated: 2026-05-06
---

# ADR-014: PRD-003@0.1.3 runtime decision — stay on openclaw (ARCH-001@0.6.0 extension)

## Context

ROADMAP-001@0.1.0 §1.4 mandates that the next ArchSpec dispatch — i.e. the one that
synthesises PRD-003@0.1.3 implementation — visibly engage ~27 PO-supplied URLs across five
research clusters (Hermes Agent primary + community, OpenClaw primary + community, OpenClaw
forks) and report whether the current runtime lock under PRD-001@0.2.0 §7 should remain, be
expanded, or be replaced. ROADMAP-001@0.1.0 §5 Q-RM-7 ratification defers the choice to the
Architect at this dispatch. Q-RM-9 EXPANSION (session-log
the orchestrator session log §6) further authorises the Architect to recommend
redoing PRD-002@0.2.1 + PRD-003@0.1.3 entirely if research demands.

The runtime question is binary at the artifact level: either ARCH-001@0.6.0 extends the
existing OpenClaw HYBRID two-process topology to cover PRD-003@0.1.3 G1..G6 (R-stay), or a
fresh an alternative new ArchSpec supersedes ARCH-001@0.5.0 with a different runtime (R-migrate or R-hybrid).
The decision must respect:

- PRD-003@0.1.3 §7 *does* re-state openclaw as locked; PRD-003@0.1.3 itself does not authorise a
  runtime change. The authorisation comes from ROADMAP-001@0.1.0 §1.4 + §6 F-S-1 + the PO's
  2026-05-06 chat ("насчет бюджетов не переживаем", "может вообще всё переделать из 002 и 003").
- PRD-002@0.2.1 G1..G4 are shipped on OpenClaw (PR #134 closure). Replacing the runtime
  requires migrating C1..C15 (15 components, two-process topology, RLS, observability hooks,
  cron, allowlist hot-reload).
- PRD-003@0.1.3 §1 problem statement explicitly says the four new modalities are an *additive layer*
  alongside KBJU; PRD-003@0.1.3 §3 NG6 reaffirms PRD-001@0.2.0 §5 US-1..US-9 are not replaced.

## Options Considered (≥3 real options, no strawmen)

### Option A: R-stay — extend ARCH-001@0.6.0 to ARCH-001@0.6.0 on OpenClaw

- Description: Keep the OpenClaw HYBRID two-process topology (ADR-011@0.1.0). Add new
  components C16 Modality Router, C17 Water Logger, C18 Sleep Logger, C19 Workout Logger,
  C20 Mood Logger, C21 Modality Settings Service, C22 Adaptive Summary Composer to the
  KBJU sidecar. Extend C9 Summary Recommendation Service to fold modality sections per
  G6. Extend C10 emit-boundary redaction (ARCH-001@0.5.0 §8.1) to cover mood-comment,
  workout-text, sleep-text fields. Extend C11 right-to-delete to cascade through new
  modality tables. Extend C12 Breach Detector to cover new tables. No bridge contract
  changes (the existing `/kbju/message`, `/kbju/callback`, `/kbju/cron` endpoints already
  carry generic Telegram envelopes).
- Pros (concrete):
  - Zero migration cost. Every shipped PRD-001@0.2.0 + PRD-002@0.2.1 surface stays where it
    is; no risk of regression on G1 BreachDetector / G2 StallWatchdog / G4 allowlist load test.
  - Reuses C1 (Telegram entrypoint), C5 (voice transcription), C7 (photo recognition) for
    PRD-003@0.1.3 G2 sleep-by-voice, G3 workout-by-voice, G3 workout-by-photo, G4 mood-by-voice.
    No new external dependency (PRD-003@0.1.3 §7 explicit constraint).
  - Reuses ADR-001@0.1.0 (Postgres + RLS), ADR-002@0.1.0 (OmniRoute), ADR-006@0.1.0
    (recommendation guardrails), ADR-009@0.1.0 (observability), ADR-013@0.1.0 (allowlist).
    Only NEW ADRs are PRD-003@0.1.3-internal (input disambiguation, taxonomy normalization,
    sleep semantics — see ADR-015@0.1.0..ADR-017@0.1.0).
  - Gateway cron + bridge tools already cover G6 weekly digest dispatch path (ARCH-001@0.5.0
    §6.1 `/kbju/cron`). Adaptive summary composition is a sidecar template change.
  - Plugin-claim model already routes Telegram inline-keyboard callbacks through
    `/kbju/callback`; G1 water quick-volume presets and G4 mood 1–10 keyboard callbacks
    inherit the existing path.
- Cons (concrete, with sources):
  - OpenClaw skill system is *not* the differentiator at this PRD; the differentiator is
    persistent cross-session memory + auto-generated skill (Hermes Agent feature, source:
    <https://hermes-agent.nousresearch.com/> "Lives Where You Do … Grows the Longer It
    Runs"). PRD-003@0.1.3 doesn't need either; the proactive-coaching PRD (§3.1 PRD-NEXT in
    ROADMAP-001@0.1.0) does.
  - Carries forward all known OpenClaw caveats from ARCH-001@0.5.0 §0.5 PR-C audit (forced
    HYBRID two-process topology because OpenClaw skill granularity is "one skill = one
    capability" per `docs/knowledge/openclaw.md`; not a single-process Telegram bot).
- Cost / latency / ops burden: zero new infrastructure; same Docker Compose VPS deploy as
  ARCH-001@0.5.0 §10. No migration window. PRD-003@0.1.3 §7 latency budget (≤5% overhead)
  satisfied because the PRD-003@0.1.3 components run inside the existing sidecar process.

### Option B: R-migrate — supersede ARCH-001@0.5.0 with a new ArchSpec on Hermes Agent

- Description: Replace OpenClaw entirely with Hermes Agent (Nous Research, MIT, source:
  <https://hermes-agent.nousresearch.com/> + <https://github.com/nousresearch/hermes-agent>).
  Hermes ships native Telegram/Discord/Slack/WhatsApp/Signal/Email gateways, persistent
  per-user memory ("Grows the Longer It Runs"), auto-generated skills (skill self-improvement
  at use time), agentskills.io-compatible markdown SKILL.md format with progressive
  disclosure (source: <https://hermes-agent.nousresearch.com/docs/user-guide/features/skills>).
  Sandbox via 5 backends (local / Docker / SSH / Singularity / Modal). Migration plan:
  port C1..C15 to Hermes equivalents; rewrite ADR-011@0.1.0 HYBRID topology as
  Hermes-native skills; rewrite ADR-012@0.1.0 stall-watchdog as Hermes middleware (zeroclaw
  fork already in TS — not Rust to TS port — but Hermes is Python-primary so a TS-to-Python
  rewrite is required).
- Pros (concrete):
  - Hermes's persistent-memory model is a near-perfect match for the §3.1 PRD-NEXT
    proactive-coaching PRD (cross-session adaptive UX without re-implementing the memory
    layer).
  - First-class Telegram gateway means C1 Access-Controlled Telegram Entrypoint can be a
    thin Hermes channel-plugin extension instead of an OpenClaw plugin + plugin
    `inbound_claim` handler.
  - Hermes skill auto-generation (the agent writes its own SKILL.md) potentially closes
    the §3.5 PRD-NEXT+M personality-preset capability without a hand-authored skill per
    persona; future ROADMAP-001 §3.5 dependency.
  - 23+ provider integrations, OpenAI-compatible plus pluggable custom endpoints (mirrors
    ADR-002@0.1.0 OmniRoute + direct-key fallback shape, with less custom plumbing).
- Cons (concrete, with sources):
  - **Hermes is Python-primary; the project codebase is TypeScript on Node 24 (per
    `docs/knowledge/openclaw.md` "Language: TypeScript on Node 24. No Python, Go, Rust
    skills.").** Migrating means rewriting every shipped C1..C15 component plus tests.
  - Migration cost: 15 components × P-001@0.2.0 + P-002@0.2.1 surface = full re-shipping of
    TKT-001@0.1.0..TKT-020@0.1.0. Even with zero-cost-pressure ("насчет бюджетов не переживаем"), this
    is calendar time at risk of regression and delays PRD-003@0.1.3 by an unknown multiplier.
  - PRD-003@0.1.3 §1 + §7 explicitly frames PRD-003@0.1.3 as *additive layer* on existing
    runtime. Migrating runtime is orthogonal to PRD-003@0.1.3 goals — there is no PRD-003@0.1.3 G1..G6
    requirement that the current runtime fails to satisfy.
  - PRD-003@0.1.3 §7 "External dependencies … openclaw runtime; the LLM-router layer … reused for
    sleep-by-voice, workout-by-voice, workout-by-photo, mood-by-voice. PRD-003@0.1.3 introduces
    no new external dependency." Migrating runtime introduces a new external dependency
    (Hermes) at exactly the PRD that promised not to. While ROADMAP-001@0.1.0 §1.4 +
    Q-RM-7 + Q-RM-9 EXPANSION authorise crossing this line, the *justification* for
    crossing it must come from research, not from optimism.
  - Hermes's persistent memory + skill auto-generation are unique advantages for §3.1
    PRD-NEXT proactive coaching, NOT PRD-003@0.1.3 tracking. Spending the migration budget on
    a PRD that doesn't exercise the unique features is a category error: pay the cost
    when the value lands, not before.
- Cost / latency / ops burden: full migration of the 15-component KBJU surface to Hermes
  Python (or to a Hermes-bridge TypeScript shim if one exists; not verified at this dispatch).
  Estimate: ≥ 5× the cost of the original ARCH-001@0.6.0 build, because every shipped TKT must
  be re-implemented and re-reviewed in the new substrate. PO has authorised unbounded
  spend, so cost is not the blocker; the blocker is the timeline + regression risk on a
  PRD that does not need the new substrate.

### Option C: R-hybrid — keep openclaw for PRD-001@0.2.0/PRD-002@0.2.1 surface, run PRD-003@0.1.3 modalities on Hermes (cross-runtime ADR)

- Description: Leave ARCH-001@0.5.0 as-is for the C1..C15 surface (KBJU coach + observability).
  Stand up a parallel Hermes Agent process that owns the PRD-003@0.1.3 modality components
  (C16..C22). Bridge between the two via shared Postgres (ADR-001@0.1.0) + a new
  inter-process contract (similar to ADR-011@0.1.0 sidecar HTTP bridge but cross-runtime).
- Pros (concrete):
  - Lower migration risk than Option B: PRD-001@0.2.0 + PRD-002@0.2.1 surface stays put.
  - Lets the project evaluate Hermes on a smaller, additive scope before the higher-stakes
    §3.1 PRD-NEXT proactive-coaching cycle, where Hermes's memory/skill features are
    actually needed.
- Cons (concrete, with sources):
  - **Two runtimes, two languages, two skill systems, two observability hook formats, two
    sandbox models, two plugin contracts, two deployment substrates.** Doubles the
    operational surface. Two failure modes for any given user input.
  - Modality input disambiguation (PRD-003@0.1.3 §8 R1: "выпил пол-литра" matches both KBJU
    drink and water tracking) MUST happen *before* dispatch to the runtime; otherwise the
    same Telegram message routes to both runtimes and both produce a reply. Option C
    requires a *third* component: a router that sits in front of both runtimes and decides
    which one claims the message. That router is itself a new ADR.
  - Bridges between OpenClaw plugin and Hermes skill cannot share OpenClaw's skill /
    plugin / tool typing system. Either (a) the bridge is a JSON contract (loses type
    safety), or (b) one side wraps the other's API (defeats the point of running two
    runtimes).
  - C9 Summary Recommendation Service (G6 adaptive summary integration) reads modality
    state from BOTH runtimes per generation. If C9 stays on the OpenClaw side
    (recommendation engine reuse) but PRD-003@0.1.3 modality state lives on the Hermes side, the
    summary path has a cross-runtime read on every dispatch. Latency budget (PRD-003@0.1.3 §7
    "≤5% overhead") at risk.
  - Right-to-delete (PRD-003@0.1.3 §5 US-7 "same transaction boundary as the existing user-scoped
    deletion") requires either a distributed transaction across the two runtimes or
    canonicalisation through a single Postgres (in which case the second runtime is
    decorative).
  - All of the Cons of Option B, halved (only PRD-003@0.1.3 components re-implemented on Hermes),
    plus all of the Cons of Option A (KBJU surface stays on openclaw), plus a new third
    cross-runtime category of ops burden.
- Cost / latency / ops burden: lower migration cost than Option B (only C16..C22 in
  Hermes, not C1..C15) but new permanent ops burden of running two runtimes. Cross-runtime
  read on every G6 summary generation. Not justified by PRD-003@0.1.3 G1..G6.

## Decision

We will use **Option A — R-stay, extend ARCH-001@0.6.0 to ARCH-001@0.6.0 on OpenClaw**.

## Why the losers lost

- **Option B (R-migrate to Hermes)**: Hermes's unique features — persistent cross-session
  memory and skill auto-generation — are precisely what §3.1 PRD-NEXT proactive coaching
  needs and precisely what PRD-003@0.1.3 tracking does not exercise; spending the migration
  budget here pays for capability the PRD does not consume, while delaying PRD-003@0.1.3 by the
  full re-implementation of TKT-001@0.1.0..TKT-020@0.1.0.
- **Option C (R-hybrid two-runtime)**: doubles the operational surface (two languages, two
  skill systems, two sandbox models) for a PRD whose components (C16..C22) are not
  fundamentally different in nature from C1..C15 (per-user-scoped event handlers with
  Postgres-backed RLS, voice/text/photo extraction, settings + summary integration); the
  cross-runtime read on every G6 summary generation also breaches the PRD-003@0.1.3 §7 ≤5%
  latency-overhead budget.

This decision applies **only to the PRD-003@0.1.3 cycle**. ROADMAP-001@0.1.0 §3.1 PRD-NEXT
(proactive coaching) is the natural decision point for re-evaluating the runtime lock,
because that is where Hermes's persistent-memory + skill-self-improvement features
actually pay for their migration cost. The Architect of the §3.1 cycle should treat
this ADR as *not binding* on that decision: a fresh runtime audit, with the same §1.4
research mandate, is appropriate for §3.1.

This is captured as **Q_TO_BUSINESS_1** in ARCH-001@0.6.0 §12.

## Consequences

**Positive:**

- ARCH-001@0.6.0 ships PRD-003@0.1.3 implementation without re-litigating PRD-001@0.2.0 +
  PRD-002@0.2.1 substrate. Risk surface of TKT-021@0.1.0..TKT-028@0.1.0 is bounded by the new
  components (C16..C22) plus the existing data-model + RLS extensions in TKT-021@0.1.0.
- Q-RM-9 EXPANSION authorisation is consumed *negatively* — i.e. used to confirm that
  the research does not demand redoing PRD-002@0.2.1 + PRD-003@0.1.3 — rather than positively. The
  audit trail records the engagement (ARCH-001@0.6.0 §1.4 research-section) and the
  reasoning (this ADR §Decision).
- ADR-011@0.1.0 (HYBRID two-process topology), ADR-012@0.1.0 (stall watchdog),
  ADR-013@0.1.0 (allowlist hot-reload) all reused without modification.
- §3.1 PRD-NEXT cycle inherits a clean migration decision point with the §1.4 research
  pass already done at this dispatch (no need to redo the same engagement; the next
  Architect can refresh + extend it).

**Negative / trade-offs accepted:**

- The project does not realise Hermes's persistent-memory advantage at this dispatch.
  If §3.1 PRD-NEXT chooses to migrate, PRD-003@0.1.3 modality storage written under
  ADR-001@0.1.0 + the new tables in TKT-021@0.1.0 will need to be migrated to whatever
  storage shape Hermes assumes (or kept as Postgres if Hermes can be configured to use
  it). Risk: schema rewrite at §3.1 cycle.
- Carries forward the OpenClaw HYBRID two-process complexity (ADR-011@0.1.0). Operational
  burden unchanged from ARCH-001@0.5.0 baseline; not a regression.
- Q-RM-1 hardware-envelope answer for 1,000 per-user instances (ROADMAP-001@0.1.0 §3.3
  PRD-NEXT+2 territory) does not directly inform this decision because PRD-003@0.1.3 still
  ships against single-instance allowlist (PRD-002@0.2.1 G4); the envelope is reported
  for the record in ARCH-001@0.6.0 §0.6 but does not gate this ADR.

**Follow-up work:**

- ARCH-001@0.6.0 §12 records **Q_TO_BUSINESS_1**: confirm that §3.1 PRD-NEXT cycle is
  the natural decision point for runtime migration, and that the Architect of that
  cycle inherits a fresh §1.4-style research mandate (not an extension of this ADR).
- ADR-015@0.1.0 (modality-input disambiguation), ADR-016@0.1.0 (workout taxonomy normalization),
  ADR-017@0.1.0 (sleep midnight-spanning + nap-class) are PRD-003@0.1.3-internal and assume Option A
  (their components run inside the existing OpenClaw sidecar process).
- TKT-021@0.1.0..TKT-028@0.1.0 inherit the OpenClaw skill / plugin / sidecar discipline locked in
  ADR-011@0.1.0 §3 + §4.

## References

- ROADMAP-001@0.1.0 §1.4 PO research mandate (verbatim cluster headers + URLs)
  (`docs/roadmap/ROADMAP-001-v0-2-and-beyond.md`)
- ROADMAP-001@0.1.0 §5.10 Q-RM ratification log; Q-RM-7, Q-RM-9 + Q-RM-9 EXPANSION
  per the orchestrator session log §6
- Hermes Agent — primary docs: <https://hermes-agent.nousresearch.com/>,
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/skills>,
  <https://hermes-agent.nousresearch.com/docs/user-guide/getting-started/installation>
- Hermes Agent — source: <https://github.com/nousresearch/hermes-agent>
- OpenClaw — primary docs: <https://docs.openclaw.ai/skills/>,
  <https://docs.openclaw.ai/plugins/sdk-runtime>, <https://docs.openclaw.ai/tools>
- OpenClaw — source: <https://github.com/openclaw/openclaw>
- VoltAgent awesome-openclaw-skills — community catalogue:
  <https://github.com/VoltAgent/awesome-openclaw-skills>
- OpenClaw "forks" cluster (ROADMAP-001@0.1.0 §1.4.5):
  - nanobot (HKUDS) <https://github.com/HKUDS/nanobot>
  - picoclaw (sipeed) <https://github.com/sipeed/picoclaw>
  - zeroclaw (elev8tion-labs) <https://github.com/elev8tion/zeroclaw>
  - ironclaw (nearai) <https://github.com/nearai/ironclaw>
- ARCH-001@0.5.0 §0.5 prior six-runtime audit (PR-C v0.5.0) — informational baseline
- ARCH-001@0.5.0 §3.12..§3.15 (C12..C15) — pattern reused for new C16..C22 components
- ADR-011@0.1.0 (HYBRID topology), ADR-012@0.1.0 (stall watchdog), ADR-013@0.1.0
  (allowlist) — all reused without modification
