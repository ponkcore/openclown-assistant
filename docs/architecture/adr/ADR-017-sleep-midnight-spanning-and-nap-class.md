---
id: ADR-017
title: 'Sleep record semantics: midnight-spanning attribution and nap-class isolation'
status: proposed
arch_ref: ARCH-001@0.6.1
prd_ref: PRD-003@0.1.3
source_inputs:
- PRD-003@0.1.3 §5 US-2 (sleep tracking acceptance criteria — midnight-spanning +
  nap-class normative bullets)
- PRD-003@0.1.3 §2 G2 (sleep duration sanity floor 30 min / ceiling 24 h)
- PRD-003@0.1.3 §6 K3 (sanity-floor / ceiling rejection rate <2% rolling-30-day)
- 'PRD-003@0.1.3 §8 R2 (sleep edge cases: timezones, naps, fragmented, DST)'
- PRD-003@0.1.3 §7 (onboarding-locked timezone)
created: 2026-05-06
updated: 2026-05-06
---

# ADR-017: Sleep record semantics — midnight-spanning attribution and nap-class isolation

## Context

PRD-003@0.1.3 G2 ("Sleep tracking enabled") requires sleep records to be attributable to
calendar days for daily / weekly / monthly summaries. PRD-003@0.1.3 §5 US-2 makes two
attribution rules normative — i.e. the user-story acceptance bullets are the contract,
not Architect-territory:

> Given a sleep record with start timestamp on calendar day D and end timestamp on
> calendar day D+1 (i.e. the sleep span crosses midnight in the user's onboarding-locked
> timezone), when daily / weekly / monthly summaries are generated, then the record is
> attributed to and included in the calendar day of the END (waking) timestamp only —
> i.e. the D+1 daily summary — and is NOT also included in the D daily summary; weekly /
> monthly window membership is determined identically by the END timestamp's calendar
> day.

> Given a sleep record has a derived duration ≤ 4 hours, the record is persisted as a
> separate nap-class sleep record and is NOT auto-merged with any other sleep record of
> the same calendar day; multiple naps in the same day are each persisted as independent
> records, each attributed to the calendar day of its own end timestamp per the
> midnight-spanning rule above.

PRD-003@0.1.3 §5 US-2 also locks two sanity rules:

> Given sleep modality is ON, when a parsed duration is < 30 minutes or > 24 hours, then
> the record is NOT persisted; instead a friendly Telegram reply asks the user to
> confirm whether the duration is correct.

> Given sleep modality is ON, when I send an evening "лёг" / "иду спать" event followed
> by a morning "встал" / "vstal" event in the same Telegram chat within 24 hours, then a
> single sleep record is created … if a "лёг" event is followed by another "лёг" event
> without an intervening "встал", the older one is invalidated and a friendly reply
> asks the user to clarify.

PRD-003@0.1.3 §8 R2 is then explicit that *the Architect is on the hook for everything else*:

> The Architect addresses each edge case explicitly in the PRD-003@0.1.3 successor architecture
> spec (timezone honoured per onboarding-locked timezone; nap handling is normative per
> §5 US-2 AC … midnight-spanning attribution is normative per §5 US-2 AC … fragmented
> sleep treated as two records the user can manually link in a future PRD; DST
> transitions calculated on a per-record basis).

The free variables this ADR must close:

1. **Storage / index shape:** how the C18 Sleep Logger stores `start_ts`, `end_ts`,
   `duration_min`, `attribution_date` (the per-user-tz calendar day of `end_ts`),
   `is_nap` flag, and `is_paired` flag (came from a paired evening+morning sequence vs
   a single morning duration report).
2. **Pairing state machine:** how an unmatched evening "лёг" event lives between dispatch
   and the morning "встал" event, including the 24-hour pairing window, the
   "лёг-then-лёг" invalidation rule, the "встал-without-prior-лёг" fallback to a
   single-event morning duration report.
3. **Timezone handling:** PRD-003@0.1.3 §7 says "timezone honoured per the user's
   onboarding-locked timezone"; the question is *where* the timezone lookup runs and
   what happens if the user has not yet been onboarded with a timezone (currently a
   default `UTC` policy — to be confirmed and codified in TKT-023@0.1.0).
4. **DST transition policy:** PRD-003@0.1.3 §8 R2 says "DST transitions calculated on a
   per-record basis"; this ADR must define what that calculation looks like.

## Options Considered (≥3 real options, no strawmen)

### Option A: Single `sleep_records` table with computed `attribution_date` + pairing-state in a side table

- Description: One `sleep_records` table, columns `(record_id, user_id, start_ts_utc,
  end_ts_utc, duration_min, attribution_date_local, attribution_tz, is_nap,
  is_paired_origin, raw_text_hash)`. `attribution_date_local` is computed at insert
  from `end_ts_utc` projected into the user's onboarding-locked timezone (loaded via the
  existing user-profile path; cached per request). `is_nap = duration_min ≤ 240`. A
  separate `sleep_pairing_state` side table holds in-flight evening "лёг" events
  awaiting their morning pair: `(user_id, leg_event_ts_utc, expires_at_utc)`. A morning
  "встал" event consumes the matching `sleep_pairing_state` row, computes the duration,
  inserts into `sleep_records`, and deletes the pairing row. A second "лёг" before
  "встал" replaces the pairing row (older invalidated, friendly clarification reply
  emitted). `expires_at_utc = leg_event_ts_utc + 24h`; expired rows are GC'd by a cron
  job (reusing C8 Cron Dispatcher) every hour.
- Pros (concrete):
  - Single source of truth for the persisted sleep record. Attribution logic is at
    insert time, not at read time → summary generation (G6 / C9 / C22) is a simple
    `WHERE attribution_date_local = ? AND is_nap = ?` query. No ad-hoc calendar
    arithmetic in the read path.
  - The pairing-state side table is small (one row per outstanding "лёг" per user, max)
    and TTL'd by `expires_at_utc`. Simple to reason about; GC is a 1-line cron-tools
    skill.
  - DST handling is automatic if `attribution_date_local` is computed via a tz-library
    that handles transitions correctly (`luxon` / `date-fns-tz` in TypeScript). The
    sanity-floor / ceiling check (G2 30 min / 24 h) operates on `duration_min` derived
    from `end_ts_utc - start_ts_utc`, both UTC, so DST-induced wall-clock anomalies
    don't perturb it.
  - Right-to-delete (PRD-003@0.1.3 §5 US-7) is a single `DELETE FROM sleep_records WHERE
    user_id = ?` + `DELETE FROM sleep_pairing_state WHERE user_id = ?`, in the same
    transaction boundary as the existing PRD-001@0.2.0 §5 US-8 delete cascade.
  - The "is_paired_origin" flag (boolean: did this record come from a paired evening +
    morning sequence vs a single morning duration report) is observable but does not
    drive logic outside C18; useful for K3 telemetry decomposition.
- Cons (concrete):
  - Requires a new side table (`sleep_pairing_state`) with its own RLS policy
    (ADR-001@0.1.0 pattern). Acceptable: identical pattern to existing per-user RLS
    surfaces.
  - DST handling is *partly* delegated to the tz-library; we must add a smoke test that
    verifies a sleep crossing the DST transition produces the expected
    `attribution_date_local` (TKT-023@0.1.0 covers this).
- Cost / latency / ops burden: 1 new table, 1 new side table, 1 hourly GC cron skill
  call. No new external dependency. Latency overhead at insert is one tz-projection
  call (~microsecond). Zero overhead at read.

### Option B: Single `sleep_records` table with `attribution_date` computed at read

- Description: Same `sleep_records` columns minus `attribution_date_local` and
  `attribution_tz`. Compute the user-tz attribution date in C9 / C22 at summary
  generation time by joining the user's profile timezone and projecting `end_ts_utc`
  to that tz. Pairing-state is the same as Option A.
- Pros (concrete):
  - Attribution logic is centralised in the read path (C22) rather than written into
    every sleep_record. Changing the attribution rule (e.g. switching from "end" to
    "start" timestamp) is a one-place edit.
- Cons (concrete):
  - **Read-path performance penalty** — every summary generation projects every sleep
    record into the user's tz, instead of querying a pre-computed column with an
    index. PRD-003@0.1.3 §7 ≤5% latency-overhead constraint on the summary path makes this
    risky at the 10 000-user scale (PRD-002@0.2.1 G4).
  - **Tz-policy drift risk** — if the user's timezone is later updated (a feature out
    of PRD-003@0.1.3 scope but plausible in a future PRD), the *historical* attribution
    silently shifts. Option A's persist-at-insert is stable; Option B's compute-at-read
    is implicitly retroactive.
  - PRD-003@0.1.3 §6 K6 ("100% match between active-modality set and summary-section set on a
    rolling-7-day audit") would need to handle the implicit retroactive shift,
    complicating audit logic.
- Cost / latency / ops burden: marginally simpler write path, marginally more expensive
  read path. Not a net win at PRD-003@0.1.3 §7 ≤5% read-path budget.

### Option C: Two separate tables `sleep_episodes` and `nap_episodes` from the start

- Description: Naps live in a different table from main-sleep records, distinguished
  at insert based on the duration ≤ 4 h rule. Each table independently follows the
  midnight-spanning attribution rule.
- Pros (concrete):
  - Schema is self-documenting: the nap class is structurally distinct.
- Cons (concrete):
  - Read path (C22 G6 summary composer) needs to UNION two tables on every summary
    generation. Option A's `is_nap` flag handles this with a single index on
    `(user_id, attribution_date_local, is_nap)`.
  - Right-to-delete cascade has to walk one extra table.
  - Future re-classification (e.g. user marks a 3.5h "nap" as a real sleep block)
    requires moving the row between tables vs flipping a flag. Option A's flag-based
    approach scales better to user-facing edit operations should they appear in a
    future PRD.
- Cost / latency / ops burden: two-table cost on every read, slightly more expensive
  delete cascade, more complex schema migrations. No measurable benefit over Option A.

## Decision

We will use **Option A — single `sleep_records` table with computed `attribution_date`
+ side `sleep_pairing_state` table**.

Concrete contract for TKT-023@0.1.0 to implement:

**`sleep_records` table:**

| column | type | notes |
|---|---|---|
| `record_id` | UUID PK | gen_random_uuid |
| `user_id` | bigint NOT NULL | FK to user table; RLS subject |
| `start_ts_utc` | timestamptz NOT NULL | the sleep start moment (UTC) |
| `end_ts_utc` | timestamptz NOT NULL | the sleep end moment (UTC) |
| `duration_min` | integer NOT NULL | computed: `extract(epoch from end_ts_utc - start_ts_utc) / 60`; CHECK 30 ≤ duration_min ≤ 1440 (G2 sanity bounds, after the soft-warn confirmation flow) |
| `attribution_date_local` | date NOT NULL | the user-tz calendar day of `end_ts_utc`, set at insert |
| `attribution_tz` | text NOT NULL | the IANA tz string used for attribution (snapshot of user profile at insert; immutable thereafter) |
| `is_nap` | boolean NOT NULL | `duration_min ≤ 240`; trigger-set or app-computed |
| `is_paired_origin` | boolean NOT NULL | true if record came from a paired evening "лёг" + morning "встал" sequence; false if from a single morning duration report |
| `created_at` | timestamptz NOT NULL DEFAULT now | audit trail |

Index: `(user_id, attribution_date_local, is_nap)` for the C22 summary read path.

**`sleep_pairing_state` table:**

| column | type | notes |
|---|---|---|
| `user_id` | bigint PK | one outstanding "лёг" per user max |
| `leg_event_ts_utc` | timestamptz NOT NULL | evening "лёг" message timestamp |
| `expires_at_utc` | timestamptz NOT NULL | `leg_event_ts_utc + 24h` |

Pairing state machine (TKT-023@0.1.0):

1. **Inbound evening "лёг" / "иду спать" event** with no existing pairing row: insert
   `sleep_pairing_state(user_id, leg_event_ts_utc, leg_event_ts_utc + 24h)`. Reply with
   a friendly acknowledgement.
2. **Inbound evening "лёг" event** with existing non-expired pairing row: replace the
   row (`UPDATE … WHERE user_id = ?`). Reply with the §5 US-2 4th-AC clarifying message
   ("Кажется, ты уже отметил, что лёг. Старая запись отменена; считаем эту.").
3. **Inbound morning "встал" / "vstal" event** with existing non-expired pairing row:
   compute `start_ts = leg_event_ts_utc`, `end_ts = NOW`,
   `duration_min = (end_ts - start_ts) / 60`. If `30 ≤ duration_min ≤ 1440`: insert
   into `sleep_records` with `is_paired_origin=true`, `is_nap = duration_min ≤ 240`;
   delete pairing row; reply with confirmation. If outside bounds: do NOT persist;
   reply with the §5 US-2 sanity-floor / ceiling soft-warn flow; on user's
   `confirm-as-is` response, persist.
4. **Inbound morning "встал" event** with no pairing row: treat as a confused
   morning-only event; reply with a clarifying message asking the user to provide a
   duration ("Понял, что ты встал, но не вижу когда лёг. Сколько часов спал?"). DO
   NOT persist a sleep_record from this event alone.
5. **Inbound single-event morning duration report** ("спал 7 часов"): C18 parses the
   duration via the existing OmniRoute extraction LLM (C5 voice or direct text); if
   `30 ≤ duration_min ≤ 1440`: compute `end_ts = NOW`, `start_ts = end_ts -
   duration_min`, `is_paired_origin=false`, `is_nap = duration_min ≤ 240`; insert into
   `sleep_records`; reply with confirmation. If outside bounds: §5 US-2 sanity-floor /
   ceiling soft-warn flow.
6. **Hourly GC cron skill** (reuses C8 Cron Dispatcher) deletes expired rows from
   `sleep_pairing_state` where `expires_at_utc < now`.

**Timezone handling:** `attribution_tz` is loaded from the user profile at insert and
snapshotted into the row (immutable per record). Default `UTC` if the user profile has
no timezone set (PRD-001@0.2.0 §5 US-1 onboarding may or may not have set this; current
behaviour is `UTC` — this is preserved without modification at the PRD-003@0.1.3 cycle).
Future PRD that allows tz updates does NOT retroactively update `sleep_records`;
historical attribution stays as it was.

**DST transition handling:** `attribution_date_local` is computed using the standard `luxon` library (TypeScript, ICU-backed, IANA tz database; published by Moment.js
maintainers; <https://moment.github.io/luxon/>). Smoke test in TKT-023@0.1.0 covers a sleep
spanning the spring-forward and fall-back transitions in `Europe/Moscow`,
`Europe/Belgrade`, and `America/Los_Angeles` (three diverse zones; Moscow has no DST
since 2014, Belgrade observes EU DST, LA observes US DST). The `duration_min`
computation is on UTC timestamps so DST does not corrupt it.

(TKT-023@0.1.0 covers the smoke tests; the library pick is recorded here for posterity.)

**Right-to-delete (PRD-003@0.1.3 §5 US-7):** the existing PRD-001@0.2.0 §5 US-8 cascade is
extended (in TKT-021@0.1.0) to include `DELETE FROM sleep_records WHERE user_id = ?` and
`DELETE FROM sleep_pairing_state WHERE user_id = ?` in the same transaction.

## Why the losers lost

- **Option B (compute attribution at read)**: paying a tz-projection cost on every
  summary read at the 10 000-user scale (PRD-002@0.2.1 G4) breaches the PRD-003@0.1.3 §7
  ≤5% read-path budget for no architectural benefit; persist-at-insert is also stable
  against future tz-update PRDs.
- **Option C (two separate tables)**: forces a UNION on every summary read and a
  cross-table delete cascade, with no benefit over Option A's `is_nap` boolean
  + composite index; "naps as a class" is a behavioural distinction, not a structural
  one.

## Consequences

**Positive:**

- C22 Adaptive Summary Composer reads sleep records via a single indexed query per
  user per (daily / weekly / monthly) summary; the index `(user_id,
  attribution_date_local, is_nap)` matches the access pattern exactly. PRD-003@0.1.3 §7 ≤5%
  read-path budget preserved.
- The "fragmented sleep" case (PRD-003@0.1.3 §8 R2) is handled by storing each fragment as
  its own record (one paired evening+morning per fragment OR one morning-duration per
  fragment); the future "manually link" PRD operates on stable record IDs.
- `is_paired_origin` + `is_nap` decompose K3 (PRD-003@0.1.3 §6: sanity-floor rejection rate
  <2%) into actionable telemetry slices: rejection rate decomposed by paired vs single,
  by nap-class vs full-sleep.
- Sanity-floor / ceiling soft-warn flow applies symmetrically to both paired and
  single-event paths; one common state machine, no duplication.

**Negative / trade-offs accepted:**

- A user who wakes up briefly, gets up for a snack, comes back, and goes back to sleep
  has no first-class "fragmented sleep" merge in this PRD. PRD-003@0.1.3 §8 R2 explicitly
  defers this to a future PRD ("fragmented sleep treated as two records the user can
  manually link in a future PRD"); not Architect-territory at this dispatch.
- The pairing window is a hard 24-hour TTL. A user who logs "лёг at 23:00" and then
  doesn't message for >24 h will see their evening event garbage-collected without a
  paired sleep record. The user's next message about that night is treated as a
  single-event morning duration report (path #5). The user can correct retroactively
  *only* in a future PRD that allows past-dated input (PRD-003@0.1.3 §3 NG11 explicitly
  forbids retroactive backfill at this PRD).
- Onboarding-locked timezone is the snapshot at insert; a user who travels across
  timezones during the PRD-003@0.1.3 lifetime has all their sleep records attributed to the
  *home* timezone. PRD-003@0.1.3 §7 explicitly accepts this ("timezone honoured per the
  user's onboarding-locked timezone").

**Follow-up work:**

- TKT-023@0.1.0 implements C18 Sleep Logger including the pairing state machine, the storage
  contract, the sanity-floor / ceiling soft-warn flow, and DST smoke tests for
  `Europe/Moscow`, `Europe/Belgrade`, `America/Los_Angeles`.
- TKT-021@0.1.0 extends ARCH-001@0.5.0 §5 data model with `sleep_records` and
  `sleep_pairing_state` tables, RLS policies, and the right-to-delete cascade.
- TKT-027@0.1.0 (C22 Adaptive Summary Composer) reads from `sleep_records` filtered by
  `attribution_date_local` for the daily / weekly / monthly window, with `is_nap`
  decomposition for the user-facing presentation (the user can see "1 ночной сон, 2
  дневных" in the daily summary).
- A future PRD may revisit fragmented-sleep merge or retroactive backfill or
  travel-tz handling; this ADR's `attribution_tz` snapshot field gives that PRD a
  stable migration path.

## References

- PRD-003@0.1.3 §5 US-2 (verbatim normative AC for midnight-spanning + nap-class +
  pairing flow + sanity-floor)
- PRD-003@0.1.3 §2 G2, §6 K3, §8 R2 (sleep-tracking goals + KPI + risk mitigation)
- PRD-003@0.1.3 §5 US-7 (right-to-delete extension)
- PRD-003@0.1.3 §7 (onboarding-locked timezone constraint; ≤5% latency overhead)
- ADR-001@0.1.0 Postgres + RLS pattern (reused without modification)
- ARCH-001@0.5.0 §5 data model + §3.8 C8 Cron Dispatcher (reused for hourly GC of
  `sleep_pairing_state` expired rows)
- `luxon` library — IANA tz + DST handling: <https://moment.github.io/luxon/>
- IANA Time Zone Database: <https://www.iana.org/time-zones>
