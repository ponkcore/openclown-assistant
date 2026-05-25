import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleMoodEvent } from "../../../src/modality/mood/logger.js";
import { MoodExtractorConfigLoader } from "../../../src/modality/mood/extractScore.js";
import { PendingMoodState, PENDING_TTL_MS } from "../../../src/modality/mood/pendingState.js";
import type { MetricsRegistry } from "../../../src/observability/metricsEndpoint.js";
import type { OpenClawLogger } from "../../../src/shared/types.js";
import type { TenantStore } from "../../../src/store/types.js";
import type { ModalitySettings } from "../../../src/modality/settings/service.js";
import {
  SUCCESS_REPLY,
  SUCCESS_REPLY_WITH_COMMENT,
  OUT_OF_RANGE_REPLY,
  KEYBOARD_PROMPT,
  INFERRED_PENDING_REPLY,
  PENDING_TIMEOUT_REPLY,
  OFF_STATE_REPLY,
} from "../../../src/modality/mood/copy.ru.js";
import { buildMoodKeyboard, buildMoodConfirmKeyboard, parseScoreCallback } from "../../../src/modality/mood/keyboard.js";
import { PROMETHEUS_METRIC_NAMES, KPI_EVENT_NAMES } from "../../../src/observability/kpiEvents.js";

// Mock callOmniRoute
vi.mock("../../../src/llm/omniRouteClient.js", () => ({
  callOmniRoute: vi.fn(),
}));

import { callOmniRoute } from "../../../src/llm/omniRouteClient.js";
const mockCallOmniRoute = vi.mocked(callOmniRoute);

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMetrics(): MetricsRegistry {
  return {
    increment: vi.fn(),
    set: vi.fn(),
    observe: vi.fn(),
    getSamples: vi.fn().mockReturnValue([]),
    render: vi.fn().mockReturnValue(""),
  };
}

function makeLogger(): OpenClawLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
}

function makeStubStore(): TenantStore {
  return {
    withTransaction: vi.fn(),
    createUser: vi.fn(),
    getUser: vi.fn(),
    updateUserOnboardingStatus: vi.fn(),
    deleteUser: vi.fn(),
    createUserProfile: vi.fn(),
    getLatestUserProfile: vi.fn(),
    createUserTarget: vi.fn(),
    upsertSummarySchedule: vi.fn(),
    listSummarySchedules: vi.fn(),
    upsertOnboardingState: vi.fn(),
    updateOnboardingStateWithVersion: vi.fn(),
    createTranscript: vi.fn(),
    createMealDraft: vi.fn(),
    updateMealDraftWithVersion: vi.fn(),
    createMealDraftItem: vi.fn(),
    deleteMealDraftItemsByDraftId: vi.fn(),
    createConfirmedMeal: vi.fn(),
    listConfirmedMeals: vi.fn(),
    softDeleteConfirmedMealWithVersion: vi.fn(),
    createMealItem: vi.fn(),
    createSummaryRecord: vi.fn(),
    createAuditEvent: vi.fn(),
    createMetricEvent: vi.fn(),
    createCostEvent: vi.fn(),
    upsertMonthlySpendCounter: vi.fn(),
    getMonthlySpendCounter: vi.fn(),
    incrementMonthlySpend: vi.fn(),
    upsertFoodLookupCache: vi.fn(),
    createKbjuAccuracyLabel: vi.fn(),
    getModalitySettings: vi.fn(),
    setModalitySetting: vi.fn(),
    insertWaterEvent: vi.fn().mockResolvedValue({ event_id: "e-001" }),
    insertMoodEvent: vi.fn().mockResolvedValue({ event_id: "me-001" }),
  } as unknown as TenantStore;
}

function makeSpendTracker() {
  return {
    preflightCheck: async () => ({ allowed: true, projectedSpendUsd: 0, estimatedCallCostUsd: 0 }),
    recordCostAndCheckBudget: async () => {},
    getState: async () => ({
      estimatedSpendUsd: 0,
      degradeModeEnabled: false,
      poAlertSentAt: null,
      monthUtc: new Date().toISOString().slice(0, 7),
    }),
  };
}

const EXTRACTOR_CONFIG = {
  systemPromptTemplate: "Extract mood score from message. Schema: {{JSON_SCHEMA}}. Respond with ONLY JSON.",
  outputJsonSchema: '{"score":"integer","confidence":"number","inferred_comment":"string?"}',
  confidenceThreshold: 0.6,
  defaultModel: { modelAlias: "accounts/fireworks/models/executor", providerHint: "fireworks" },
  fallbackModel: { modelAlias: "accounts/fireworks/models/reviewer", providerHint: "fireworks" },
  emergencyModel: { modelAlias: "openrouter/nvidia/nemotron-3-super:free", providerHint: "openrouter" },
};

function makeConfigLoader(): { loader: MoodExtractorConfigLoader; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mood-logger-test-"));
  const filePath = path.join(tmpDir, "mood-extractor.json");
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(EXTRACTOR_CONFIG), "utf-8");
  fs.renameSync(tmpPath, filePath);
  const logger = makeLogger();
  const loader = new MoodExtractorConfigLoader(filePath, logger);
  return { loader, cleanup: () => { loader.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } };
}

function successLLMResponse(score: number, confidence: number, inferredComment?: string) {
  const output: Record<string, unknown> = { score, confidence };
  if (inferredComment !== undefined) {
    output.inferred_comment = inferredComment;
  }
  return {
    providerAlias: "fireworks" as const,
    modelAlias: "accounts/fireworks/models/executor",
    rawResponseText: JSON.stringify(output),
    inputUnits: 10,
    outputUnits: 5,
    estimatedCostUsd: 0.0001,
    outcome: "success" as const,
  };
}

function failureLLMResponse() {
  return {
    providerAlias: "fireworks" as const,
    modelAlias: "accounts/fireworks/models/executor",
    rawResponseText: "",
    inputUnits: 0,
    outputUnits: 0,
    estimatedCostUsd: 0,
    outcome: "provider_failure" as const,
  };
}

function makeDeps(overrides?: Record<string, unknown>) {
  const store = makeStubStore();
  const { loader, cleanup } = makeConfigLoader();
  const metrics = makeMetrics();
  const logger = makeLogger();
  const pendingState = new PendingMoodState();
  const settingsService = {
    getSettings: vi.fn().mockResolvedValue({ moodOn: true, waterOn: true, sleepOn: true, workoutOn: true } as ModalitySettings),
  };

  return {
    store,
    settingsService,
    configLoader: loader,
    pendingState,
    metrics,
    logger,
    cleanup,
    clock: undefined as (() => number) | undefined,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("handleMoodEvent", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  afterEach(() => {
    deps.cleanup();
    vi.restoreAllMocks();
  });

  // ── Keyboard tap ────────────────────────────────────────────────────

  it("persists keyboard tap with correct score", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "keyboard", score: 7, callbackData: "mood_score_7", requestId: "req-001" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.score).toBe(7);
    expect(result.text).toContain("7/10");
    expect(deps.store.insertMoodEvent).toHaveBeenCalledWith(
      "user-001",
      "keyboard",
      7,
      null, // no comment
      false, // not inferred
      null, // no raw text
    );
  });

  it("rejects out-of-range score from keyboard", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "keyboard", score: 0, callbackData: "mood_score_0", requestId: "req-002" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(OUT_OF_RANGE_REPLY);
  });

  it("rejects score > 10 from keyboard", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "keyboard", score: 11, requestId: "req-003" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(OUT_OF_RANGE_REPLY);
  });

  // ── Explicit text score ─────────────────────────────────────────────

  it("persists explicit text score 'настроение 7'", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "настроение 7", requestId: "req-004" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.score).toBe(7);
    expect(result.source).toBe("text");
    expect(deps.store.insertMoodEvent).toHaveBeenCalledWith(
      "user-001",
      "text",
      7,
      null,
      false,
      null,
    );
  });

  it("persists bare number '7'", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "7", requestId: "req-005" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.score).toBe(7);
  });

  it("persists explicit score with comment", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "настроение 7 — устал но в целом норм", requestId: "req-006" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.score).toBe(7);
    expect(result.source).toBe("text");
    expect(result.text).toContain("с комментарием");
    expect(deps.store.insertMoodEvent).toHaveBeenCalledWith(
      "user-001",
      "text",
      7,
      "устал но в целом норм",
      false,
      null,
    );
  });

  // ── Free-form text inference ────────────────────────────────────────

  it("enters PENDING-CONFIRM for free-form text with LLM inference", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(successLLMResponse(6, 0.8, "устал"));

    const result = await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "сегодня устал, всё бесит", requestId: "req-007" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toContain("6");
    expect(result.keyboard).toBeDefined();
    // Should NOT have called insertMoodEvent yet
    expect(deps.store.insertMoodEvent).not.toHaveBeenCalled();
  });

  it("shows KEYBOARD_PROMPT when LLM returns low confidence", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(successLLMResponse(5, 0.3));

    const result = await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "какой-то текст", requestId: "req-008" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(KEYBOARD_PROMPT);
  });

  // ── Confirm-via-keyboard persists ──────────────────────────────────

  it("persists on confirm-via-keyboard", async () => {
    // First: enter pending state
    mockCallOmniRoute.mockResolvedValueOnce(successLLMResponse(6, 0.8, "устал"));
    await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "сегодня устал", requestId: "req-009a" },
      deps,
    );

    // Second: confirm via keyboard
    const result = await handleMoodEvent(
      { userId: "user-001", source: "keyboard", callbackData: "mood_confirm_6", requestId: "req-009b" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.score).toBe(6);
    expect(result.source).toBe("inferred");
    expect(deps.store.insertMoodEvent).toHaveBeenCalledWith(
      "user-001",
      "inferred",
      6,
      "устал",
      true,
      null,
    );
  });

  it("persists with user-chosen score when overriding inferred via keyboard", async () => {
    // Enter pending state with inferred score 6
    mockCallOmniRoute.mockResolvedValueOnce(successLLMResponse(6, 0.8));
    await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "сегодня устал", requestId: "req-010a" },
      deps,
    );

    // User picks 4 instead
    const result = await handleMoodEvent(
      { userId: "user-001", source: "keyboard", score: 4, callbackData: "mood_score_4", requestId: "req-010b" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.score).toBe(4);
    expect(result.source).toBe("keyboard");
  });

  // ── Comment truncation ─────────────────────────────────────────────

  it("silently truncates comment >200 chars", async () => {
    const longComment = "а".repeat(250);
    const result = await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: `настроение 7 — ${longComment}`, requestId: "req-011" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.score).toBe(7);
    // Should NOT mention truncation in reply
    expect(result.text).not.toContain("сократил");
    expect(result.text).not.toContain("обрезал");

    // Verify the comment was truncated
    const insertCall = deps.store.insertMoodEvent as ReturnType<typeof vi.fn>;
    const commentArg = insertCall.mock.calls[0][3]; // 4th arg is commentText
    expect(commentArg).toHaveLength(200);
  });

  // ── OFF-state ──────────────────────────────────────────────────────

  it("skips persist when mood modality is OFF", async () => {
    deps.settingsService.getSettings.mockResolvedValue({ moodOn: false, waterOn: true, sleepOn: true, workoutOn: true });

    const result = await handleMoodEvent(
      { userId: "user-001", source: "keyboard", score: 7, requestId: "req-012" },
      deps,
    );

    expect(result.persisted).toBe(false);
    expect(result.text).toBe(OFF_STATE_REPLY);
    expect(deps.store.insertMoodEvent).not.toHaveBeenCalled();
  });

  // ── PENDING TTL expires ────────────────────────────────────────────

  it("pending inference expires after 5 minutes", async () => {
    let currentTime = 0;
    const clock = () => currentTime;

    const pendingState = new PendingMoodState(clock, PENDING_TTL_MS);

    deps.pendingState = pendingState;
    deps.clock = clock;

    // Enter pending state
    mockCallOmniRoute.mockResolvedValueOnce(successLLMResponse(6, 0.8));
    await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "сегодня устал", requestId: "req-013a" },
      deps,
    );

    // Advance time past TTL
    currentTime = PENDING_TTL_MS + 1;

    // Try to confirm — should be expired
    const result = await handleMoodEvent(
      { userId: "user-001", source: "keyboard", callbackData: "mood_confirm_6", requestId: "req-013b" },
      deps,
    );

    // No pending inference found → treated as a keyboard tap without score
    // (callbackData doesn't match a direct score pattern with pending state gone)
    expect(result.persisted).toBe(false);
  });

  it("TTL: alive at 4:59, dead at 5:00:01", async () => {
    let currentTime = 0;
    const clock = () => currentTime;

    const pendingState = new PendingMoodState(clock, PENDING_TTL_MS);
    deps.pendingState = pendingState;
    deps.clock = clock;

    // Enter pending state at t=0
    mockCallOmniRoute.mockResolvedValueOnce(successLLMResponse(6, 0.8));
    await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "сегодня устал", requestId: "req-013c" },
      deps,
    );

    // At 4 min 59 s: entry should still be valid
    currentTime = PENDING_TTL_MS - 1;
    expect(pendingState.get("user-001")).not.toBeNull();

    // At 5 min 0 s + 1 ms: entry should be expired
    currentTime = PENDING_TTL_MS + 1;
    expect(pendingState.get("user-001")).toBeNull();
  });

  it("notifies user on pending timeout when sending new text", async () => {
    let currentTime = 0;
    const clock = () => currentTime;

    const pendingState = new PendingMoodState(clock, PENDING_TTL_MS);
    deps.pendingState = pendingState;
    deps.clock = clock;

    // Enter pending state
    mockCallOmniRoute.mockResolvedValueOnce(successLLMResponse(6, 0.8));
    await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "сегодня устал", requestId: "req-014a" },
      deps,
    );

    // Advance time past TTL
    currentTime = PENDING_TTL_MS + 1;

    // User sends new text input
    const result = await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "настроение 8", requestId: "req-014b" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.score).toBe(8);
    // Should mention timeout in reply
    expect(result.pendingExpired).toBe(true);
    expect(result.text).toContain(PENDING_TIMEOUT_REPLY);
  });

  // ── Telemetry ──────────────────────────────────────────────────────

  it("emits kbju_modality_event_persisted with mood labels on keyboard insert", async () => {
    await handleMoodEvent(
      { userId: "user-001", source: "keyboard", score: 7, callbackData: "mood_score_7", requestId: "req-015" },
      deps,
    );

    expect(deps.metrics.increment).toHaveBeenCalledWith(
      PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
      { modality: "mood", source: "keyboard" },
    );
  });

  it("emits kbju_modality_event_persisted with mood labels on text insert", async () => {
    await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "настроение 5", requestId: "req-016" },
      deps,
    );

    expect(deps.metrics.increment).toHaveBeenCalledWith(
      PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
      { modality: "mood", source: "text" },
    );
  });

  it("emits kbju_modality_event_persisted with mood inferred labels on confirm", async () => {
    // Enter pending state
    mockCallOmniRoute.mockResolvedValueOnce(successLLMResponse(6, 0.8));
    await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "сегодня устал", requestId: "req-017a" },
      deps,
    );

    // Confirm
    await handleMoodEvent(
      { userId: "user-001", source: "keyboard", callbackData: "mood_confirm_6", requestId: "req-017b" },
      deps,
    );

    expect(deps.metrics.increment).toHaveBeenCalledWith(
      PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
      { modality: "mood", source: "inferred" },
    );
  });

  // ── Audit telemetry shape ──────────────────────────────────────────

  it("structured log event has correct shape on persist", async () => {
    await handleMoodEvent(
      { userId: "user-001", source: "keyboard", score: 7, callbackData: "mood_score_7", requestId: "req-018" },
      deps,
    );

    // Check that emitLog was called (via buildRedactedEvent)
    // We can't inspect the internal event object directly, but
    // we verify the logger was called at least once for the success path
    expect(deps.logger.info).toHaveBeenCalled();

    // Verify that the metrics counter was incremented with correct labels
    const metricCalls = (deps.metrics.increment as ReturnType<typeof vi.fn>).mock.calls;
    const persistCall = metricCalls.find(
      (c: unknown[]) => c[0] === PROMETHEUS_METRIC_NAMES.kbju_modality_event_persisted,
    );
    expect(persistCall).toBeDefined();
    expect(persistCall![1]).toEqual({ modality: "mood", source: "keyboard" });
  });

  // ── raw_text NOT in logs/metrics ───────────────────────────────────

  it("raw_text is not in any emitted metric label", async () => {
    await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "настроение 7", requestId: "req-019" },
      deps,
    );

    const metricCalls = (deps.metrics.increment as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of metricCalls) {
      const labels = call[1] as Record<string, unknown>;
      expect(labels).not.toHaveProperty("raw_text");
      expect(labels).not.toHaveProperty("comment_text");
      expect(labels).not.toHaveProperty("mood_comment_text");
    }
  });

  // ── Score 1 and 10 boundary ────────────────────────────────────────

  it("persists score=1 (lower bound)", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "keyboard", score: 1, callbackData: "mood_score_1", requestId: "req-020" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.score).toBe(1);
  });

  it("persists score=10 (upper bound)", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "keyboard", score: 10, callbackData: "mood_score_10", requestId: "req-021" },
      deps,
    );

    expect(result.persisted).toBe(true);
    expect(result.score).toBe(10);
  });

  // ── Reply text content ──────────────────────────────────────────────

  it("success reply contains score in X/10 format", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "настроение 7", requestId: "req-022" },
      deps,
    );

    expect(result.text).toBe("Записала настроение 7/10.");
  });

  it("success reply with comment uses correct template", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "настроение 7 — хорошо", requestId: "req-023" },
      deps,
    );

    expect(result.text).toBe("Записала настроение 7/10 с комментарием.");
  });

  it("no emoji in reply text", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "настроение 7", requestId: "req-024" },
      deps,
    );

    // Check for common emoji patterns — there should be none
    const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
    expect(result.text).not.toMatch(emojiPattern);
  });

  // ── Keyboard builder ───────────────────────────────────────────────

  it("provides keyboard with 10 buttons on out-of-range", async () => {
    const result = await handleMoodEvent(
      { userId: "user-001", source: "keyboard", score: 0, callbackData: "mood_score_0", requestId: "req-025" },
      deps,
    );

    expect(result.keyboard).toBeDefined();
    const kb = result.keyboard as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    const totalButtons = kb.inline_keyboard.flat().length;
    expect(totalButtons).toBe(10); // 1-10 buttons
  });

  it("provides confirm keyboard for pending inference", async () => {
    mockCallOmniRoute.mockResolvedValueOnce(successLLMResponse(6, 0.8));

    const result = await handleMoodEvent(
      { userId: "user-001", source: "text", rawText: "сегодня устал", requestId: "req-026" },
      deps,
    );

    expect(result.keyboard).toBeDefined();
    const kb = result.keyboard as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    // Should have confirm button + 9 other score buttons
    const totalButtons = kb.inline_keyboard.flat().length;
    expect(totalButtons).toBe(10); // 1 "верно" + 9 score buttons (1-10 minus 6)
  });
});

// ── Keyboard helper tests ─────────────────────────────────────────────────

describe("parseScoreCallback", () => {
  it("parses direct score callback", () => {
    expect(parseScoreCallback("mood_score_7")).toEqual({ score: 7, type: "direct" });
  });

  it("parses confirm callback", () => {
    expect(parseScoreCallback("mood_confirm_6")).toEqual({ score: 6, type: "confirm" });
  });

  it("returns null for invalid callback", () => {
    expect(parseScoreCallback("invalid")).toBeNull();
  });

  it("returns null for out-of-range score in callback", () => {
    expect(parseScoreCallback("mood_score_0")).toBeNull();
    expect(parseScoreCallback("mood_score_11")).toBeNull();
  });
});

// ── PendingMoodState tests ─────────────────────────────────────────────────

describe("PendingMoodState", () => {
  it("evicts expired entries lazily on get()", () => {
    let currentTime = 0;
    const clock = () => currentTime;
    const state = new PendingMoodState(clock, PENDING_TTL_MS);

    state.set("user-001", 6, "устал");
    expect(state.get("user-001")).not.toBeNull();

    currentTime = PENDING_TTL_MS + 1;
    expect(state.get("user-001")).toBeNull(); // lazy eviction

    // After eviction, getIncludingExpired also returns null
    expect(state.getIncludingExpired("user-001")).toBeNull();
  });

  it("has() returns false after eviction", () => {
    let currentTime = 0;
    const clock = () => currentTime;
    const state = new PendingMoodState(clock, PENDING_TTL_MS);

    state.set("user-001", 5, null);
    expect(state.has("user-001")).toBe(true);

    currentTime = PENDING_TTL_MS + 1;
    expect(state.has("user-001")).toBe(false);
  });

  it("getIncludingExpired returns entry with isExpired flag", () => {
    let currentTime = 0;
    const clock = () => currentTime;
    const state = new PendingMoodState(clock, PENDING_TTL_MS);

    state.set("user-001", 7, "норм");

    // Not expired yet
    const fresh = state.getIncludingExpired("user-001");
    expect(fresh).not.toBeNull();
    expect(fresh!.isExpired).toBe(false);
    expect(fresh!.entry.inferredScore).toBe(7);

    // Expired
    currentTime = PENDING_TTL_MS + 1;
    const expired = state.getIncludingExpired("user-001");
    expect(expired).not.toBeNull();
    expect(expired!.isExpired).toBe(true);
    expect(expired!.entry.inferredScore).toBe(7);
  });

  it("remove() clears the entry", () => {
    const state = new PendingMoodState();
    state.set("user-001", 5, null);
    state.remove("user-001");
    expect(state.get("user-001")).toBeNull();
    expect(state.getIncludingExpired("user-001")).toBeNull();
  });
});
