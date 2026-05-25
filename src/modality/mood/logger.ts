/**
 * C20 Mood Logger — persist mood events per ARCH-001@0.6.2 §3.20
 * and PRD-003@0.1.3 §5 US-4.
 *
 * Entry point: handleMoodEvent(input) → MoodReply
 *
 * Flow:
 * 1. Check settings: if mood_on === false → return OFF-state reply.
 * 2. For source=keyboard with score: validate range, persist directly.
 * 3. For source=text with rawText:
 *    a. If text contains explicit numeric score → extract, persist with source='text'.
 *    b. If no explicit numeric → call LLM mood extractor, enter PENDING-CONFIRM
 *       if confidence ≥ 0.6, otherwise reject.
 * 4. For PENDING-CONFIRM:
 *    a. If user confirms via keyboard → persist with source='inferred'.
 *    b. If user picks a different score via keyboard → persist with that score.
 *    c. If TTL expires → discard silently, notify user.
 * 5. Emit kbju_modality_event_persisted telemetry with {modality, source} labels.
 * 6. Return Russian confirmation reply.
 */

import type { TenantStore, MoodEventSource } from "../../store/types.js";
import type { MetricsRegistry } from "../../observability/metricsEndpoint.js";
import type { OpenClawLogger, ComponentId } from "../../shared/types.js";
import { PROMETHEUS_METRIC_NAMES, KPI_EVENT_NAMES } from "../../observability/kpiEvents.js";
import { buildRedactedEvent, emitLog } from "../../observability/events.js";
import type { ModalitySettings } from "../settings/service.js";
import {
  extractMoodFromText,
  MoodExtractorConfigLoader,
} from "./extractScore.js";
import {
  SUCCESS_REPLY,
  COMMENT_TRUNCATED_REPLY,
  SUCCESS_REPLY_WITH_COMMENT,
  OUT_OF_RANGE_REPLY,
  KEYBOARD_PROMPT,
  INFERRED_PENDING_REPLY,
  PENDING_TIMEOUT_REPLY,
  OFF_STATE_REPLY,
} from "./copy.ru.js";
import { buildMoodKeyboard, buildMoodConfirmKeyboard, parseScoreCallback } from "./keyboard.js";
import { PendingMoodState, type Clock } from "./pendingState.js";

// ── Public types ──────────────────────────────────────────────────────────

/** Input to the mood handler. */
export interface MoodEventInput {
  userId: string;
  /** source: keyboard for inline-keyboard tap; text for typed/voice-transcribed text */
  source: "keyboard" | "text";
  /** For source=keyboard: the score from the button tap or confirm action */
  score?: number;
  /** For source=text: the raw text from the user */
  rawText?: string;
  /** For source=keyboard: the callback_data string (to distinguish confirm vs direct) */
  callbackData?: string;
  requestId: string;
}

/** Result of handling a mood event. */
export interface MoodReply {
  text: string;
  keyboard?: unknown;
  persisted: boolean;
  score?: number;
  /** The effective source label persisted (for telemetry assertions) */
  source?: MoodEventSource;
  /** Whether this was a pending-confirmation that expired */
  pendingExpired?: boolean;
}

// ── Sanity bounds ─────────────────────────────────────────────────────────

const SCORE_MIN = 1;
const SCORE_MAX = 10;
const COMMENT_MAX_LENGTH = 280;
const CONFIDENCE_THRESHOLD = 0.6;

// C20 component ID for observability — not yet in ComponentId union;
// cast to satisfy buildRedactedEvent.
const C20 = "C20" as ComponentId;

// ── Explicit numeric-score regex ──────────────────────────────────────────

/**
 * Patterns that indicate an explicit numeric mood score in the text.
 * Matches Russian forms like "настроение 7", "7", "оценка 5",
 * and also English forms like "mood 8", "7/10".
 */
const EXPLICIT_SCORE_RE = /(?:настроение|оценка|mood|energy|энергия)\s*[:=]?\s*(\d{1,2})(?:\s*[/\\]\s*10)?/i;
const BARE_NUMBER_RE = /^(\d{1,2})(?:\s*[/\\]\s*10)?$/;

/**
 * Try to extract an explicit numeric score from the text.
 * Returns the score (1-10) if found, or null.
 * Also returns the remaining text (comment portion) after the score pattern.
 */
function extractExplicitScore(text: string): { score: number; commentText: string | null } | null {
  // Try keyword+number first
  const match = text.match(EXPLICIT_SCORE_RE);
  if (match) {
    const score = parseInt(match[1], 10);
    if (score >= SCORE_MIN && score <= SCORE_MAX) {
      const afterMatch = text.slice(match.index! + match[0].length).trim();
      const commentText = afterMatch.length > 0
        ? afterMatch.replace(/^[\s,;.\-—–]+/, "").trim() || null
        : null;
      return { score, commentText };
    }
  }

  // Try bare number (entire message is just "7" or "7/10")
  const bareMatch = text.trim().match(BARE_NUMBER_RE);
  if (bareMatch) {
    const score = parseInt(bareMatch[1], 10);
    if (score >= SCORE_MIN && score <= SCORE_MAX) {
      return { score, commentText: null };
    }
  }

  return null;
}

/** Truncate comment text to COMMENT_MAX_LENGTH (280 chars). Returns truncated text and whether overflow occurred. Uses Array.from for astral-plane safety. */
function truncateComment(text: string | null): { text: string | null; wasTruncated: boolean } {
  if (!text) return { text: null, wasTruncated: false };
  const chars = Array.from(text);
  if (chars.length <= COMMENT_MAX_LENGTH) return { text, wasTruncated: false };
  return { text: chars.slice(0, COMMENT_MAX_LENGTH).join(""), wasTruncated: true };
}

// ── Handler ───────────────────────────────────────────────────────────────

/**
 * Handle a mood event: extract/validate score, persist, reply.
 *
 * Dependencies are injected for testability.
 */
export async function handleMoodEvent(
  input: MoodEventInput,
  deps: {
    store: TenantStore;
    settingsService: { getSettings(userId: string): Promise<ModalitySettings | null> };
    configLoader: MoodExtractorConfigLoader;
    pendingState: PendingMoodState;
    metrics: MetricsRegistry;
    logger: OpenClawLogger;
    clock?: Clock;
    spendTracker?: import("../../observability/costGuard.js").SpendTracker;
    degradeModeEnabled?: boolean;
  },
): Promise<MoodReply> {
  const { userId, source, rawText, callbackData, requestId } = input;
  const degrade = deps.degradeModeEnabled ?? false;
  const clock = deps.clock ?? (() => Date.now());

  // ── Step 1: Check OFF-state ───────────────────────────────────────────
  const settings = await deps.settingsService.getSettings(userId);
  if (settings && !settings.moodOn) {
    emitLog(deps.logger, buildRedactedEvent(
      "info",
      "kbju-meal-logging",
      C20,
      KPI_EVENT_NAMES.modality_event_persisted,
      requestId,
      userId,
      "skipped_off",
      degrade,
      { modality: "mood", source },
    ));
    return { text: OFF_STATE_REPLY, persisted: false };
  }

  // ── Step 2: Check for pending inference timeout ──────────────────────
  // If the user has a pending inference and this is a new text input,
  // check if it expired. If expired, notify user and process as new input.
  const pendingInfo = deps.pendingState.getIncludingExpired(userId);
  const pending = pendingInfo && !pendingInfo.isExpired ? pendingInfo.entry : null;
  const hadExpiredPending = pendingInfo !== null && pendingInfo.isExpired;
  // Note: we do NOT auto-detect confirmation from raw text —
  // confirmation comes via keyboard callback (source=keyboard, callbackData).

  // ── Step 3: Handle by source ─────────────────────────────────────────

  if (source === "keyboard") {
    // ── 3a: Keyboard tap (direct score or confirm) ───────────────────
    const score = input.score;

    // Check if this is a confirm callback for a pending inference
    if (callbackData && pending) {
      const parsed = parseScoreCallback(callbackData);
      if (parsed && parsed.type === "confirm") {
        // User confirmed the inferred score
        const finalScore = pending.inferredScore;
        if (finalScore < SCORE_MIN || finalScore > SCORE_MAX) {
          deps.pendingState.remove(userId);
          return {
            text: OUT_OF_RANGE_REPLY,
            keyboard: buildMoodKeyboard(),
            persisted: false,
          };
        }

        const truncResult = truncateComment(pending.inferredComment);
        const eventSource: MoodEventSource = "inferred";

        const { event_id } = await deps.store.insertMoodEvent(
          userId,
          eventSource,
          finalScore,
          truncResult.text,
          true, // inferred_from_text
          null, // raw_text not stored for confirmed inferences
        );
        void event_id;

        deps.pendingState.remove(userId);

        // Telemetry
        deps.metrics.increment(
          PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
          { modality: "mood", source: eventSource },
        );

        emitLog(deps.logger, buildRedactedEvent(
          "info",
          "kbju-meal-logging",
          C20,
          KPI_EVENT_NAMES.modality_event_persisted,
          requestId,
          userId,
          "success",
          degrade,
          { modality: "mood", source: eventSource, score: finalScore },
        ));

        let replyText: string;
        if (truncResult.wasTruncated) {
          replyText = COMMENT_TRUNCATED_REPLY.replace("{score}", String(finalScore));
        } else if (truncResult.text) {
          replyText = SUCCESS_REPLY_WITH_COMMENT.replace("{score}", String(finalScore));
        } else {
          replyText = SUCCESS_REPLY.replace("{score}", String(finalScore));
        }

        return {
          text: replyText,
          persisted: true,
          score: finalScore,
          source: eventSource,
        };
      }

      // User picked a different score via direct keyboard button
      if (parsed && parsed.type === "direct" && parsed.score >= SCORE_MIN && parsed.score <= SCORE_MAX) {
        deps.pendingState.remove(userId);
        // Fall through to persist with the user's chosen score
        return persistDirectScore(
          userId,
          parsed.score,
          null, false, // no comment when overriding via keyboard; wasTruncated=false
          "keyboard",
          requestId,
          deps,
          degrade,
        );
      }
    }

    // Direct keyboard tap (no pending state)
    if (score !== undefined) {
      if (score < SCORE_MIN || score > SCORE_MAX) {
        emitLog(deps.logger, buildRedactedEvent(
          "info",
          "kbju-meal-logging",
          C20,
          KPI_EVENT_NAMES.modality_event_persisted,
          requestId,
          userId,
          "out_of_range",
          degrade,
          { modality: "mood", source: "keyboard" },
        ));
        return {
          text: OUT_OF_RANGE_REPLY,
          keyboard: buildMoodKeyboard(),
          persisted: false,
        };
      }

      return persistDirectScore(
        userId,
        score,
        null, false, // no comment for keyboard tap; wasTruncated=false
        "keyboard",
        requestId,
        deps,
        degrade,
      );
    }

    // Keyboard source but no score — shouldn't happen, but handle gracefully
    return {
      text: OUT_OF_RANGE_REPLY,
      keyboard: buildMoodKeyboard(),
      persisted: false,
    };
  }

  // ── 3b: Text input ────────────────────────────────────────────────
  if (source === "text" && rawText) {
    // Clean up any expired pending inference
    if (hadExpiredPending) {
      deps.pendingState.remove(userId);
    }

    // If there is still a valid pending inference, it means the user
    // sent text instead of using the keyboard — treat as new input
    // (the pending inference is implicitly abandoned)
    if (pending) {
      deps.pendingState.remove(userId);
    }


    // Try to extract explicit numeric score from text
    const explicitResult = extractExplicitScore(rawText);
    if (explicitResult) {
      const { score: explicitScore, commentText } = explicitResult;
      if (explicitScore < SCORE_MIN || explicitScore > SCORE_MAX) {
        emitLog(deps.logger, buildRedactedEvent(
          "info",
          "kbju-meal-logging",
          C20,
          KPI_EVENT_NAMES.modality_event_persisted,
          requestId,
          userId,
          "out_of_range",
          degrade,
          { modality: "mood", source: "text" },
        ));
        const reply: MoodReply = {
          text: OUT_OF_RANGE_REPLY,
          keyboard: buildMoodKeyboard(),
          persisted: false,
        };
        if (hadExpiredPending) {
          reply.text = PENDING_TIMEOUT_REPLY + " " + reply.text;
          reply.pendingExpired = true;
        }
        return reply;
      }

      const truncResult = truncateComment(commentText);
      const eventSource: MoodEventSource = "text";
      const reply = await persistDirectScore(
        userId,
        explicitScore,
        truncResult.text, truncResult.wasTruncated,
        eventSource,
        requestId,
        deps,
        degrade,
      );
      if (hadExpiredPending) {
        reply.text = PENDING_TIMEOUT_REPLY + " " + reply.text;
        reply.pendingExpired = true;
      }
      return reply;
    }

    // No explicit score → LLM inference required
    const extractResult = await extractMoodFromText(
      rawText,
      requestId,
      userId,
      deps.configLoader,
      deps.logger,
      deps.metrics,
      deps.spendTracker,
      degrade,
    );

    if (extractResult.modelTier === "failure" || extractResult.confidence < CONFIDENCE_THRESHOLD) {
      // LLM failed or low confidence — ask user to use keyboard
      emitLog(deps.logger, buildRedactedEvent(
        "info",
        "kbju-meal-logging",
        C20,
        KPI_EVENT_NAMES.modality_event_persisted,
        requestId,
        userId,
        extractResult.modelTier === "failure" ? "llm_failure" : "low_confidence",
        degrade,
        { modality: "mood", source: "text", model_tier: extractResult.modelTier },
      ));

      const reply: MoodReply = {
        text: KEYBOARD_PROMPT,
        keyboard: buildMoodKeyboard(),
        persisted: false,
      };
      if (hadExpiredPending) {
        reply.text = PENDING_TIMEOUT_REPLY + " " + reply.text;
        reply.pendingExpired = true;
      }
      return reply;
    }

    // Confidence ≥ threshold — validate score range from LLM
    if (extractResult.score < SCORE_MIN || extractResult.score > SCORE_MAX) {
      emitLog(deps.logger, buildRedactedEvent(
        "info",
        "kbju-meal-logging",
        C20,
        KPI_EVENT_NAMES.modality_event_persisted,
        requestId,
        userId,
        "out_of_range",
        degrade,
        { modality: "mood", source: "inferred" },
      ));
      const reply: MoodReply = {
        text: KEYBOARD_PROMPT,
        keyboard: buildMoodKeyboard(),
        persisted: false,
      };
      if (hadExpiredPending) {
        reply.text = PENDING_TIMEOUT_REPLY + " " + reply.text;
        reply.pendingExpired = true;
      }
      return reply;
    }

    // Enter PENDING-CONFIRM state
    deps.pendingState.set(userId, extractResult.score, extractResult.inferredComment);

    const replyText = INFERRED_PENDING_REPLY.replace("{score}", String(extractResult.score));
    const reply: MoodReply = {
      text: replyText,
      keyboard: buildMoodConfirmKeyboard(extractResult.score),
      persisted: false,
    };
    if (hadExpiredPending) {
      reply.text = PENDING_TIMEOUT_REPLY + " " + replyText;
      reply.pendingExpired = true;
    }
    return reply;
  }

  // No text, no keyboard — shouldn't reach here
  return {
    text: KEYBOARD_PROMPT,
    keyboard: buildMoodKeyboard(),
    persisted: false,
  };
}

// ── Helper: persist a direct (non-inferred) score ────────────────────────

async function persistDirectScore(
  userId: string,
  score: number,
  commentText: string | null,
  wasTruncated: boolean,
  eventSource: MoodEventSource,
  requestId: string,
  deps: {
    store: TenantStore;
    metrics: MetricsRegistry;
    logger: OpenClawLogger;
  },
  degrade: boolean,
): Promise<MoodReply> {
  const inferredFromText = eventSource === "inferred";
  const rawTextForDb: string | null = null; // raw_text not stored for confirmed/keyboard entries

  const { event_id } = await deps.store.insertMoodEvent(
    userId,
    eventSource,
    score,
    commentText,
    inferredFromText,
    rawTextForDb,
  );
  void event_id;

  // Telemetry
  deps.metrics.increment(
    PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
    { modality: "mood", source: eventSource },
  );

  emitLog(deps.logger, buildRedactedEvent(
    "info",
    "kbju-meal-logging",
    C20,
    KPI_EVENT_NAMES.modality_event_persisted,
    requestId,
    userId,
    "success",
    degrade,
    { modality: "mood", source: eventSource, score },
  ));

  let replyText: string;
  if (wasTruncated) {
    replyText = COMMENT_TRUNCATED_REPLY.replace("{score}", String(score));
  } else if (commentText) {
    replyText = SUCCESS_REPLY_WITH_COMMENT.replace("{score}", String(score));
  } else {
    replyText = SUCCESS_REPLY.replace("{score}", String(score));
  }

  return {
    text: replyText,
    persisted: true,
    score,
    source: eventSource,
  };
}
