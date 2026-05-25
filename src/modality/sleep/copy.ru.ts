/**
 * C18 Russian-language reply copy per ARCH-001@0.6.2 §6.2.2 + PRD-003@0.1.3 §5 US-2.
 *
 * Tone: caring expert nutritionist-friend, «ты» register, no theatrical
 * praise, no filler, no apologies. Per §6.2.1 zero-emoji default: no emoji
 * in reply text.
 *
 * Per ARCH-001@0.6.2 §6.2 persona spec: feminine first-person past tense
 * ("Записала", not "Записал").
 *
 * Strings are CHARACTER-FOR-CHARACTER per ARCH-001@0.6.2 §6.2.2 C18 block.
 */

/** Evening "лёг" acknowledgement — awaiting morning "встал". */
export const EVENING_ACK_REPLY = "Сладких снов. Утром скажи «встал» — посчитаю длительность.";

/** Evening "лёг" when pairing already exists — old invalidated, new replaces. */
export const EVENING_REPLACE_PAIR_REPLY = "Кажется, ты уже отметил, что лёг. Старая запись отменена; считаем эту.";

/** Paired morning "встал" — sleep persisted. Placeholder {h} and {m} replaced at runtime. */
export const PAIRED_SUCCESS_REPLY = "Записала: спал(а) {h} ч {m} мин. С {start} до {end}.";

/** Morning "встал" without prior "лёг" — clarifying message per §5 US-2 AC#5. */
export const MORNING_NO_PAIR_REPLY = "Не вижу записи «лёг» вчера. Сколько спал(а)? Можешь написать «поспал(а) 7 часов» или «лёг в 23, встал в 7».";

/** Single-event morning duration — sleep persisted. Placeholder {h} and {m} replaced at runtime. */
export const SINGLE_EVENT_SUCCESS_REPLY = "Записала: спал(а) {h} ч {m} мин.";

/** Sanity-floor warn — duration < 30 min. Per §6.2.2 C18 block. */
export const SANITY_FLOOR_WARN = "Меньше 30 минут — это похоже на дрёму, а не сон. Записать как «дневной сон» или отменить?";

/** Sanity-ceiling warn — duration > 24h. Per §6.2.2 C18 block. */
export const SANITY_CEILING_WARN = "Больше 24 часов? Похоже, опечатка. Уточни длительность.";

/** Modality OFF — silent per §6.2.2, but we keep a reply for debug. */
export const OFF_STATE_REPLY = "Запись сна сейчас выключена.";
