# PRD-003 content drafts (PO-pending refinement)

> **Status:** drafts produced by Sisyphus orchestrator on 2026-05-24 in response to ARCH-001@0.6.2 §13 Q_TO_BUSINESS_6. Russian primary (the bot's user-facing language); English secondary for PO refinement convenience.
>
> **Consumers:** executor subagent reads these drafts as inputs for TKT-022 (modality router config), TKT-023 (sleep logger), TKT-029 / TKT-030 / TKT-031 (water / workout / mood loggers), TKT-027 (adaptive summary composer), TKT-028 (modality settings service), TKT-025 (ambiguity golden set).
>
> **Refinement:** PO refines on own schedule. No version pinning, no `status:` field — drafts are intentionally evolving. When a draft stabilises and the PO is ready to lock it, that lock happens at the relevant ticket's review pass.

---

## §A — `config/modality-router.json` keyword chains

Per C16 Modality Router (ARCH-001@0.6.2 §3.16) + ADR-015@0.1.0 hybrid (deterministic-first, LLM tie-breaker).

### A.1 Water (RU)

Strict matchers (single deterministic match → route directly to C17):

```
вода, водички, водичка, воду, воды
выпил, выпила, попил, попила
стакан, стакана, стаканов
бутылка, бутылку, бутылки, бутылок
мл, миллилитр, литр, литра, литров
чашка, чашку, чашки
кружка, кружку, кружки
```

Phrase patterns:

```
выпил <число> мл
выпил стакан
попил воды
стакан воды
бутылка воды
0.5 литра воды
литр воды
```

### A.1 Water (EN — for PO reference)

```
water, sip, drink water, glass, bottle, cup, mug
ml, millilitre, liter, litre
drank a glass, drank water
500ml of water, half a litre, one litre
```

### A.2 Sleep (RU)

Evening-side (ADR-017@0.1.0 paired state machine — opens `sleep_pairing_state` row):

```
лёг, легла, ложусь, ложиться, ложусь спать
иду спать, спокойной ночи, сплю, засыпаю
```

Morning-side (closes pairing or single-event duration report):

```
встал, встала, проснулся, проснулась, выспался, выспалась
утро, доброе утро, поднялся, поднялась
спал <число> часов, проспал <число>
```

Direct-duration (single-event path):

```
спал <число> часов
проспал <число>
поспал <число>
дремал <число> минут
```

Nap markers:

```
вздремнул, вздремнула, поспал днём, дневной сон, сиеста
```

### A.2 Sleep (EN — for PO reference)

```
went to bed, going to sleep, lights out, good night
woke up, got up, slept N hours, dozed, took a nap
```

### A.3 Workout (RU)

Activity verbs:

```
бегал, бегала, бежал, побегал, пробежал, пробежала
тренировался, тренировалась, тренировка
плавал, плавала, проплыл
ходил, ходила, гулял, гуляла
ехал на велике, прокатился, велосипед
зал, спортзал, силовая, штанга, гантели, жим
йога, растяжка, стретчинг
табата, hiit, кроссфит
```

Quantitative cues:

```
<число> км, <число> метров
<число> минут, <число> часов
<число> подходов, <число> повторений
```

### A.3 Workout (EN — for PO reference)

```
ran, jogged, gym, lifted, swam, biked, cycled, walked, hiked, yoga
N km, N minutes, N sets, N reps
strength, cardio, hiit, crossfit, tabata
```

### A.4 Mood (RU)

Numeric direct (1-10 scale):

```
настроение <число>
оцениваю на <число>
настрой <число>
ощущения <число>
сегодня <число> из 10
```

Free-form (will route to C20 inferred-score path):

```
настроение, чувствую себя
устал, устала, выгорел, выгорела, разбит, измотан
бодрый, бодрая, в ударе, на подъёме, отлично, замечательно
грустно, грустный, тоскливо, печаль, печально
радостно, радостный, счастлив, рад
тревога, тревожно, нервно, на нервах
спокоен, спокойна, расслаблен
```

### A.4 Mood (EN — for PO reference)

```
mood N, feeling N out of 10
tired, exhausted, burnt out, drained, beat
great, awesome, energised, on fire
sad, gloomy, down
happy, joyful
anxious, nervous, on edge
calm, relaxed, chill
```

### A.5 Routing notes for Architect's deterministic-first chain

- **Order of evaluation:** mood (numeric direct) → sleep (evening + morning) → workout → water → mood (free-form). Numeric mood first because `настроение 8` is unambiguous and must not fall through.
- **Multi-match → LLM tie-breaker:** e.g. "выпил после тренировки" hits both water and workout deterministics. Tie-breaker LLM gets the candidate set and picks one.
- **Zero-match → LLM full-classifier:** anything that doesn't hit any deterministic chain. Confidence < 0.6 → AMBIGUOUS clarifying-reply.
- **Always route to KBJU last:** if zero-match LLM returns "kbju" with high confidence, dispatches to existing C4 path. KBJU is never on the deterministic chain — by design every text-by-default goes to KBJU unless explicitly classified otherwise.

---

## §B — Russian Telegram reply copy (with English mirrors)

### B.1 C17 Water Logger

| Slot | Russian | English mirror |
|---|---|---|
| Confirmation after persist | `Записал {volume_ml} мл воды.` | `Logged {volume_ml} ml of water.` |
| Quick-volume keyboard prompt (when free-form parse fails) | `Сколько воды? Выбери или напиши в мл.` | `How much water? Pick a preset or type in ml.` |
| Modality OFF (silent — no reply) | _(no reply)_ | _(no reply)_ |

### B.2 C18 Sleep Logger

| Slot | Russian | English mirror |
|---|---|---|
| Evening "лёг" registered | `Хорошей ночи. Запишу сон, когда напишешь утром.` | `Good night. I'll log your sleep when you message in the morning.` |
| Morning closes pairing (paired) | `Записал сон: {hours} ч {minutes} мин.` | `Logged sleep: {hours}h {minutes}m.` |
| Morning without prior evening (path #4 — clarifying-reply) | `Не вижу, когда ты лёг. Сколько часов спал?` | `I didn't see when you went to bed. How many hours did you sleep?` |
| Single-event duration report (path #5) | `Записал сон: {hours} ч.` | `Logged sleep: {hours}h.` |
| Sanity-floor warn (<30 мин) | `Меньше 30 минут — это короткий сон. Записать как есть?` | `Less than 30 minutes is a short sleep. Log as-is?` |
| Sanity-ceiling warn (>24 ч) | `Больше 24 часов — это много. Записать как есть?` | `More than 24 hours is a lot. Log as-is?` |
| Nap registered | `Записал дневной сон: {minutes} мин.` | `Logged nap: {minutes}m.` |
| "Лёг" повторно (older invalidated) | `Понял, обновляю время отбоя.` | `Got it, updating the bedtime.` |
| Modality OFF (silent) | _(no reply)_ | _(no reply)_ |

### B.3 C19 Workout Logger

| Slot | Russian | English mirror |
|---|---|---|
| Confirmation (single field) | `Записал тренировку: {type}, {duration_min} мин.` | `Logged workout: {type}, {duration_min} min.` |
| Confirmation (with distance) | `Записал тренировку: {type}, {distance_km} км за {duration_min} мин.` | `Logged workout: {type}, {distance_km} km in {duration_min} min.` |
| Confirmation (strength with weight) | `Записал тренировку: {type}, {sets}×{reps} с {weight_kg} кг.` | `Logged workout: {type}, {sets}×{reps} at {weight_kg} kg.` |
| Zero quantifiable fields (clarifying) | `Сколько? Укажи время, дистанцию или вес.` | `How much? Give me duration, distance, or weight.` |
| Type unclear after extraction | `Какой это был тип тренировки? (силовая / бег / велосипед / плавание / ходьба / йога / hiit / другое)` | `What type of workout? (strength / running / cycling / swimming / walking / yoga / hiit / other)` |
| Photo path: type detected, asking for missing fields | `На фото вижу {type}. Сколько по времени?` | `I see {type} in the photo. How long did it last?` |
| Modality OFF (silent) | _(no reply)_ | _(no reply)_ |

### B.4 C20 Mood Logger

| Slot | Russian | English mirror |
|---|---|---|
| Numeric confirmation | `Записал настроение: {score}/10.` | `Logged mood: {score}/10.` |
| Numeric + comment | `Записал настроение: {score}/10 — "{comment}".` | `Logged mood: {score}/10 — "{comment}".` |
| Inferred-score confirmation prompt | `Похоже, настроение около {score}/10. Так?` | `Sounds like mood ≈ {score}/10. Right?` |
| Inferred yes-confirmation | `Записал настроение: {score}/10.` | `Logged mood: {score}/10.` |
| Inferred edit | `Понял, поправь: какая оценка?` | `Got it, what's the score?` |
| Comment >280 chars | `Комментарий обрезан до 280 символов.` | `Comment truncated to 280 chars.` |
| 5-min TTL expired (silent — no reply) | _(no reply)_ | _(no reply)_ |
| Modality OFF (silent) | _(no reply)_ | _(no reply)_ |

### B.5 C21 Modality Settings Service

| Slot | Russian | English mirror |
|---|---|---|
| `/settings` open | `Что отслеживаем? (КБЖУ всегда вкл)` + 4-toggle keyboard | `What do we track? (KBJU always on)` + 4-toggle keyboard |
| Toggle ON | `Вода — вкл.` / `Сон — вкл.` / `Тренировки — вкл.` / `Настроение — вкл.` | `Water — on.` / `Sleep — on.` / `Workouts — on.` / `Mood — on.` |
| Toggle OFF | `Вода — выкл.` / `Сон — выкл.` / `Тренировки — выкл.` / `Настроение — выкл.` | `Water — off.` / `Sleep — off.` / `Workouts — off.` / `Mood — off.` |
| Save error | `Не сохранил, попробуй ещё раз.` | `Didn't save, try again.` |

### B.6 C22 Adaptive Summary Composer

Section headers (only render section if events > 0 for the period AND modality is ON):

| Section | Russian header | English mirror |
|---|---|---|
| KBJU (always) | `📊 КБЖУ` | `📊 KBJU` |
| Water | `💧 Вода` | `💧 Water` |
| Sleep | `😴 Сон` | `😴 Sleep` |
| Workouts | `🏋️ Тренировки` | `🏋️ Workouts` |
| Mood | `🙂 Настроение` | `🙂 Mood` |

Section body templates:

| Section | RU template | EN mirror |
|---|---|---|
| Water | `{total_ml} мл за день / неделю.` | `{total_ml} ml today / this week.` |
| Sleep daily | `{hours} ч {minutes} мин.` | `{hours}h {minutes}m.` |
| Sleep weekly | `Среднее: {avg_hours} ч/ночь.` | `Average: {avg_hours}h/night.` |
| Workouts | `{count} тренировок: {type_breakdown}.` | `{count} workouts: {type_breakdown}.` |
| Mood | `Среднее: {avg_score}/10 ({trend}).` | `Average: {avg_score}/10 ({trend}).` |

---

## §C — 50-event workout golden test set

Per ADR-016@0.1.0 forced-output JSON schema. Each entry: input text, expected `(type, duration_min, distance_km, sets, reps, weight_kg, raw_description)`.

PO refines: pick the entries that match real Russian phrasing in the wild, replace contrived examples, add 10 edge cases per type.

| # | Russian input | type | duration | distance | sets | reps | weight | notes |
|---|---|---|---|---|---|---|---|---|
| 1 | пробежал 5 км за 30 минут | running | 30 | 5.0 | — | — | — | clean two-field |
| 2 | бегал 40 минут | running | 40 | — | — | — | — | duration only |
| 3 | пробежка 3 километра | running | — | 3.0 | — | — | — | distance only |
| 4 | побегал час | running | 60 | — | — | — | — | hour expansion |
| 5 | беговая дорожка 25 минут 4 км | running | 25 | 4.0 | — | — | — | implied indoor |
| 6 | 10км за 50 минут | running | 50 | 10.0 | — | — | — | no spaces |
| 7 | силовая час | strength | 60 | — | — | — | — | no specifics |
| 8 | жим штанги 4 подхода по 8 раз 60 кг | strength | — | — | 4 | 8 | 60.0 | full strength row |
| 9 | приседания 5x10 80 | strength | — | — | 5 | 10 | 80.0 | shorthand |
| 10 | тренировка зал 50 минут | strength | 50 | — | — | — | — | gym duration |
| 11 | становая 3 по 5 на 100 | strength | — | — | 3 | 5 | 100.0 | preposition variant |
| 12 | гантели 40 минут | strength | 40 | — | — | — | — | duration only |
| 13 | покатался час на велике | cycling | 60 | — | — | — | — | colloquial |
| 14 | велосипед 25 км | cycling | — | 25.0 | — | — | — | distance only |
| 15 | велик 45 минут 15км | cycling | 45 | 15.0 | — | — | — | colloquial + numbers |
| 16 | проплыл 1500 метров | swimming | — | 1.5 | — | — | — | metres-to-km conversion |
| 17 | бассейн 30 минут | swimming | 30 | — | — | — | — | implied via venue |
| 18 | плавал час | swimming | 60 | — | — | — | — | hour |
| 19 | гулял 2 часа | walking | 120 | — | — | — | — | hour expansion |
| 20 | пешком 5 км | walking | — | 5.0 | — | — | — | walking by distance |
| 21 | прогулка 40 минут | walking | 40 | — | — | — | — | nominal walk |
| 22 | йога 60 минут | yoga | 60 | — | — | — | — | clean |
| 23 | растяжка 20 минут | yoga | 20 | — | — | — | — | stretching → yoga |
| 24 | hiit 25 минут | hiit | 25 | — | — | — | — | latin alphabet |
| 25 | табата 20 минут | hiit | 20 | — | — | — | — | tabata variant |
| 26 | кроссфит час | hiit | 60 | — | — | — | — | crossfit variant |
| 27 | поплавал в речке | swimming | — | — | — | — | — | type only, no quantitative → clarifying-reply |
| 28 | устал в зале | strength | — | — | — | — | — | type only → clarifying-reply |
| 29 | бег | running | — | — | — | — | — | one-word → clarifying-reply |
| 30 | сходил в зал | strength | — | — | — | — | — | colloquial → clarifying-reply |
| 31 | велик | cycling | — | — | — | — | — | one-word → clarifying-reply |
| 32 | йога час | yoga | 60 | — | — | — | — | hour |
| 33 | бегал по парку 8км час | running | 60 | 8.0 | — | — | — | with location |
| 34 | гантели 10 кг по 12 раз 4 подхода | strength | — | — | 4 | 12 | 10.0 | reordered |
| 35 | пробежал полумарафон | running | — | 21.1 | — | — | — | named distance |
| 36 | марафон | running | — | 42.2 | — | — | — | one-word distance |
| 37 | бегал на дорожке 30 мин | running | 30 | — | — | — | — | mode + duration |
| 38 | 100 отжиманий | strength | — | — | 1 | 100 | — | calisthenics |
| 39 | подтягивания 5x5 | strength | — | — | 5 | 5 | — | bodyweight |
| 40 | плавал 1 км | swimming | — | 1.0 | — | — | — | km direct |
| 41 | велосипед 1 час 20 минут | cycling | 80 | — | — | — | — | mixed time |
| 42 | гулял по городу 1.5 часа | walking | 90 | — | — | — | — | hour fraction |
| 43 | силовая 1 час 40 минут | strength | 100 | — | — | — | — | mixed time |
| 44 | йога утром 25 минут | yoga | 25 | — | — | — | — | with time qualifier |
| 45 | hiit 4 раунда по 4 минуты | hiit | 16 | — | 4 | — | — | rounds inferred as duration |
| 46 | плавание брассом 1500м | swimming | — | 1.5 | — | — | — | stroke + distance |
| 47 | велогонка 50 км 2 часа | cycling | 120 | 50.0 | — | — | — | race format |
| 48 | пешая прогулка 8000 шагов | walking | — | — | — | — | — | steps → other? clarifying |
| 49 | потанцевал час | other | 60 | — | — | — | — | uncategorised → "other" |
| 50 | покидал мяч 30 минут | other | 30 | — | — | — | — | uncategorised → "other" |

PO refinement note: rows 27-31 deliberately have only `type` set — they're cases where Sisyphus's executor must trigger the "clarifying-reply asking for at least one of duration / distance / weight" path from PRD-003@0.1.3 §5 US-3.

---

## §D — 20-event ambiguity golden test set

Per TKT-025@0.1.0 (modality-input-disambiguation-golden-tests). Each entry: input text + expected outcome from C16 router (deterministic_single, deterministic_multi_llm_resolved, zero_match_llm_resolved, zero_match_llm_ambiguous, ambiguous_clarified, kbju_passthrough).

| # | Russian input | Expected outcome | Notes |
|---|---|---|---|
| 1 | выпил после тренировки | deterministic_multi_llm_resolved → water | "выпил" + "тренировки" both hit; LLM picks water as the action |
| 2 | поспал плотно | deterministic_single → sleep | single sleep keyword |
| 3 | настроение норм | deterministic_single → mood (free-form path) | mood keyword without number |
| 4 | йога с утра под вино | deterministic_multi_llm_resolved → workout | "йога" wins despite alcohol distractor |
| 5 | пара стаканов воды | deterministic_single → water | quantity ambiguous (~500ml) but action clear |
| 6 | спал но не выспался | deterministic_single → sleep | duration unclear → clarifying-reply asking how many hours |
| 7 | бегал и пил воду | deterministic_multi_llm_resolved → workout | LLM picks the more complex tracked event (workout) over water |
| 8 | устал | zero_match_llm_resolved → mood | tiredness inference, low confidence → ambiguous_clarified |
| 9 | салат из огурцов | kbju_passthrough | falls through deterministic chain to C4 KBJU path |
| 10 | каша с молоком | kbju_passthrough | same |
| 11 | кофе утром | deterministic_multi_llm_resolved | "кофе" hits water-adjacent + KBJU; LLM picks KBJU passthrough (caffeine has KBJU value) |
| 12 | сегодня лёгкое настроение 8 | deterministic_single → mood | numeric mood path, score=8 |
| 13 | хорошо поспал, чувствую себя отлично | deterministic_multi_llm_resolved → sleep | sleep wins over mood-free-form because explicit duration cue absent and sleep is more concrete |
| 14 | побегал в парке | deterministic_single → workout | running keyword |
| 15 | стакан воды утром | deterministic_single → water | clean single match |
| 16 | спал 8 часов и пил воду весь день | deterministic_multi_llm_resolved | LLM chooses sleep (more specific event with duration); water without volume discarded |
| 17 | хочу пить | zero_match_llm_ambiguous → ambiguous_clarified | desire ≠ logged event; clarifying-reply "Сколько выпил?" |
| 18 | плохо себя чувствую | zero_match_llm_resolved → mood | low-mood inference path |
| 19 | на тренировке выпил энергетик | deterministic_multi_llm_resolved → workout | workout context dominates; energy drink would go to KBJU separately if user logs |
| 20 | вечером отдохнул и почитал | zero_match_llm_ambiguous → ambiguous_clarified | not a tracked event; clarifying-reply or KBJU passthrough depending on confidence |

PO refinement note: rows 17 and 20 are deliberately the "should NOT log anything" cases — if Sisyphus's classifier silently logs them as anything, that's a regression.

---

## §E — Water quick-volume keyboard preset values

Per TKT-029@0.1.0 (water logger). The 3-button inline keyboard offered when free-form volume parsing fails:

| Button | Volume (ml) | Russian label | English label | Rationale |
|---|---|---|---|---|
| Small | 200 | `Стакан (200 мл)` | `Glass (200 ml)` | Standard Russian glass / cup |
| Medium | 500 | `Бутылка (500 мл)` | `Bottle (500 ml)` | Common bottle size |
| Large | 1000 | `Литр (1000 мл)` | `Litre (1000 ml)` | Typical large-bottle / multi-glass session |

Plus a 4th "free input" button that reopens text input: `Своё значение` / `Custom`.

---

## Refinement schedule

PO refines on no fixed cadence. When a section stabilises, the corresponding executor ticket review pass marks it as locked. Until then, the executor may use these drafts as defaults; the reviewer flags any executor change to drafts as `pass_with_changes` (Medium severity) so the change is captured but doesn't block merge.
