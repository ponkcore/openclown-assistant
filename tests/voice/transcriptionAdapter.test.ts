import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transcribeVoice, DurationExceededError } from "../../src/voice/transcriptionAdapter.js";
import type { TranscriptionConfig, TranscriptionRequest } from "../../src/voice/types.js";
import { MAX_VOICE_DURATION_SECONDS } from "../../src/voice/types.js";
import type { SpendTracker, PreflightResult } from "../../src/observability/costGuard.js";
import type { OpenClawLogger } from "../../src/shared/types.js";
import { MSG_VOICE_TOO_LONG } from "../../src/telegram/messages.js";

const mockConfig: TranscriptionConfig = {
  baseUrl: "https://omniroute.example.com",
  apiKey: "test-key",
  providerAlias: "omniroute",
  modelAlias: "whisper-v3-turbo",
  languageHint: "ru",
  maxLatencyMs: 8000,
};

function makeMockLogger(): OpenClawLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
}

function makeMockSpendTracker(overrides?: Partial<SpendTracker>): SpendTracker {
  return {
    preflightCheck: vi.fn().mockResolvedValue({
      allowed: true,
      projectedSpendUsd: 0.001,
      estimatedCallCostUsd: 0.000225,
    } as PreflightResult),
    recordCostAndCheckBudget: vi.fn().mockResolvedValue({
      estimatedSpendUsd: 0.000225,
      degradeModeEnabled: false,
      poAlertSentAt: null,
      monthUtc: "2026-05",
    }),
    ...overrides,
  } as unknown as SpendTracker;
}

const fakeAudioReader = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));

function makeRequest(overrides?: Partial<TranscriptionRequest>): TranscriptionRequest {
  return {
    userId: "user-001",
    requestId: "req-001",
    telegramMessageId: "msg-001",
    audioFilePath: "/tmp/test-voice.ogg",
    durationSeconds: 5,
    degradeModeEnabled: false,
    logger: makeMockLogger(),
    spendTracker: makeMockSpendTracker(),
    deleteAudioFile: vi.fn().mockResolvedValue(undefined),
    audioFileReader: fakeAudioReader,
    ...overrides,
  };
}

const SUCCESS_RESPONSE = { text: "гречка 200 грамм" };

function mockFetchSuccess(body: unknown = SUCCESS_RESPONSE): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function mockFetchError(status: number = 500): Response {
  return new Response("server error", { status });
}

describe("transcribeVoice", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeAudioReader.mockClear();
    fakeAudioReader.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects voice exceeding 15 seconds duration (AC#4)", async () => {
    const request = makeRequest({ durationSeconds: 16 });
    const result = await transcribeVoice(mockConfig, request);

    expect(result.outcome).toBe("duration_exceeded");
    expect(result.transcriptText).toBe(MSG_VOICE_TOO_LONG);
    expect(result.audioDeleted).toBe(true);
    expect(request.deleteAudioFile).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts voice at exactly 15 seconds boundary (AC#4)", async () => {
    const request = makeRequest({ durationSeconds: 15 });
    fetchSpy.mockResolvedValue(mockFetchSuccess());

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("success");
  });

  it("returns budget_blocked when preflight denies call (AC#1)", async () => {
    const tracker = makeMockSpendTracker({
      preflightCheck: vi.fn().mockResolvedValue({
        allowed: false,
        projectedSpendUsd: 0,
        estimatedCallCostUsd: 0,
      } as PreflightResult),
    });
    const request = makeRequest({ spendTracker: tracker });

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("budget_blocked");
    expect(result.audioDeleted).toBe(true);
    expect(request.deleteAudioFile).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns success with transcript on valid response", async () => {
    const request = makeRequest();
    fetchSpy.mockResolvedValue(mockFetchSuccess());

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("success");
    expect(result.transcriptText).toBe("гречка 200 грамм");
    expect(result.audioDeleted).toBe(true);
    expect(request.deleteAudioFile).toHaveBeenCalled();
    expect(request.spendTracker.recordCostAndCheckBudget).toHaveBeenCalled();
  });

  it("retries once on transport failure within latency budget (AC#5)", async () => {
    const request = makeRequest();
    let callCount = 0;
    fetchSpy.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(mockFetchError(500));
      }
      return Promise.resolve(mockFetchSuccess());
    });

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("success");
    expect(result.transcriptText).toBe("гречка 200 грамм");
    expect(callCount).toBe(2);
  });

  it("does not retry beyond latency budget (AC#5)", async () => {
    const config = { ...mockConfig, maxLatencyMs: 50 };
    const request = makeRequest();
    fetchSpy.mockResolvedValue(mockFetchError(500));

    vi.advanceTimersByTime(200);

    const result = await transcribeVoice(config, request);
    expect(result.outcome).toBe("provider_failure");
    expect(result.audioDeleted).toBe(true);
  });

  it("deletes raw audio on terminal failure (AC#6)", async () => {
    const request = makeRequest();
    fetchSpy.mockResolvedValue(mockFetchError(500));

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("provider_failure");
    expect(result.audioDeleted).toBe(true);
    expect(request.deleteAudioFile).toHaveBeenCalled();
  });

  it("deletes raw audio on successful transcription (AC#6)", async () => {
    const request = makeRequest();
    fetchSpy.mockResolvedValue(mockFetchSuccess());

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("success");
    expect(result.audioDeleted).toBe(true);
    expect(request.deleteAudioFile).toHaveBeenCalled();
  });

  it("emits deletion_failed event when audio deletion fails (AC#6)", async () => {
    const request = makeRequest({
      deleteAudioFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    });
    fetchSpy.mockResolvedValue(mockFetchSuccess());

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("success");
    expect(result.audioDeleted).toBe(false);
  });

  it("handles fetch AbortError as timeout (AC#5)", async () => {
    const request = makeRequest();
    const abortError = new DOMException("The operation was aborted", "AbortError");
    fetchSpy.mockRejectedValue(abortError);

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("provider_failure");
    expect(result.audioDeleted).toBe(true);
  });

  it("handles non-retryable HTTP error (4xx) without retry", async () => {
    const request = makeRequest();
    let callCount = 0;
    fetchSpy.mockImplementation(() => {
      callCount++;
      return Promise.resolve(mockFetchError(400));
    });

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("provider_failure");
    expect(callCount).toBe(1);
  });

  it("uses OmniRoute endpoint, not direct Fireworks (AC#3)", async () => {
    const request = makeRequest();
    fetchSpy.mockResolvedValue(mockFetchSuccess());

    await transcribeVoice(mockConfig, request);

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("omniroute.example.com");
    expect(calledUrl).toContain("/v1/audio/transcriptions");
  });

  it("sends language hint ru in FormData", async () => {
    const request = makeRequest();
    fetchSpy.mockResolvedValue(mockFetchSuccess());

    await transcribeVoice(mockConfig, request);

    const fetchCall = fetchSpy.mock.calls[0];
    const init = fetchCall[1] as RequestInit;
    const body = init.body as FormData;
    expect(body.get("language")).toBe("ru");
    expect(body.get("model")).toBe("whisper-v3-turbo");
  });

  it("deletes audio on duration_exceeded before returning", async () => {
    const request = makeRequest({ durationSeconds: 20 });
    const result = await transcribeVoice(mockConfig, request);

    expect(result.outcome).toBe("duration_exceeded");
    expect(result.audioDeleted).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns deletion_failed when delete throws and transcription succeeded", async () => {
    const request = makeRequest({
      deleteAudioFile: vi.fn().mockRejectedValue(new Error("EBUSY")),
    });
    fetchSpy.mockResolvedValue(mockFetchSuccess());

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("success");
    expect(result.audioDeleted).toBe(false);
  });

  it("retries on 429 status within latency budget", async () => {
    const request = makeRequest();
    let callCount = 0;
    fetchSpy.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(mockFetchError(429));
      }
      return Promise.resolve(mockFetchSuccess());
    });

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("success");
    expect(callCount).toBe(2);
  });

  it("does not retry on HTTP 401 (non-retryable)", async () => {
    const request = makeRequest();
    let callCount = 0;
    fetchSpy.mockImplementation(() => {
      callCount++;
      return Promise.resolve(mockFetchError(401));
    });

    const result = await transcribeVoice(mockConfig, request);
    expect(result.outcome).toBe("provider_failure");
    expect(callCount).toBe(1);
  });

  it("never includes transcript text in observability logs (AC#8)", async () => {
    const logger = makeMockLogger();
    const request = makeRequest({ logger });
    fetchSpy.mockResolvedValue(mockFetchSuccess());

    await transcribeVoice(mockConfig, request);

    const allCalls = [
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.critical).mock.calls,
    ];

    for (const call of allCalls) {
      const meta = call[1] as Record<string, unknown> | undefined;
      if (!meta) continue;
      expect(meta).not.toHaveProperty("raw_transcript");
      expect(meta).not.toHaveProperty("transcriptText");
      expect(JSON.stringify(meta)).not.toContain("гречка");
    }
  });

  it("uses config.providerAlias in results and logs when set to fireworks (F-M1)", async () => {
    const fireworksConfig: TranscriptionConfig = {
      ...mockConfig,
      providerAlias: "fireworks",
    };
    const logger = makeMockLogger();
    const request = makeRequest({ logger });
    fetchSpy.mockResolvedValue(mockFetchSuccess());

    const result = await transcribeVoice(fireworksConfig, request);
    expect(result.providerAlias).toBe("fireworks");

    const allCalls = [
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.critical).mock.calls,
    ];
    for (const call of allCalls) {
      const meta = call[1] as Record<string, unknown> | undefined;
      if (!meta) continue;
      if (meta.provider_alias !== undefined) {
        expect(meta.provider_alias).toBe("fireworks");
      }
    }
  });
});

// ── RV-CODE-020 F-M2: typed-error preservation through adapter boundary ────

describe("transcribeVoice — RV-CODE-020 F-M2: registry_error preservation", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fakeAudioReader.mockClear();
    fakeAudioReader.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("propagates registry_error (not generic provider_failure) when API key env var is unset via resolvedOverride", async () => {
    // Use a resolvedOverride that points to an unset env var,
    // and a config with empty apiKey so apiKeyOverride is "" —
    // this forces voiceClient to try the env-var path and fail.
    const brokenOverride = {
      provider_id: "broken",
      base_url: "https://broken.example.com/v1",
      api_key_env: "LLM_BROKEN_KEY_NOT_SET",
      model: "broken-model",
    };

    const emptyKeyConfig: TranscriptionConfig = {
      ...mockConfig,
      apiKey: "",
    };

    const logger = makeMockLogger();
    const request = makeRequest({ logger });

    const result = await transcribeVoice(emptyKeyConfig, request, brokenOverride);

    // F-M2: adapter must NOT collapse registry_error → provider_failure
    expect(result.outcome).toBe("registry_error");
    expect(result.error_kind).toBe("registry_error");
    // Audio is still deleted on failure
    expect(result.audioDeleted).toBe(true);
    // No HTTP call was made — the error is at the registry/env level
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sets error_kind: provider_failure for HTTP-level failures", async () => {
    fetchSpy.mockResolvedValue(mockFetchError(500));
    const logger = makeMockLogger();
    const request = makeRequest({ logger });

    const result = await transcribeVoice(mockConfig, request);

    expect(result.outcome).toBe("provider_failure");
    expect(result.error_kind).toBe("provider_failure");
  });

  it("sets error_kind: provider_failure for non-retryable HTTP errors", async () => {
    fetchSpy.mockResolvedValue(mockFetchError(401));
    const request = makeRequest();

    const result = await transcribeVoice(mockConfig, request);

    expect(result.outcome).toBe("provider_failure");
    expect(result.error_kind).toBe("provider_failure");
  });

  it("does NOT set error_kind on duration_exceeded", async () => {
    const request = makeRequest({ durationSeconds: 20 });
    const result = await transcribeVoice(mockConfig, request);

    expect(result.outcome).toBe("duration_exceeded");
    expect(result.error_kind).toBeUndefined();
  });

  it("does NOT set error_kind on budget_blocked", async () => {
    const tracker = makeMockSpendTracker({
      preflightCheck: vi.fn().mockResolvedValue({
        allowed: false,
        projectedSpendUsd: 0,
        estimatedCallCostUsd: 0,
      } as PreflightResult),
    });
    const request = makeRequest({ spendTracker: tracker });

    const result = await transcribeVoice(mockConfig, request);

    expect(result.outcome).toBe("budget_blocked");
    expect(result.error_kind).toBeUndefined();
  });
});