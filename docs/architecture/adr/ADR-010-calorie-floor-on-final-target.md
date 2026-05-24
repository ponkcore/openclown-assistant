---
id: ADR-010
title: Calorie floor on final target
version: 0.1.0
status: accepted
arch_ref: ARCH-001@0.4.0
created: 2026-04-30
updated: 2026-04-30
superseded_by: null
---

# ADR-010: Calorie floor on final target

## 0. Recon Report

Scope of this ADR-only cycle: resolve the medical-safety constant surfaced in and cascade the resulting contract into ARCH-001@0.4.0. No Executor ticket, production code, schema migration, test, prompt, or PRD change is part of this PR.

Artifacts audited before decision:

| Artifact | Finding |
|---|---|
| PRD-001@0.2.0 | US-1 requires onboarding target calculation and display, but does not define a lower calorie floor. Non-goals do not exclude this safety guard. |
| ARCH-001@0.3.1 | C2 target creation currently references ADR-005@0.2.0 for BMR, activity adjustment, pace delta, and macro targets, but has no floor contract. |
| ADR-005@0.2.0 | Pins the target-calculation formula constants, including 7700 kcal/kg pace conversion and `formula_version = "mifflin_st_jeor_v1_2026_04"`; it does not bound the final calorie target. |
| | Records the source-of-record gap: `calculateCalories` can return negative or dangerously low values when PRD-001@0.2.0 pace range permits 2.0 kg/week loss for a low-maintenance user. |
| Code locus `src/onboarding/targetCalculator.ts` | Context-only audit found `calculateCalories` returns `maintenanceKcal + goalDelta`; code is intentionally not edited in this Architect PR. |

External sources audited:

| Source | Finding used here |
|---|---|
| NICE NG246 physical activity and diet guidance | Low-energy diets of 800 to 1,200 kcal/day are specialist-supported interventions only; very-low-energy diets under 800 kcal/day are specialist-service interventions only and not long-term strategies. |
| Endotext, `Dietary Treatment of Obesity` | Usual low-calorie diet range is discussed as 1,200 to 1,500 kcal/day in clinical obesity treatment context, and reducing diets require medical assessment. |
| NHLBI/NIDDK clinical guideline via NCBI Bookshelf, Appendix VI | Provides 1,200 kcal and 1,600 kcal reduced-calorie menus and documents that 1,200 kcal menus can miss multiple micronutrient targets, reinforcing that lower outputs are not appropriate as unsupervised bot targets. |

Pilot telemetry caveat: no pilot cohort target-distribution data exists yet. This decision is therefore a precautionary safety guard for a deterministic calculator, not a conclusion derived from observed KBJU Coach usage.

## 1. Context records a post-TKT-005@0.1.0 safety gap: PRD-001@0.2.0 permits a loss pace up to 2.0 kg/week, and ADR-005@0.2.0 converts pace using 7700 kcal/kg. That combination can subtract about 2200 kcal/day from maintenance. For a sedentary low-maintenance adult profile, ARCH-001@0.3.1 C2 target creation can therefore produce a final daily calorie target below common low-calorie diet ranges, below specialist-supervised low-energy boundaries, or even below zero.

KBJU Coach is explicitly non-medical, but it still presents daily calorie and macro targets to the pilot users. The target calculator must not emit values that imply unsupervised very-low-energy dieting or impossible energy intake. The floor belongs in an ADR because ADR-005@0.2.0 already owns durable target-calculation constants and formula-version auditability.

## 2. Options Considered (>=3 real options, no strawmen)

### Option A: Hard sex-specific floor with clamp and disclosure

- Description: Compute the ADR-005@0.2.0 target, then clamp `lose` final daily calories to 1,200 kcal/day for female users and 1,500 kcal/day for male users. If a clamp occurs, show a deterministic Russian disclosure that the requested pace was adjusted because the bot does not set targets below the safety floor.
- Pros (concrete): Prevents impossible or very-low-energy targets without blocking onboarding; preserves the user's selected goal while making the medical-safety intervention explicit. Values align with the common clinical low-calorie range captured by Endotext and keep the bot above NICE's specialist-supervised very-low-energy boundary.
- Cons (concrete, with sources): Sex-specific floors are a coarse proxy and do not account for pregnancy, lactation, eating-disorder risk, high athletic load, or clinician-supervised plans. NICE NG246 treats 800-1,200 kcal/day as specialist-supported low-energy dieting, so the 1,200 kcal female floor is a minimum guard, not an endorsement to diet at 1,200 kcal/day.
- Cost / latency / ops burden: No runtime provider cost; small deterministic calculator, copy, telemetry, and test changes in the downstream Executor ticket.

### Option B: Soft floor that blocks onboarding when the computed target is below floor

- Description: Compute the ADR-005@0.2.0 target, then reject confirmation if it is below the selected floor and require the user to choose a slower pace.
- Pros: Makes the safety boundary very visible and forces a user decision rather than mutating the result.
- Cons: Adds a new onboarding branch and can trap users in a correction loop even when the product can safely explain a clamp. It also couples safety behavior to UX branching instead of preserving a single deterministic target-calculation output.
- Cost / latency / ops burden: No provider cost; higher implementation and test burden because the onboarding state machine needs additional validation and re-prompt paths.

### Option C: Conditional pace upper-bound tightening

- Description: Keep no final calorie floor; instead reduce the effective maximum loss pace for low-maintenance users so the formula cannot cross a safety boundary.
- Pros: Keeps the user's displayed target mathematically derived from pace and maintenance without a separate clamp step.
- Cons: This was the Route 2 alternative recorded in and is less direct: the risk is the final calorie target, not pace itself. It also requires per-profile dynamic pace validation, more onboarding copy, and a new explanation for why the same pace is valid for one user but invalid for another.
- Cost / latency / ops burden: No provider cost; medium implementation complexity in validation and UX.

### Option D: Sex-agnostic 1,200 kcal/day floor

- Description: Clamp every adult `lose` target to at least 1,200 kcal/day regardless of sex.
- Pros: Simplest constant and easiest copy; aligns with the lower edge of several reduced-calorie menu examples and avoids depending on binary sex values for the floor.
- Cons: Allows male users to receive lower targets than the common 1,200-1,500 kcal/day low-calorie range would imply. It is less conservative for the exact candidate values.
- Cost / latency / ops burden: Lowest implementation burden; weaker safety posture for male profiles.

## 3. Decision

We will use **Option A: Hard sex-specific floor with clamp and disclosure**.

Final daily calorie target floors for `goal = lose`:

| sex | minimum final target |
|---|---:|
| female | 1,200 kcal/day |
| male | 1,500 kcal/day |

The floor is a product safety bound for KBJU Coach's non-medical target calculator. It is not medical advice, not a clinician-supervised diet plan, and not a recommendation that users should eat exactly the floor value.

Why the losers lost:

- Option B: It is safer than no floor, but blocks onboarding when a deterministic clamp plus disclosure gives the same boundary with less state-machine complexity.
- Option C: It changes the input variable rather than guarding the final emitted risk value, making the safety boundary indirect and harder to explain to users; the floor on the output value is also independent of any future pace-validation tightening that might still be desirable for unrelated reasons.
- Option D: It is simpler, but less conservative for male users than the common 1,200-1,500 kcal/day clinical low-calorie range.

## 4. Decision Detail: Calorie Floor Parameters

### Q1: Floor constants

`MIN_DAILY_CALORIES_BY_SEX`:

| sex | value |
|---|---:|
| female | 1200 |
| male | 1500 |

Unit: kcal/day.

Source interpretation: Endotext discusses usual low-calorie diet treatment around 1,200 to 1,500 kcal/day; NICE NG246 places 800 to 1,200 kcal/day low-energy diets and under-800 kcal/day very-low-energy diets inside specialist-supported services, and says those approaches are not long-term strategies. NHLBI/NIDDK reduced-calorie menus include 1,200 kcal and 1,600 kcal examples and document nutrient shortfalls in 1,200 kcal menus, supporting a conservative minimum rather than lower unsupervised bot outputs.

### Q2: Breach behavior

If the raw rounded `lose` target is below the applicable floor, C2 MUST clamp the persisted `calories_target` to the floor and C1 MUST disclose the clamp in the onboarding target summary before confirmation.

Required Russian copy intent, exact wording to be finalized in the downstream Executor ticket: "Я не ставлю цель ниже безопасного минимума. При выбранном темпе расчет получился ниже, поэтому цель ограничена до {floor} ккал/день. Это не медицинская рекомендация; если нужен более жесткий план, обсуди его с врачом." 

For `maintain` and `gain`, C2 MUST NOT apply this floor because the ADR-005@0.2.0 delta is zero or positive. If future validation allows non-binary or unknown sex values, the downstream Architect or PO must ratify a separate fallback; ADR-010@0.1.0 only covers the PRD-001@0.2.0 current sex answers.

### Q3: Application order and rounding

Canonical order:

1. Compute BMR using ADR-005@0.2.0 Q1.
2. Compute activity-adjusted maintenance using ADR-005@0.2.0 Q2.
3. Compute signed daily pace delta using ADR-005@0.2.0 Q3.
4. Compute `raw_calories = maintenance_kcal + daily_delta_kcal`.
5. Round `raw_calories` using ADR-005@0.2.0 Q5.
6. Apply the ADR-010@0.1.0 floor to the rounded calorie value for `goal = lose`.
7. Compute macro grams from the final clamped calorie value using ADR-005@0.2.0 Q4 and Q5.

This order ensures persisted macro targets are internally derived from the same final calorie target shown to the user.

### Q4: Telemetry and audit event

When a clamp occurs, C2 MUST emit a durable C10 metric event named `kbju_onboarding_target_floor_clamped` after TKT-015@0.1.0 observability hardening is available. This event is not a raw medical record and MUST follow ARCH-001@0.4.0 §8 redaction rules.

Allowed event fields:

| field | allowed value |
|---|---|
| `user_id` | internal user UUID, handled under existing durable metric deletion semantics |
| `goal` | `lose` |
| `sex` | `female` or `male` |
| `raw_calories_kcal` | integer rounded raw value before clamp |
| `floor_calories_kcal` | 1200 or 1500 |
| `formula_version` | `mifflin_st_jeor_v2_2026_04` |
| `outcome` | `clamped` |

No height, weight, age, raw Telegram text, username, or free-form user input may be included. remains the source-of-record for state-corruption reset telemetry and is not expanded by this ADR.

### Q5: Formula versioning

The downstream code MUST persist `formula_version = "mifflin_st_jeor_v2_2026_04"` for targets calculated under ADR-010@0.1.0.

Rationale: the BMR coefficients, activity multipliers, pace conversion, macro split, and `Math.round` rule remain from ADR-005@0.2.0, but the final persisted calorie and macro targets can now differ because the calorie floor is applied before macro conversion. Persisted target rows therefore need a new formula version for audit and future K7 analysis.

### Q6: Follow-up ticket boundary

After ADR-010@0.1.0 is accepted by the PO and ARCH-001@0.4.0 is approved, a new Executor ticket may be promoted from. That ticket should implement only the clamp, copy, formula-version bump, telemetry event, and focused tests for C2/C1. It should not re-open ADR-005@0.2.0 formula constants or change PRD-001@0.2.0 pace limits unless a new Architect cycle authorizes that scope.

## 5. Consequences

- Positive: KBJU Coach will not persist or display negative, under-800, or male-below-1,500 loss targets from aggressive pace selections.
- Positive: Users receive a clear disclosure instead of a silent target mutation.
- Negative / trade-offs accepted: The sex-specific floor is intentionally coarse and does not replace medical screening for pregnancy, lactation, eating-disorder risk, chronic disease, or clinician-supervised diets.
- Negative / trade-offs accepted: Some users selecting aggressive loss pace will see a slower effective deficit than requested.
- Follow-up work: Promote to an Executor ticket only after ADR-010@0.1.0 is accepted and ARCH-001@0.4.0 is approved.
- Audit impact: C2 target rows calculated after implementation must carry `formula_version = "mifflin_st_jeor_v2_2026_04"`; clamp events use `kbju_onboarding_target_floor_clamped` with the bounded fields in §4 Q4.

## 6. References

-: `docs/backlog/onboarding-followups.md`
- PRD-001@0.2.0: approved KBJU Coach PRD.
- ARCH-001@0.3.1: approved KBJU Coach architecture baseline for this cycle.
- ADR-005@0.2.0: accepted hybrid KBJU estimation and target-formula ADR.
- NICE NG246, Physical activity and diet, recommendations 1.16.8 through 1.16.12: <https://www.nice.org.uk/guidance/ng246/chapter/Physical-activity-and-diet>
- Endotext, Dietary Treatment of Obesity: <https://www.ncbi.nlm.nih.gov/books/NBK278991/>
- NHLBI/NIDDK Clinical Guidelines on the Identification, Evaluation, and Treatment of Overweight and Obesity in Adults, Appendix VI Practical Dietary Therapy Information: <https://www.ncbi.nlm.nih.gov/books/n/obesity/A562/>
