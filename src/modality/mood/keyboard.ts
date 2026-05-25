/**
 * C20 Mood Logger — inline keyboard helper for 1-10 score input + confirm button.
 *
 * Per PRD-003@0.1.3 §5 US-4: inline keyboard with 1-10 buttons for direct
 * numeric input, plus a "верно" confirm button for the pending-confirmation
 * flow when the assistant inferred a score from free-form text.
 *
 * Per ARCH-001@0.6.2 §6.2.2:
 *   - 1-10 keyboard prompt: [1] [2] [3] [4] [5] [6] [7] [8] [9] [10]
 *   - Inferred confirmation: [подтвердить N] [1] [2] [3] [4] [5] [7] [8] [9] [10]
 */

/** Score values for the inline keyboard. */
export const MOOD_SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** Callback data format for a direct score tap: mood_score_{n} */
export function scoreCallbackData(score: number): string {
  return `mood_score_${score}`;
}

/** Callback data format for confirming an inferred score: mood_confirm_{n} */
export function confirmCallbackData(score: number): string {
  return `mood_confirm_${score}`;
}

/** Parse callback data back into a score. Returns 0 if not a valid callback. */
export function parseScoreCallback(data: string): { score: number; type: "direct" | "confirm" } | null {
  const confirmMatch = data.match(/^mood_confirm_(\d+)$/);
  if (confirmMatch) {
    const score = parseInt(confirmMatch[1], 10);
    if (score >= 1 && score <= 10) {
      return { score, type: "confirm" };
    }
    return null;
  }
  const directMatch = data.match(/^mood_score_(\d+)$/);
  if (directMatch) {
    const score = parseInt(directMatch[1], 10);
    if (score >= 1 && score <= 10) {
      return { score, type: "direct" };
    }
    return null;
  }
  return null;
}

/** Build the inline keyboard for 1-10 score input (no pending inference). */
export function buildMoodKeyboard(): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  // Two rows of 5 buttons: [1][2][3][4][5] / [6][7][8][9][10]
  const row1 = MOOD_SCORES.slice(0, 5).map((s) => ({
    text: String(s),
    callback_data: scoreCallbackData(s),
  }));
  const row2 = MOOD_SCORES.slice(5).map((s) => ({
    text: String(s),
    callback_data: scoreCallbackData(s),
  }));
  return { inline_keyboard: [row1, row2] };
}

/**
 * Build the inline keyboard for inferred-score confirmation.
 * Includes a "верно" confirm button for the inferred score, plus
 * 1-10 buttons excluding the inferred score (to avoid duplication).
 */
export function buildMoodConfirmKeyboard(inferredScore: number): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  // Row 1: confirm button
  const confirmRow = [
    {
      text: `верно`,
      callback_data: confirmCallbackData(inferredScore),
    },
  ];

  // Row 2-3: 1-10 buttons excluding the inferred score
  const otherScores = MOOD_SCORES.filter((s) => s !== inferredScore);
  const row2 = otherScores.slice(0, 5).map((s) => ({
    text: String(s),
    callback_data: scoreCallbackData(s),
  }));
  const row3 = otherScores.slice(5).map((s) => ({
    text: String(s),
    callback_data: scoreCallbackData(s),
  }));

  return { inline_keyboard: [confirmRow, row2, row3] };
}
