/**
 * C17 Water Logger — inline keyboard helper for quick-volume presets.
 *
 * Per PRD-003@0.1.3 §5 US-1: at least three presets (small / medium / large).
 * PO did not ratify specific ml values before sign-off; canonical defaults
 * are 250 / 500 / 750 ml (documented in TKT-029 §10 Execution Log).
 */

/** Preset volumes in millilitres. PO may ratify different values later. */
export const WATER_PRESETS = [250, 500, 750] as const;

/** Preset button labels in Russian. */
export const WATER_PRESET_LABELS: Record<number, string> = {
  250: "250 мл 💧",
  500: "500 мл 💧",
  750: "750 мл 💧",
};

/** Callback data format: water_preset_{ml} */
export function presetCallbackData(ml: number): string {
  return `water_preset_${ml}`;
}

/** Parse callback data back into ml. Returns 0 if not a valid preset. */
export function parsePresetCallback(data: string): number {
  const match = data.match(/^water_preset_(\d+)$/);
  if (!match) return 0;
  const ml = parseInt(match[1], 10);
  if (!WATER_PRESETS.includes(ml as (typeof WATER_PRESETS)[number])) return 0;
  return ml;
}

/** Build the inline keyboard for water quick-volume presets. */
export function buildWaterKeyboard(): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: WATER_PRESETS.map((ml) => [
      {
        text: WATER_PRESET_LABELS[ml],
        callback_data: presetCallbackData(ml),
      },
    ]),
  };
}
