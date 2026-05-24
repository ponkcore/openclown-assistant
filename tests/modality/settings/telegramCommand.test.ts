import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSettingsCommandHandler,
  CALLBACK_PREFIX,
  type SettingsCommandHandler,
} from "../../../src/modality/settings/telegramCommand.js";
import type {
  ModalitySettingsService,
  ModalitySettings,
  ModalityName,
} from "../../../src/modality/settings/service.js";
import {
  SETTINGS_HEADER,
  MODALITY_BUTTON_LABELS,
  TOGGLE_CONFIRMATION,
} from "../../../src/modality/settings/copy.ru.js";
import type { NormalizedTelegramUpdate } from "../../../src/telegram/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const CHAT_ID = 111;
const TG_USER_ID = 111;

function makeUpdate(overrides: Partial<NormalizedTelegramUpdate> = {}): NormalizedTelegramUpdate {
  return {
    requestId: "req-test",
    telegramUserId: TG_USER_ID,
    telegramChatId: CHAT_ID,
    routeKind: "callback",
    sourceLabel: "test",
    ...overrides,
  };
}

/** Create a mock ModalitySettingsService with controllable settings. */
function createMockService(initialSettings: ModalitySettings = { waterOn: true, sleepOn: true, workoutOn: true, moodOn: true }) {
  let currentSettings: ModalitySettings = { ...initialSettings };
  const setSettingCalls: Array<{ userId: string; modality: ModalityName; value: boolean }> = [];

  const service: ModalitySettingsService = {
    getSettings: vi.fn(async (userId: string) => {
      void userId;
      return { ...currentSettings };
    }),
    setSetting: vi.fn(async (userId: string, modality: ModalityName, value: boolean) => {
      void userId;
      setSettingCalls.push({ userId, modality, value });
      const keyMap: Record<ModalityName, keyof ModalitySettings> = {
        water: "waterOn",
        sleep: "sleepOn",
        workout: "workoutOn",
        mood: "moodOn",
      };
      currentSettings = { ...currentSettings, [keyMap[modality]]: value };
      return { ...currentSettings };
    }),
    cache: new Map(),
  };

  return { service, getSetSettingCalls: () => setSettingCalls };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("SettingsCommandHandler", () => {
  let handler: SettingsCommandHandler;
  let mockService: ModalitySettingsService;

  beforeEach(() => {
    const mock = createMockService();
    mockService = mock.service;
    handler = createSettingsCommandHandler(mockService);
  });

  // ── /settings command ─────────────────────────────────────────────────

  describe("handleSettingsCommand", () => {
    it("returns SETTINGS_HEADER as reply text", async () => {
      const update = makeUpdate();
      const envelope = await handler.handleSettingsCommand(update);

      expect(envelope.text).toBe(SETTINGS_HEADER);
    });

    it("returns an inline keyboard with exactly 4 buttons (one per modality, KBJU excluded)", async () => {
      const update = makeUpdate();
      const envelope = await handler.handleSettingsCommand(update);

      expect(envelope.replyMarkup).toBeDefined();
      const keyboard = envelope.replyMarkup!.inlineKeyboard;
      // Exactly 4 rows (one button per row)
      expect(keyboard).toHaveLength(4);
      // Each row has exactly 1 button
      for (const row of keyboard) {
        expect(row).toHaveLength(1);
      }
    });

    it("labels buttons with correct Russian text (all ON by default)", async () => {
      const update = makeUpdate();
      const envelope = await handler.handleSettingsCommand(update);
      const keyboard = envelope.replyMarkup!.inlineKeyboard;

      const expectedLabels = [
        MODALITY_BUTTON_LABELS.water.on,
        MODALITY_BUTTON_LABELS.sleep.on,
        MODALITY_BUTTON_LABELS.workout.on,
        MODALITY_BUTTON_LABELS.mood.on,
      ];

      const actualLabels = keyboard.map((row) => row[0].text);
      expect(actualLabels).toEqual(expectedLabels);
    });

    it("uses correct callback data format for each button", async () => {
      const update = makeUpdate();
      const envelope = await handler.handleSettingsCommand(update);
      const keyboard = envelope.replyMarkup!.inlineKeyboard;

      const expectedCallbackData = [
        `${CALLBACK_PREFIX}water`,
        `${CALLBACK_PREFIX}sleep`,
        `${CALLBACK_PREFIX}workout`,
        `${CALLBACK_PREFIX}mood`,
      ];

      const actualCallbackData = keyboard.map((row) => row[0].callbackData);
      expect(actualCallbackData).toEqual(expectedCallbackData);
    });

    it("shows OFF label when modality is OFF", async () => {
      const { service } = createMockService({
        waterOn: false,
        sleepOn: true,
        workoutOn: true,
        moodOn: true,
      });
      const localHandler = createSettingsCommandHandler(service);

      const update = makeUpdate();
      const envelope = await localHandler.handleSettingsCommand(update);
      const keyboard = envelope.replyMarkup!.inlineKeyboard;

      // Water should show OFF label, others ON
      expect(keyboard[0][0].text).toBe(MODALITY_BUTTON_LABELS.water.off);
      expect(keyboard[1][0].text).toBe(MODALITY_BUTTON_LABELS.sleep.on);
    });

    it("does NOT show KBJU in keyboard (per PRD-003@0.1.3 §3 NG6)", async () => {
      const update = makeUpdate();
      const envelope = await handler.handleSettingsCommand(update);
      const keyboard = envelope.replyMarkup!.inlineKeyboard;

      // Verify no button mentions KBJU
      const allTexts = keyboard.flat().map((b) => b.text);
      const allCallbackData = keyboard.flat().map((b) => b.callbackData ?? "");
      for (const text of allTexts) {
        expect(text.toLowerCase()).not.toContain("kbju");
        expect(text.toLowerCase()).not.toContain("кбжу");
      }
      for (const cd of allCallbackData) {
        expect(cd).not.toContain("kbju");
      }
    });
  });

  // ── Settings callback ─────────────────────────────────────────────────

  describe("handleSettingsCallback", () => {
    it("returns null for non-settings callback data", async () => {
      const update = makeUpdate({ callbackData: "confirm_meal" });
      const result = await handler.handleSettingsCallback(update);
      expect(result).toBeNull();
    });

    it("toggles water ON → OFF on callback", async () => {
      const update = makeUpdate({ callbackData: `${CALLBACK_PREFIX}water` });
      const result = await handler.handleSettingsCallback(update);

      expect(result).not.toBeNull();
      expect(mockService.setSetting).toHaveBeenCalledWith(
        String(TG_USER_ID),
        "water",
        false, // was ON, toggles to OFF
      );
    });

    it("returns confirmation text for toggling OFF", async () => {
      const update = makeUpdate({ callbackData: `${CALLBACK_PREFIX}water` });
      const envelope = await handler.handleSettingsCallback(update);

      expect(envelope!.text).toBe(TOGGLE_CONFIRMATION.water.off);
    });

    it("returns confirmation text for toggling ON", async () => {
      // Pre-set water to OFF
      const { service } = createMockService({
        waterOn: false,
        sleepOn: true,
        workoutOn: true,
        moodOn: true,
      });
      const localHandler = createSettingsCommandHandler(service);

      const update = makeUpdate({ callbackData: `${CALLBACK_PREFIX}water` });
      const envelope = await localHandler.handleSettingsCallback(update);

      expect(envelope!.text).toBe(TOGGLE_CONFIRMATION.water.on);
    });

    it("refreshes keyboard with updated state after toggle", async () => {
      const update = makeUpdate({ callbackData: `${CALLBACK_PREFIX}water` });
      const envelope = await handler.handleSettingsCallback(update);

      const keyboard = envelope!.replyMarkup!.inlineKeyboard;
      // After toggling water OFF, its button should show OFF label
      expect(keyboard[0][0].text).toBe(MODALITY_BUTTON_LABELS.water.off);
      // Other modalities unchanged
      expect(keyboard[1][0].text).toBe(MODALITY_BUTTON_LABELS.sleep.on);
    });

    it("returns null for unknown modality in callback data", async () => {
      const update = makeUpdate({ callbackData: `${CALLBACK_PREFIX}unknown_mod` });
      const result = await handler.handleSettingsCallback(update);
      expect(result).toBeNull();
    });
  });

  // ── Russian copy assertions ───────────────────────────────────────────

  describe("Russian copy", () => {
    it("SETTINGS_HEADER is Russian", () => {
      expect(SETTINGS_HEADER).toBe("Что записывать?");
    });

    it("TOGGLE_CONFIRMATION has entries for all four modalities", () => {
      const modalities = ["water", "sleep", "workout", "mood"];
      for (const m of modalities) {
        expect(TOGGLE_CONFIRMATION[m]).toBeDefined();
        expect(TOGGLE_CONFIRMATION[m].on).toBeTruthy();
        expect(TOGGLE_CONFIRMATION[m].off).toBeTruthy();
      }
    });

    it("MODALITY_BUTTON_LABELS has ON/OFF variants for all four modalities", () => {
      const modalities = ["water", "sleep", "workout", "mood"];
      for (const m of modalities) {
        expect(MODALITY_BUTTON_LABELS[m]).toBeDefined();
        expect(MODALITY_BUTTON_LABELS[m].on).toBeTruthy();
        expect(MODALITY_BUTTON_LABELS[m].off).toBeTruthy();
      }
    });
  });
});
