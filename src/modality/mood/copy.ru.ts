/**
 * C20 Russian-language reply copy per ARCH-001@0.6.2 §6.2.2 + PRD-003@0.1.3 §5 US-4.
 *
 * Tone: caring expert nutritionist-friend, «ты» register, no theatrical
 * praise, no filler, no apologies. Per §6.2.1 zero-emoji default: no emoji
 * in reply text.
 *
 * Per ARCH-001@0.6.2 §6.2 persona spec: feminine first-person past tense
 * ("Записала", not "Записал").
 *
 * Comment truncation is NOT silent per ARCH-001@0.7.0 §6.2.2 C20:
 * overflow → truncate to 280 chars + friendly Russian notice.
 *
 * Strings are CHARACTER-FOR-CHARACTER per ARCH-001@0.6.2 §6.2.2 C20 block.
 */

/** Success reply — score persisted (§6.2.2: «Записала настроение 7/10.»). Placeholder {score} replaced at runtime. */
export const SUCCESS_REPLY = "Записала настроение {score}/10.";

/** Success reply with comment — score + comment persisted. */
export const SUCCESS_REPLY_WITH_COMMENT = "Записала настроение {score}/10 с комментарием.";

/** Comment-truncated reply — comment exceeded 280 chars, was truncated (§6.2.2 C20: «Сократила комментарий до 280 символов. Записала настроение 7/10.»). Placeholder {score} replaced at runtime. */
export const COMMENT_TRUNCATED_REPLY = "Сократила комментарий до 280 символов. Записала настроение {score}/10.";

/** Out-of-range reply — score outside [1,10] from explicit user input. */
export const OUT_OF_RANGE_REPLY = "Оценка должна быть от 1 до 10. Уточни.";

/** Inferred pending reply — LLM inferred a score, awaiting confirmation (§6.2.2: «Записать как 6/10? Или укажи точную оценку 1-10.»). */
export const INFERRED_PENDING_REPLY = "Записать как {score}/10? Или укажи точную оценку 1-10.";

/** 1-10 keyboard prompt — shown when no text input, user picks a score (§6.2.2: «Оцени настроение от 1 до 10.»). */
export const KEYBOARD_PROMPT = "Оцени настроение от 1 до 10.";

/** Pending timeout reply — 5-minute TTL expired (§6.2.2: silent drop, but notify user on next interaction). */
export const PENDING_TIMEOUT_REPLY = "Время на подтверждение истекло. Скажи новый балл если хочешь записать.";

/** OFF-state reply — mood modality disabled (§6.2.2: silent). */
export const OFF_STATE_REPLY = "Запись настроения сейчас выключена.";
