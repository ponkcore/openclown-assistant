import type { C1Deps, TelegramHandlers } from "../telegram/types.js";
import type { NormalizedTelegramUpdate } from "../telegram/types.js";
import type { RussianReplyEnvelope } from "../shared/types.js";
import type { MetricsRegistry } from "../observability/metricsEndpoint.js";
import type { Allowlist } from "../security/allowlist.js";
import path from "node:path";

export function createHandlerStub(
  replyText: string
): (update: NormalizedTelegramUpdate) => Promise<RussianReplyEnvelope> {
  return async (update: NormalizedTelegramUpdate): Promise<RussianReplyEnvelope> => ({
    chatId: update.telegramChatId,
    text: replyText,
    typingRenewalRequired: false,
  });
}

export function createStubHandlers(): TelegramHandlers {
  return {
    start: createHandlerStub(
      "Привет! Это КБЖУ-тренер. Расскажите о себе для расчёта норм."
    ),
    forgetMe: createHandlerStub(
      "Все ваши данные удалены. Чтобы начать заново, отправьте /start."
    ),
    textMeal: createHandlerStub(
      "Приблизительно: 450 ккал, Б:30г, Ж:10г, У:60г. Подтвердить запись?"
    ),
    voiceMeal: createHandlerStub(
      "Расшифровано: курица с рисом. ~450 ккал. Подтвердить?"
    ),
    photoMeal: createHandlerStub(
      "На фото: курица с рисом. ~450 ккал. Подтвердить?"
    ),
    history: createHandlerStub(
      "Сегодня: 1500 ккал из 2000 ккал. Б: 80г, Ж: 50г, У: 180г."
    ),
    callback: createHandlerStub("Запись подтверждена! Продолжайте в том же духе."),
    summaryDelivery: createHandlerStub(
      "Итоги за сегодня: 1800 ккал из 2000 ккал. Отклонение: -200 ккал."
    ),
  };
}

function createNullMetricsRegistry(): MetricsRegistry {
  return {
    increment: () => {},
    set: () => {},
    observe: () => {},
    getSamples: () => [],
    render: () => "",
  };
}

// ── C16 Modality Router wiring ────────────────────────────────────────────
// Per TKT-022: C16 is wired into C1 dispatch path for text + voice-transcribed.
// Photo dispatch is unchanged (per §3 NOT-In-Scope bullet 5).
// The router wraps the textMeal and voiceMeal handlers: before dispatching
// to the KBJU handler, it routes through C16. Other handlers are untouched.

import {
  routeModality,
  ModalityRouterConfigLoader,
  defaultC4KbjuDetector,
  CLARIFYING_REPLY_TEXT,
  CLARIFYING_KEYBOARD_BUTTONS,
  CLARIFYING_KEYBOARD_CALLBACK_DATA,
} from "../modality/router.js";
import { ClassifierConfigLoader, classifyViaLLM } from "../modality/router-classifier.js";

/**
 * Create a C16-wrapped handler that routes text/voice messages through
 * the modality router before dispatching to the per-modality handler.
 *
 * Currently, only the KBJU handler is wired (existing C4 path).
 * Future tickets (TKT-023/029/030/031) will add water/sleep/workout/mood
 * handlers. For now, non-KBJU/AMBIGUOUS modalities fall through to the
 * original handler (C4 KBJU path).
 */
export function createC16WrappedTextHandler(
  originalHandler: (update: NormalizedTelegramUpdate) => Promise<RussianReplyEnvelope | null>,
  configLoader: ModalityRouterConfigLoader,
  classifierConfigLoader: ClassifierConfigLoader,
  c4Detector: (text: string) => boolean,
  logger: import("../shared/types.js").OpenClawLogger,
  metricsRegistry: MetricsRegistry,
  callClassifier: typeof classifyViaLLM
): (update: NormalizedTelegramUpdate) => Promise<RussianReplyEnvelope | null> {
  return async (update: NormalizedTelegramUpdate): Promise<RussianReplyEnvelope | null> => {
    const text = update.text ?? "";
    if (!text) {
      return originalHandler(update);
    }

    const decision = await routeModality(
      { text, requestId: update.requestId, userId: String(update.telegramUserId) },
      {
        configLoader,
        classifierConfigLoader,
        c4Detector,
        logger,
        metricsRegistry,
        callClassifier,
      }
    );

    // AMBIGUOUS → send clarifying-reply inline keyboard (ARCH-001 §6.2.2 verbatim)
    if (decision.modality === "AMBIGUOUS") {
      const buttons = CLARIFYING_KEYBOARD_BUTTONS.map((text, i) => ({
        text,
        callbackData: CLARIFYING_KEYBOARD_CALLBACK_DATA[i],
      }));
      // Two rows of 3 buttons each
      const inlineKeyboard: import("../shared/types.js").TelegramInlineKeyboardButton[][] = [
        buttons.slice(0, 3),
        buttons.slice(3, 6),
      ];
      return {
        chatId: update.telegramChatId,
        text: CLARIFYING_REPLY_TEXT,
        replyMarkup: { inlineKeyboard },
        typingRenewalRequired: false,
      };
    }

    // For now, all non-AMBIGUOUS routes go to the original KBJU handler.
    // TKT-023/029/030/031 will add per-modality dispatch.
    return originalHandler(update);
  };
}

// ── Config loader defaults ────────────────────────────────────────────────

const ROUTER_CONFIG_PATH = path.resolve("config/modality-router.json");
const CLASSIFIER_CONFIG_PATH = path.resolve("config/modality-router-classifier.json");

/**
 * Create C16 router and classifier config loaders.
 * Returns null loaders if config files are absent (graceful degradation).
 */
function createC16ConfigLoaders(
  metricsRegistry: MetricsRegistry,
  logger: import("../shared/types.js").OpenClawLogger
): {
  configLoader: ModalityRouterConfigLoader | null;
  classifierConfigLoader: ClassifierConfigLoader | null;
} {
  let configLoader: ModalityRouterConfigLoader | null = null;
  let classifierConfigLoader: ClassifierConfigLoader | null = null;

  try {
    configLoader = new ModalityRouterConfigLoader(
      ROUTER_CONFIG_PATH,
      metricsRegistry,
      logger
    );
  } catch {
    logger.warn("C16 router config could not be loaded; modality routing disabled");
  }

  try {
    classifierConfigLoader = new ClassifierConfigLoader(
      CLASSIFIER_CONFIG_PATH,
      logger
    );
  } catch {
    logger.warn("C16 classifier config could not be loaded; modality routing disabled");
  }

  return { configLoader, classifierConfigLoader };
}

export function createSidecarDeps(pilotUserIds: string[], allowlist?: Allowlist): C1Deps {
  const metricsRegistry = createNullMetricsRegistry();
  const logger: import("../shared/types.js").OpenClawLogger = {
    info: (msg) => console.log(`[sidecar:info] ${msg}`),
    warn: (msg) => console.warn(`[sidecar:warn] ${msg}`),
    error: (msg) => console.error(`[sidecar:error] ${msg}`),
    critical: (msg) => console.error(`[sidecar:critical] ${msg}`),
  };

  // Create base stub handlers
  const baseHandlers = createStubHandlers();

  // Attempt to wire C16 modality router into text + voice handlers
  const { configLoader, classifierConfigLoader } = createC16ConfigLoaders(metricsRegistry, logger);

  let textMealHandler = baseHandlers.textMeal;
  let voiceMealHandler = baseHandlers.voiceMeal;

  if (configLoader && classifierConfigLoader) {
    textMealHandler = createC16WrappedTextHandler(
      baseHandlers.textMeal,
      configLoader,
      classifierConfigLoader,
      defaultC4KbjuDetector,
      logger,
      metricsRegistry,
      classifyViaLLM
    );
    voiceMealHandler = createC16WrappedTextHandler(
      baseHandlers.voiceMeal,
      configLoader,
      classifierConfigLoader,
      defaultC4KbjuDetector,
      logger,
      metricsRegistry,
      classifyViaLLM
    );
  }

  return {
    handlers: {
      ...baseHandlers,
      textMeal: textMealHandler,
      voiceMeal: voiceMealHandler,
    },
    sendMessage: async () => {},
    sendChatAction: async () => {},
    logger,
    pilotUserIds,
    metricsRegistry,
    allowlist,
  };
}
