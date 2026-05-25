/**
 * C17 Russian-language reply copy per ARCH-001@0.6.2 §6.2 + PRD-003@0.1.3 §5 US-1.
 *
 * Tone: caring expert nutritionist-friend, «ты» register, no theatrical
 * praise, no filler, no apologies. Per §6.2.1 zero-emoji default: no emoji
 * in reply text. Emoji in keyboard buttons is a Telegram-UX affordance
 * (exception per §6.2.2 note) — see keyboard.ts.
 *
 * Per ARCH-001@0.6.2 §6.2 persona spec: feminine first-person past tense
 * ("Записала", not "Записал").
 */

/** Success reply — volume persisted. Placeholder {ml} replaced at runtime. */
export const SUCCESS_REPLY = "Записала {ml} мл воды";

/** Out-of-range reply — volume outside (0, 5000]. */
export const OUT_OF_RANGE_REPLY =
  "Укажите объём от 1 до 5000 мл или выберите кнопку ниже";

/** OFF-state reply — water modality disabled. */
export const OFF_STATE_REPLY = "Учёт воды выключен. Включить: /settings";

/** Low-confidence retry reply — LLM couldn't parse the volume. */
export const LOW_CONFIDENCE_REPLY =
  "Не удалось распознать объём. Укажите миллилитры или нажмите кнопку ниже";
