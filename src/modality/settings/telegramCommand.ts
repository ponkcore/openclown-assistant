/**
 * C21 /settings Telegram command handler + inline-keyboard wiring.
 *
 * Per ARCH-001@0.6.1 §3.21 + PRD-003@0.1.3 §5 US-5:
 * - /settings shows a 4-toggle inline keyboard (water/sleep/workout/mood).
 * - KBJU is NOT shown (always-on per PRD-003@0.1.3 §3 NG6).
 * - Tapping a button flips the modality, persists, refreshes the keyboard.
 */

import type { NormalizedTelegramUpdate } from "../../telegram/types.js";
import type {
  RussianReplyEnvelope,
  TelegramInlineKeyboardButton,
} from "../../shared/types.js";
import type {
  ModalitySettingsService,
  ModalityName,
  ModalitySettings,
} from "./service.js";
import {
  SETTINGS_HEADER,
  MODALITY_BUTTON_LABELS,
  TOGGLE_CONFIRMATION,
} from "./copy.ru.js";

// ── Constants ─────────────────────────────────────────────────────────────

/** The four toggleable modalities in display order. */
const MODALITIES: ModalityName[] = ["water", "sleep", "workout", "mood"];

/** Callback-data prefix for settings inline buttons. */
export const CALLBACK_PREFIX = "settings:toggle:";

/** Maps ModalityName → ModalitySettings key. */
const MODALITY_KEYS: Record<ModalityName, keyof ModalitySettings> = {
  water: "waterOn",
  sleep: "sleepOn",
  workout: "workoutOn",
  mood: "moodOn",
};

// ── Keyboard builder ──────────────────────────────────────────────────────

function buildKeyboard(
  settings: ModalitySettings,
): TelegramInlineKeyboardButton[][] {
  return MODALITIES.map((modality) => {
    const key = MODALITY_KEYS[modality];
    const isOn = settings[key];
    const labels = MODALITY_BUTTON_LABELS[modality];
    return [
      {
        text: isOn ? labels.on : labels.off,
        callbackData: `${CALLBACK_PREFIX}${modality}`,
      },
    ];
  });
}

// ── Handler factory ───────────────────────────────────────────────────────

/**
 * Creates the /settings command handler and callback handler.
 * Takes a ModalitySettingsService so callers (entrypoint / tests) control
 * the service lifecycle.
 */
export function createSettingsCommandHandler(service: ModalitySettingsService) {
  /**
   * Handles the /settings command: fetches current settings and returns
   * a RussianReplyEnvelope with the 4-toggle inline keyboard.
   */
  async function handleSettingsCommand(
    update: NormalizedTelegramUpdate,
  ): Promise<RussianReplyEnvelope> {
    const userId = String(update.telegramUserId);
    const settings = await service.getSettings(userId);

    return {
      chatId: update.telegramChatId,
      text: SETTINGS_HEADER,
      replyMarkup: {
        inlineKeyboard: buildKeyboard(settings),
      },
      typingRenewalRequired: false,
    };
  }

  /**
   * Handles a callback_query from the settings inline keyboard.
   * Payload format: "settings:toggle:<modality>".
   * Flips the modality, persists, returns updated keyboard + confirmation text.
   */
  async function handleSettingsCallback(
    update: NormalizedTelegramUpdate,
  ): Promise<RussianReplyEnvelope | null> {
    const callbackData = update.callbackData ?? "";
    if (!callbackData.startsWith(CALLBACK_PREFIX)) return null;

    const modality = callbackData.slice(CALLBACK_PREFIX.length) as ModalityName;
    if (!MODALITIES.includes(modality)) return null;

    const userId = String(update.telegramUserId);
    const current = await service.getSettings(userId);
    const key = MODALITY_KEYS[modality];
    const newValue = !current[key];

    const newSettings = await service.setSetting(userId, modality, newValue);
    const confirmKey = newValue ? "on" : "off";
    const confirmText = TOGGLE_CONFIRMATION[modality][confirmKey];

    return {
      chatId: update.telegramChatId,
      text: confirmText,
      replyMarkup: {
        inlineKeyboard: buildKeyboard(newSettings),
      },
      typingRenewalRequired: false,
    };
  }

  return { handleSettingsCommand, handleSettingsCallback };
}

export type SettingsCommandHandler = ReturnType<typeof createSettingsCommandHandler>;
