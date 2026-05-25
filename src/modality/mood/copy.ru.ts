/**
 * C20 Russian-language reply copy per ARCH-001@0.6.2 §6.2 + PRD-003@0.1.3 §5 US-4.
 *
 * Tone: caring expert nutritionist-friend, «ты» register, no theatrical
 * praise, no filler, no apologies. Per §6.2.1 zero-emoji default: no emoji
 * in reply text.
 *
 * Per ARCH-001@0.6.2 §6.2 persona spec: feminine first-person past tense
 * ("Записала", not "Записал").
 *
 * NOTE: comment truncation is SILENT per UX simplicity — no reply string
 * for truncation notice.
 */

/** Success reply — score persisted. Placeholder {score} replaced at runtime. */
export const SUCCESS_REPLY = "Записала настроение {score}/10.";

/** Success reply with comment — score + comment persisted. */
export const SUCCESS_REPLY_WITH_COMMENT = "Записала настроение {score}/10 с комментарием.";

/** Out-of-range reply — score outside [1,10]. */
export const OUT_OF_RANGE_REPLY = "Оценка должна быть от 1 до 10. Уточни.";

/** Inferred pending reply — LLM inferred a score, awaiting confirmation. */
export const INFERRED_PENDING_REPLY = "Похоже, настроение около {score}. Подтверди или выбери на клавиатуре.";

/** Pending timeout reply — 5-minute TTL expired. */
export const PENDING_TIMEOUT_REPLY = "Время на подтверждение истекло. Скажи новый балл если хочешь записать.";

/** OFF-state reply — mood modality disabled. */
export const OFF_STATE_REPLY = "Запись настроения сейчас выключена.";
