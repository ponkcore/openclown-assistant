/**
 * C21 Russian-language reply copy per ARCH-001@0.6.1 §6.2.2 C21.
 *
 * Tone: caring expert nutritionist-friend, «ты» register, no theatrical
 * praise, no filler, no apologies.  Emoji in keyboard buttons is a
 * Telegram-UX affordance (exception to no-emoji rule per §6.2.2 note).
 */

/** Header text shown when /settings command is invoked. */
export const SETTINGS_HEADER = "Что записывать?";

/** Inline-keyboard button labels per modality + state.
 *  Key matches ModalityName; value has ON and OFF variants. */
export const MODALITY_BUTTON_LABELS: Record<
  string,
  { on: string; off: string }
> = {
  water: { on: "💧 Вода: вкл", off: "💧 Вода: выкл" },
  sleep: { on: "😴 Сон: вкл", off: "😴 Сон: выкл" },
  workout: { on: "🏃 Тренировки: вкл", off: "🏃 Тренировки: выкл" },
  mood: { on: "🙂 Настроение: вкл", off: "🙂 Настроение: выкл" },
};

/** Toggle-confirmation reply per modality + new state. */
export const TOGGLE_CONFIRMATION: Record<
  string,
  { on: string; off: string }
> = {
  water: { on: "Учёт воды включён.", off: "Учёт воды выключен." },
  sleep: { on: "Учёт сна включён.", off: "Учёт сна выключен." },
  workout: {
    on: "Учёт тренировок включён.",
    off: "Учёт тренировок выключен.",
  },
  mood: {
    on: "Учёт настроения включён.",
    off: "Учёт настроения выключен.",
  },
};
