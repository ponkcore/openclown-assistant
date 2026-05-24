---
id: ADR-005
title: Hybrid KBJU Estimation
version: 0.2.0
status: accepted
arch_ref: ARCH-001@0.3.1
created: 2026-04-26
updated: 2026-04-29
superseded_by: null
---

# ADR-005: Hybrid KBJU Estimation

## Context
ARCH-001@0.3.1 C2 and C6 need deterministic target calculation plus meal KBJU estimates for Russian free text, voice transcripts, corrected photo item lists, and manual entry. PRD-001@0.2.0 §7 requires a food/nutrition reference database for a hybrid lookup path, with LLM-only degradation allowed if lookup integration cost exceeds the ceiling. PRD-001@0.2.0 K7 leaves the numeric accuracy target open for Architect feasibility.

## Options Considered (>=3 real options, no strawmen)
### Option A: Open Food Facts + USDA FoodData Central lookup with LLM fallback
- Description: Parse food items/portions with ADR-002@0.1.0 text model, lookup known foods in Open Food Facts and USDA FoodData Central, normalize per-100g or serving values, and use the LLM only for item disambiguation, portion estimation, or no-lookup cases. Cache normalized lookup hits in C3.
- Pros (concrete): Open Food Facts provides open database exports and a live JSON API, with data under ODbL and content under Database Contents License (<https://world.openfoodfacts.org/data>). USDA FoodData Central provides REST food search/details endpoints, public-domain data under CC0, and a default 1,000 requests/hour/IP limit (<https://fdc.nal.usda.gov/api-guide>). This gives a zero-fee primary reference path and preserves the LLM budget for ambiguous Russian text.
- Cons (concrete, with sources): Open Food Facts warns live API use should correspond to real user scans and that bulk scraping should use exports (<https://world.openfoodfacts.org/data>). USDA coverage skews US/generic foods, not Russian home-cooked meals. LLM portion estimates remain the largest K7 uncertainty.
- Cost / latency / ops burden: $0 API cost; USDA rate limit is 1,000/hour/IP; one or two lookup HTTP calls add expected hundreds of milliseconds but remain inside text/photo budgets if timed out quickly; medium ops for normalization/cache.

### Option B: Open Food Facts only
- Description: Use only Open Food Facts API/exports and no USDA source.
- Pros: Open data, strong packaged-product coverage, useful per-100g nutrition facts.
- Cons: PRD-001@0.2.0 NG8 excludes barcode/package scanning, and the pilot's likely home-cooked foods need generic items that Open Food Facts may not cover. Live API anti-scraping guidance limits aggressive search use (<https://world.openfoodfacts.org/data>).
- Cost / latency / ops burden: $0 cost; lower data-coverage ops; lower accuracy for non-packaged meals.

### Option C: Paid nutrition NLP API such as Edamam or FatSecret
- Description: Send food text to a dedicated nutrition provider for NLP and macro calculation.
- Pros: Edamam explicitly supports food entity extraction from unstructured text and chatbots transcribing natural speech to text (<https://developer.edamam.com/edamam-docs-nutrition-api>). FatSecret exposes food search, NLP, and image-recognition APIs with OAuth authentication (<https://platform.fatsecret.com/docs/guides/api-overview>).
- Cons: Adds paid/licensed dependency and another user-data processor. Edamam documentation describes ongoing licensing counts for newly analyzed recipes/ingredient lines, which is hard to bound for a casual logging bot (<https://developer.edamam.com/edamam-docs-nutrition-api>). FatSecret image/NLP methods are marked premier-exclusive in the docs, creating pricing/contract uncertainty.
- Cost / latency / ops burden: Cost uncertain without account plan; medium-to-high ops due auth, licensing, and provider data-retention review.

### Option D: LLM-only estimation
- Description: Skip food lookup and ask the text/vision model to produce all item KBJU values directly.
- Pros: Simplest implementation and fastest happy path; no nutrition API outage.
- Cons: Weak source attribution and harder K7 audit. It also ignores PRD-001@0.2.0 §7's expected hybrid lookup path unless in degrade mode.
- Cost / latency / ops burden: About $0.14/month for 240 text calls at the ADR-002@0.1.0 initial budget; lowest implementation burden; highest accuracy risk.

### Option E: Fork Phase 0 `calorie-counter`
- Description: Port or fork the audited `calorie-counter` skill as the baseline calculation engine.
- Pros: Existing nutrition-tracker reference from ARCH-001@0.3.1 §0.2 Capability A; simple SQLite/stdlib behavior.
- Cons: Phase 0 found it covers only calories/protein and lacks fat/carbs, Russian parsing, tenant isolation, and confirmation gates. Porting Python 3.7 logic conflicts with Node 24 TypeScript skill runtime.
- Cost / latency / ops burden: $0 provider cost; high rewrite/port burden for incomplete domain coverage.

### Option F: Fork Calorie Visualizer local `foods.json` plus USDA fallback pattern
- Description: Use the MIT `lwashington/calorie-visualizer` `foods.json` shape as a local common-food seed list, then call USDA FoodData Central when the local JSON misses.
- Pros: SPIKE-002@0.1.0 found the data shape matches KBJU needs (`calories`, `protein`, `carbs`, `fat`, serving fields) and the local-first pattern reduces latency/provider calls for common foods.
- Cons: Python implementation is not reusable in the Node 24 sidecar; the observed food list is tiny (~20-30 items) and not Russian-localized. Photo recognition claims in the README are aspirational, not implemented code.
- Cost / latency / ops burden: $0 for MIT data if attribution is preserved; low ops for vendored JSON; still requires USDA key/config and TypeScript normalization.

## Decision
We will use **Option A: Open Food Facts + USDA FoodData Central lookup with LLM fallback**, supplemented by Option F's local-first `foods.json` seed pattern if license attribution and data normalization are preserved.

Target calculation for onboarding uses Mifflin-St Jeor BMR, activity multiplier, and a disclosed calorie delta from selected pace. PubMed records the Mifflin equations and reports Harris-Benedict overestimated measured REE by 5% in that study (<https://pubmed.ncbi.nlm.nih.gov/2305711/>). NIDDK Body Weight Planner is a reference for exposing sex, age, height, weight, physical activity, goal weight, and minimum-calorie warnings in a non-medical planning flow (<https://www.niddk.nih.gov/bwp>), but v0.1 implements deterministic local math, not a medical planner.

K7 feasibility recommendation for Phase 11: set the initial manual-labelling target at **within +/-25% calories and +/-30% protein/fat/carbs per meal after user correction opportunity; within +/-15% daily calories and +/-20% daily macros across days with at least 3 confirmed meals**. This is a product accuracy target for the hybrid draft-plus-confirmation workflow, not a promise of raw model truth.

Why the losers lost:
- Option B: Packaged-product data alone is too narrow for Russian free-form meals.
- Option C: Dedicated APIs are plausible later, but pricing/licensing uncertainty conflicts with the $10 pilot cap.
- Option D: LLM-only is the degrade path, not the primary path requested by PRD-001@0.2.0 §7.
- Option E: The audited skill is a reference only; it misses required KBJU fields and runtime constraints.
- Option F: Accepted as a seed-data/pattern supplement, not as a runtime implementation replacement.

## Decision Detail: KBJU Formula Parameters

### Q1: Mifflin-St Jeor BMR coefficients (kcal/day)

Male: BMR = 10·weight_kg + 6.25·height_cm − 5·age_years + 5

Female: BMR = 10·weight_kg + 6.25·height_cm − 5·age_years − 161

Source: PMID 2305711 (Mifflin et al., 1990 — original publication)

### Q2: Activity multiplier table (TDEE = BMR × multiplier)

| activity_level | multiplier |
|---|---|
| sedentary | 1.2 |
| light | 1.375 |
| moderate | 1.55 |
| active | 1.725 |
| very_active | 1.9 |

Source: Harris-Benedict-derived industrial standard (cited e.g., NIDDK Body Weight Planner methodology brief).

### Q3: Pace-to-calorie-delta conversion

Constant: 7700 kcal per 1 kg body weight change

`pace_kg_per_week` is stored as a positive value in the PRD-001@0.2.0 §3 range `0.1–2.0 kg/week` for both `lose` and `gain`; `maintain` ignores pace per the same PRD section. The calorie-delta sign is derived from `goal`:

- `lose`: `daily_delta_kcal = -(pace_kg_per_week × 7700 / 7)` (deficit)
- `gain`: `daily_delta_kcal = +(pace_kg_per_week × 7700 / 7)` (surplus)
- `maintain`: `daily_delta_kcal = 0` (pace ignored)

### Q4: Macro split per goal (% of total daily kcal)

| goal | protein | fat | carbs |
|---|---|---|---|
| lose | 30% | 25% | 45% |
| maintain | 25% | 30% | 45% |
| gain | 25% | 25% | 50% |

Conversion to grams (canonical Atwater coefficients):

protein_g = (calories_target × protein_pct) / 4

fat_g = (calories_target × fat_pct) / 9

carbs_g = (calories_target × carbs_pct) / 4

### Q5: Rounding rule for final integer targets

Math.round (round-half-up) for calories_target, protein_g, fat_g, carbs_g.

Apply rounding after macro-percent → grams conversion (not before).

Sum of rounded macro grams may diverge ≤2 kcal from calories_target — this is acceptable (documented tradeoff, not a bug).

### Formula version

The downstream code MUST persist `formula_version = "mifflin_st_jeor_v1_2026_04"` alongside any calculated `user_targets` row for audit trail.

## Consequences
- Positive: The estimator has source attribution for common foods and a cost-free lookup leg before LLM fallback.
- Negative / trade-offs accepted: Portion estimation remains approximate, especially for photos and home-cooked mixed dishes; the UX must present drafts as estimates and require confirmation.
- Follow-up work: ARCH-001@0.3.1 Phase 6 must define item source fields (`off`, `usda_fdc`, `llm_fallback`, `manual_entry`), confidence, correction deltas, and lookup-cache retention.
- SPIKE-002@0.1.0 follow-up: if `foods.json` is vendored, include MIT attribution and add `local_food_seed` as an item source before `usda_fdc` / `off` / `llm_fallback`.
- Audit impact: C2 must persist the formula-version field on each `user_targets` calculation so target rows can be traced to this ADR amendment during K7 and tenant audits.

## References
- Open Food Facts data and API reuse terms: <https://world.openfoodfacts.org/data>
- USDA FoodData Central API guide: <https://fdc.nal.usda.gov/api-guide>
- Edamam Nutrition Analysis API docs: <https://developer.edamam.com/edamam-docs-nutrition-api>
- FatSecret Platform API docs: <https://platform.fatsecret.com/docs/guides/api-overview>
- Mifflin-St Jeor PubMed record PMID 2305711: <https://pubmed.ncbi.nlm.nih.gov/2305711/>
- NIDDK Body Weight Planner: <https://www.niddk.nih.gov/bwp>
- Phase 0 KBJU-skill audit in ARCH-001@0.3.1 §0.2 Capability A
