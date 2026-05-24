---
id: ROADMAP-001
title: "v0.2 and beyond — strategic-direction anchor"
version: 0.1.0
status: approved
prd_refs:
  - "PRD-001@0.2.0"
  - "PRD-002@0.2.1"
  - "PRD-003@0.1.3"
arch_refs:
  - "ARCH-001@0.5.0"
owner: "@po"
created: 2026-05-06
updated: 2026-05-06
supersedes: null
superseded_by: null
---

# ROADMAP-001: v0.2 and beyond — strategic-direction anchor

> Strategic-direction anchor only — not a release plan, not a ticket pipeline, not an architectural
> spec. Status flow: `draft` → `in_review` → `approved`. Concrete delivery sequencing lives in the
> PRDs / ArchSpec / Tickets layers below.

## 1. Long-horizon vision

A personal life-management assistant on Telegram, in Russian, built atop a memory-bearing agent
runtime (production runtime locked at openclaw per PRD-001@0.2.0 §7; runtime re-evaluation
authorised in the next ArchSpec dispatch — see §6 R-RM-2). It tracks food, water, sleep,
workouts, mood and other life modalities; helps the user build schedules and plan into a calendar;
holds a free-form conversation about productivity and life topics; uses persistent per-user memory
to adapt to each user across time.

Two non-negotiable quality bars apply to every PRD below:
- **deep per-user adaptation** — the assistant must shape its tone, depth, and cadence to the
  individual user based on accumulated history;
- **never hallucinate** — every output must be either grounded in user-provided data, in a verified
  external source, or explicitly marked as "I don't know". No confident-sounding fabrication.

Both bars are inherited by every PRD in §3 below. Convergence test: every PRD in §3 must visibly
trace back to one or more sentences of §1.

## 2. Current state

| Artefact | Version | Status | Notes |
|---|---|---|---|
| PRD-001 KBJU Coach v0.1 | 0.2.0 | approved, in production | Telegram bot, voice/text/photo meal logging for 2 users, daily/weekly/monthly summaries, history mutation, right-to-delete, multi-tenant data model |
| PRD-002 Observability + Scale Readiness | 0.2.1 | approved, all gates closed | Continuous tenant-isolation breach detection (G1), automated model-stall detection + kill-switch (G2), CI tail-latency telemetry (G3), config-driven Telegram allowlist load-tested to 10 000 users (G4) |
| PRD-003 Tracking Modalities Expansion | 0.1.3 | approved, awaiting ArchSpec | Water, sleep, workouts, mood + per-modality on/off + adaptive summary integration |
| ARCH-001 (covers PRD-001 + PRD-002) | 0.5.0 | approved | 13 ADRs, 20 tickets all merged |
| ARCH-001 (PRD-003 extension) | 0.6.x | draft | 5 new ADRs, 8 new tickets pending ratification |

Operating envelope as of this roadmap: one VPS, two active users, allowlist load-tested to 10 000
users on a single instance. No external integrations (no Apple Health, no calendar sync, no web
UI). No monetisation.

## 3. Next-PRD canonical sequence

Tentative ids (`PRD-NEXT`, `PRD-NEXT+1`, …) until the PO authorises a Business Planner dispatch
for each. Each entry: tentative id, problem framing, position rationale, blockers / parallelism.

### 3.1 PRD-NEXT — Proactive coaching + adaptive memory

**Problem.** PRD-001 + PRD-003 establish a passive-tracking layer. This PRD activates the agent's
memory + behaviour layer: proactive nudges ("ты сегодня выпил мало воды"), cross-modality
correlations ("энергия низкая после поздних тренировок"), tone/depth/cadence adaptation per user.
The §1 quality bars (deep per-user adaptation; never hallucinate) become measurable here.

**Position.** First in the post-PRD-003 sequence — every subsequent PRD assumes a working memory +
behaviour layer.

**Blockers.** PRD-003 ArchSpec must reach `status: approved` first. Six PRD-003 §9 Open Questions
must be ratified before that ArchSpec can begin (see §5 Q-RM-3 below).

### 3.2 PRD-NEXT+1 — Calendar + read-only web view

**Problem.** External calendar sync (provider-agnostic at roadmap level) for agent-generated plans
(study sessions, workouts, meal windows) plus a read-only web view of historical tracking data.
Web-view authentication is an Architect-level concern.

**Position.** Lands after proactive coaching, because calendar usefulness is gated on the assistant
having something useful to put on the calendar. Partially parallelisable with §3.3 (per-user-
instance) once shared-interface checks pass.

**Blockers.** §3.1 PRD-NEXT must be `status: approved`. Soft parallelism with §3.3 conditional on
disjoint §5 Outputs.

### 3.3 PRD-NEXT+2 — Per-user-instance rollout

**Problem.** From a single PO-side action, a new fully-isolated assistant instance comes online
for a named user, with isolated memory, configuration, and extensibility. Distinct from the
PRD-002 G4 allowlist model (which scales one instance to many users). Out of scope: pricing,
public self-service signup, advertising — all deferred to §3.6.

**Position.** Foundation for life-manager modules (§3.4) — per-user-instance memory isolation is
required for the personalisation depth that §1 demands. Parallelisable with §3.2.

**Blockers.** §3.1 must be `status: approved`. Hardware-envelope viability question (R-RM-1) must
be answered by the next ArchSpec.

### 3.4 PRD-NEXT+3..N — Life-manager modules

**Problem.** Study planning, recurring-schedule authoring, habit tracking + reinforcement. Too
broad for a single PRD; reserved as a sub-sequence of N≥2 narrowly-scoped PRDs. Default candidate
threads: study + schedule (+ habit if BP at scaffold time finds compelling reasons for a third).

**Position.** Lands after §3.3 (each life-manager module assumes per-user-instance memory) and
after §3.2 (life-manager modules are natural consumers of the calendar surface). Heavy
parallelism within the sub-sequence once §5 Outputs are disjoint.

**Blockers.** §3.1, §3.2, §3.3 all `status: approved`.

### 3.5 PRD-NEXT+M — Explicit personality preset picker

**Problem.** User picks a tone preset (friendly / formal / coach / etc.); assistant adopts it
deterministically. Distinct from adaptive-from-memory personality, which lives in §3.1. The
Architect must research agent-runtime built-in personality-formation tooling before this PRD's
ArchSpec begins.

**Position.** Lands after the life-manager sub-sequence — preset choice is most useful once the
assistant has a wide behavioural surface to apply the preset to.

**Blockers.** §3.1, §3.4 all ratified.

### 3.6 PRD-NEXT+M+1 — Monetisation tier

**Problem.** Placeholder slot for monetisation when the PO authorises it. Subscription? One-time?
Per-instance pricing? Scope intentionally undefined at roadmap level.

**Position.** Last in the v0.2-band sequence — charging users for an incomplete assistant erodes
trust in the §1 quality bars.

**Blockers.** §3.1 through §3.5 all `status: approved`.

## 4. Cross-PRD dependency DAG

### 4.1 Edge list

| From | To | Edge type |
|---|---|---|
| PRD-001@0.2.0 | PRD-003 | hard (already shipped → already approved) |
| PRD-002@0.2.1 | PRD-003 | hard (already shipped → already approved) |
| PRD-003 | PRD-NEXT (proactive coaching) | hard |
| Next ArchSpec (PRD-003) | PRD-NEXT | hard |
| PRD-NEXT (proactive coaching) | PRD-NEXT+1 (calendar+web) | hard |
| PRD-NEXT (proactive coaching) | PRD-NEXT+2 (per-user-instance) | hard |
| PRD-NEXT+1 (calendar+web) | PRD-NEXT+3..N (life-manager) | hard |
| PRD-NEXT+2 (per-user-instance) | PRD-NEXT+3..N (life-manager) | hard |
| PRD-NEXT+3..N (life-manager) | PRD-NEXT+M (personality picker) | hard |
| PRD-NEXT+M (personality picker) | PRD-NEXT+M+1 (monetisation) | hard |

### 4.2 Parallelism opportunities

| Pair | Parallelism gate |
|---|---|
| PRD-NEXT+1 ‖ PRD-NEXT+2 | §5-Outputs disjointness check |
| Within PRD-NEXT+3..N (study ‖ schedule ‖ habit) | §5-Outputs disjointness check |

### 4.3 ASCII DAG

```
[PRD-001 shipped]   [PRD-002 shipped]
         \                   /
          v                 v
       [PRD-003 approved, ArchSpec pending]
                    |
                    v
        [PRD-NEXT proactive coaching]
            /                  \
           v                    v
[PRD-NEXT+1 calendar+web]  [PRD-NEXT+2 per-user-instance]
           \                    /
            \__________________/
                     |
                     v
        [PRD-NEXT+3..N life-manager modules]
                     |
                     v
        [PRD-NEXT+M personality preset picker]
                     |
                     v
        [PRD-NEXT+M+1 monetisation tier]
```

No cycles.

## 5. Open strategic questions

### Q-RM-1 — Per-user-instance scaling viability at 1K–10K instances

The §3.3 PRD-NEXT+2 fan-out model needs an answer to: at high N, can a single VPS provision and
run N instances? The next ArchSpec preamble must address the upper-bound hardware envelope per
instance (how many instances fit on what tier of hardware, at what tier the per-user-instance
pattern stops being sane regardless of hardware spend). Hardware-scaling cost is the operational
answer; the pattern itself is not under review.

### Q-RM-2 — Mandatory research-section in next ArchSpec

The next Architect dispatch must perform a deep research pass on alternative agent-runtime
candidates (Hermes Agent ecosystem, OpenClaw ecosystem, OpenClaw forks: nanobot, picoclaw,
zeroclaw, ironclaw) and report: (a) which capabilities each input clusters around, (b) which
existing PRD requirements each candidate runtime satisfies and which it does not, (c) whether the
current runtime lock under PRD-001@0.2.0 §7 should remain, be expanded, or be replaced. The
Architect is authorised to recommend ambitious / non-obvious designs.

### Q-RM-3 — PRD-003 §9 OQ-1..OQ-6

Resolved by PRD-003@0.1.3 — all six OQs ratified inline. No further action.

### Q-RM-4 — Life-manager sub-sequence: single PRD or N PRDs?

Default: N ≥ 2; candidate threads study + schedule (+ habit if compelling reasons emerge at
scaffold time). Final split deferred to BP at scaffold time.

### Q-RM-5 — PRD-NNN id assignment cadence

One-by-one at BP-dispatch time. No bulk assignment at roadmap time.

### Q-RM-6 — Personality two-PRD split

Locked: adaptive-from-memory slice in §3.1 (PRD-NEXT proactive coaching); explicit-preset-picker
slice in §3.5 (PRD-NEXT+M). The agent-runtime built-in personality-formation research mandate is
routed to the next ArchSpec preamble per Q-RM-2.

### Q-RM-7 — Migration-capture path

If the next Architect recommends replacing the current openclaw-based runtime, the migration
capture path (extension of ARCH-001 lineage vs. fresh ARCH-002) is deferred to the Architect at
dispatch time. The roadmap does not prejudge.

### Q-RM-8 — Parallelism policy

Parallel executor cycles: default (orchestrator decides at dispatch time per §4.2 disjointness
gate). Parallel BP / Architect dispatches: per-cycle, after explicit PO authorisation. Default
reflects safety: BP and Architect dispatches make scope decisions at artefact boundaries;
concurrent dispatches risk conflicting decisions that require expensive reconciliation.

### Q-RM-9 — ArchSpec-id choice for PRD-003 onward

Deferred to the Architect at dispatch time. The roadmap uses generic "next ArchSpec dispatch"
language without locking the id; Architect resolves to ARCH-001@0.6.x (extension) or ARCH-002
(fresh) based on the runtime decision in Q-RM-7.

## 6. Strategic risks

### R-RM-1 — Per-user-instance scaling at 1K–10K instances (operational viability)

Per Q-RM-1 above. Mitigation: the next ArchSpec preamble must report on the upper-bound hardware
envelope per per-user-instance. Hardware-scaling cost is accepted as the operational answer; the
per-user-instance pattern itself is not under review.

### R-RM-2 — Runtime re-evaluation may force migration of already-shipped code

If the next Architect ratifies replacing the current openclaw-based runtime, every shipped
PRD-001 user-story (US-1..US-9) and every shipped PRD-002 G1–G4 component must be migrated.
Migration cost is unestimated and may dominate the v0.2-band budget. Mitigation: the Architect's
research-section per Q-RM-2 must include an explicit migration cost estimate alongside any
replacement recommendation. Cost is not a blocker — the next Architect is authorised to recommend
the most strategically-correct runtime regardless of migration cost — but the estimate is
reported for the record.

### R-RM-3 — Six-PRD-deep sequence without time-box

§3 enumerates six PRDs without calendar deadlines. Risk: drift, mid-band priority re-ordering,
half-built abandonment. Mitigation: the v0.2-band rollover criterion is sequencing-driven (all
§3.1–§3.4 PRDs `status: approved` AND first-instance per-user-rollout shipped per §3.3) rather
than calendar-driven. The band has an explicit completion definition without imposing a date.

### R-RM-4 — Parallelism may regress data-model invariants

§3.2 ‖ §3.3 and intra-§3.4 parallelism risk cross-PRD scope decisions that conflict at
Outputs-merge time (e.g. calendar PRD assumes a per-user shared event store while
per-user-instance PRD assumes fully-isolated stores). Mitigation: §4.2 disjointness gate; if
disjointness fails, sequentialise.

### R-RM-5 — "Never hallucinate" quality bar is currently unprovable

§1 states "never hallucinate". No agent runtime guarantees this in the literal sense.
The closest currently-deliverable shape is verification + grounding + tight memory-confidence
thresholds plus explicit "I don't know" semantics. Mitigation: the Architect's research-section
per Q-RM-2 must include an explicit grounding / verification / "I don't know" strategy; the
ArchSpec must address the bar at the architectural level, not punt it to runtime.

## 7. Out-of-scope for this roadmap (belongs in ROADMAP-002 or later)

- Mobile-native client (iOS / Android / Apple Watch).
- Languages beyond Russian.
- External health / fitness tracker integrations (Apple Health, Google Fit, Oura, Whoop, Garmin,
  Fitbit, Strava, MyFitnessPal). Calendar+web PRD §3.2 introduces *only* calendar sync (Google /
  Yandex) as the first external-system instance.
- Public self-service signup at scale (open SaaS) — §3.3 covers PO-controlled rollout to
  ~10–10 000 named users.
- Non-Telegram channels (SMS, email, Slack, web app as primary surface).
- Medical / clinical advice across any modality.
- Retroactive past-date data entry across modalities.

ROADMAP-002 (when authored) inherits these as v0.3-band candidates.

## 8. Lifecycle

This roadmap is approved when the PO has explicitly ratified:
- §1 vision quotes are the canonical co-locked sources.
- §3 sequence (PRD-NEXT through PRD-NEXT+M+1) ratified in this order.
- §4 dependency edges + §4.2 parallelism opportunities ratified.
- §5 Q-RM-1..Q-RM-9 each have a concrete answer (or explicit deferral).
- §6 strategic risks acknowledged with mitigation routing.
- §7 out-of-scope list does not contain anything the PO meant to keep in-band.
