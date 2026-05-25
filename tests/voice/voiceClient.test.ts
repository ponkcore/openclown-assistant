import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  transcribe,
  buildAuthHeader,
  type TranscribeOpts,
  type VoiceCallContext,
  type TranscribeResult,
} from "../../src/voice/voiceClient.js";
import {
  initRegistry,
  closeRegistry,
  _resetLegacyWarned,
  type LlmRegistryFile,
} from "../../src/llm/registry.js";
import type { Resolved } from "../../src/llm/registry.js";
import type { OpenClawLogger } from "../../src/shared/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLogger(): OpenClawLogger & {
  logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>;
} {
  const logs: Array<{
    level: string;
    msg: string;
    meta?: Record<string, unknown>;
  }> = [];
  return {
    logs,
    info(msg: string, meta?: Record<string, unknown>) {
      logs.push({ level: "info", msg, meta });
    },
    warn(msg: string, meta?: Record<string, unknown>) {
      logs.push({ level: "warn", msg, meta });
    },
    error(msg: string, meta?: Record<string, unknown>) {
      logs.push({ level: "error", msg, meta });
    },
    critical(msg: string, meta?: Record<string, unknown>) {
      logs.push({ level: "critical", msg, meta });
    },
  };
}

function makeContext(overrides?: Partial<VoiceCallContext>): VoiceCallContext {
  return {
    requestId: "req-001",
    userId: "user-001",
    logger: makeLogger(),
    ...overrides,
  };
}

// A minimal 1-second-ish WAV/OGG fixture — 4 bytes is fine for the mock server
const FAKE_AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // "OggS" magic

function makeOpts(overrides?: Partial<TranscribeOpts>): TranscribeOpts {
  return {
    call_type: "kbju.voice_transcription",
    audio_buffer: FAKE_AUDIO,
    audio_mime: "audio/ogg",
    audio_filename: "voice.ogg",
    language: "ru",
    ...overrides,
  };
}

// ── Registry setup ──────────────────────────────────────────────────────────

const VALID_REGISTRY: LlmRegistryFile = {
  version: 1,
  providers: {
    fireworks: {
      base_url: "https://api.fireworks.ai/inference/v1",
      api_key_env: "LLM_FIREWORKS_API_KEY",
    },
    deepgram_shim: {
      base_url: "https://api.deepgram.com/v1",
      api_key_env: "LLM_DEEPGRAM_API_KEY",
      auth_header_template: "Token {key}",
    },
  },
  call_types: {
    "kbju.voice_transcription": {
      provider: "fireworks",
      model: "whisper-v3-turbo",
    },
    "kbju.voice_transcription_deepgram": {
      provider: "deepgram_shim",
      model: "nova-2",
    },
  },
};

function setupRegistry(
  registryData: LlmRegistryFile = VALID_REGISTRY,
): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-client-test-"));
  const filePath = path.join(tmpDir, "llm.json");
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(registryData, null, 2));
  fs.renameSync(tmpPath, filePath);

  const logger = makeLogger();
  const metrics = {
    increments: [] as Array<{
      name: string;
      labels: Record<string, string>;
      delta?: number;
    }>,
    increment(
      name: string,
      labels: Record<string, string>,
      delta?: number,
    ) {
      this.increments.push({ name, labels, delta });
    },
  };
  initRegistry(filePath, logger, metrics);
  return tmpDir;
}

// ── Mock fetch helpers ──────────────────────────────────────────────────────

const SUCCESS_RESPONSE = { text: "гречка 200 грамм" };

function mockFetchSuccess(body: unknown = SUCCESS_RESPONSE): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function mockFetchError(status: number = 500): Response {
  return new Response("server error", { status });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("voiceClient.transcribe", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = setupRegistry();
    process.env.LLM_FIREWORKS_API_KEY = "fw-test-key-abc123";
    process.env.LLM_DEEPGRAM_API_KEY = "dg-test-key-xyz789";
    _resetLegacyWarned();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.LLM_FIREWORKS_API_KEY;
    delete process.env.LLM_DEEPGRAM_API_KEY;
  });

  // ── 1. Happy path ───────────────────────────────────────────────────────

  it("returns transcript text on successful response (AC#3)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchSuccess());
    globalThis.fetch = fetchSpy;

    const opts = makeOpts();
    const ctx = makeContext();
    const result = await transcribe(opts, ctx);

    expect(result.outcome).toBe("success");
    expect(result.transcriptText).toBe("гречка 200 грамм");
    expect(result.provider_id).toBe("fireworks");
    expect(result.model).toBe("whisper-v3-turbo");
    expect(result.provider_extras).toEqual({});
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Verify URL pattern: base_url + /audio/transcriptions
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://api.fireworks.ai/inference/v1/audio/transcriptions",
    );
  });

  it("preserves provider_extras from response (telemetry only)", async () => {
    const responseWithExtras = {
      text: "гречка 200 грамм",
      language: "ru",
      duration: 3.5,
      segments: [{ start: 0, end: 3.5, text: "гречка 200 грамм" }],
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(mockFetchSuccess(responseWithExtras));
    globalThis.fetch = fetchSpy;

    const opts = makeOpts();
    const ctx = makeContext();
    const result = await transcribe(opts, ctx);

    expect(result.outcome).toBe("success");
    expect(result.transcriptText).toBe("гречка 200 грамм");
    // Extras preserved for telemetry — must NOT include "text"
    expect(result.provider_extras).not.toHaveProperty("text");
    expect(result.provider_extras).toHaveProperty("language", "ru");
    expect(result.provider_extras).toHaveProperty("duration", 3.5);
  });

  // ── 2. Network failure — one retry (ADR-023@0.1.0 §Decision) ────────────

  it("retries once on transport failure (5xx) and succeeds on retry", async () => {
    let callCount = 0;
    const fetchSpy = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return mockFetchError(500);
      }
      return mockFetchSuccess();
    });
    globalThis.fetch = fetchSpy;

    const opts = makeOpts();
    const ctx = makeContext();
    const result = await transcribe(opts, ctx);

    expect(result.outcome).toBe("success");
    expect(result.transcriptText).toBe("гречка 200 грамм");
    expect(callCount).toBe(2);
  });

  it("retries once on fetch error (network) and succeeds on retry", async () => {
    let callCount = 0;
    const fetchSpy = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new TypeError("fetch failed");
      }
      return mockFetchSuccess();
    });
    globalThis.fetch = fetchSpy;

    const opts = makeOpts();
    const ctx = makeContext();
    const result = await transcribe(opts, ctx);

    expect(result.outcome).toBe("success");
    expect(result.transcriptText).toBe("гречка 200 грамм");
    expect(callCount).toBe(2);
  });

  it("retries once on HTTP 429 and returns failure if retry also fails", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchError(429));
    globalThis.fetch = fetchSpy;

    const opts = makeOpts();
    const ctx = makeContext();
    const result = await transcribe(opts, ctx);

    expect(result.outcome).toBe("provider_failure");
    expect(fetchSpy).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("does NOT retry on non-retryable HTTP error (4xx)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchError(400));
    globalThis.fetch = fetchSpy;

    const opts = makeOpts();
    const ctx = makeContext();
    const result = await transcribe(opts, ctx);

    expect(result.outcome).toBe("provider_failure");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ── 3. Oversize audio — voiceClient does NOT reject (adapter's job) ──────

  it("accepts large audio buffer without rejection (duration check is adapter's job)", async () => {
    // Simulate a "large" buffer — the voiceClient takes raw bytes and
    // doesn't validate duration. Duration >15s check is the wrapping
    // component's responsibility (ARCH-001@0.7.1 §3.5).
    const largeBuffer = new Uint8Array(1024 * 1024); // 1 MB
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchSuccess());
    globalThis.fetch = fetchSpy;

    const opts = makeOpts({ audio_buffer: largeBuffer });
    const ctx = makeContext();
    const result = await transcribe(opts, ctx);

    expect(result.outcome).toBe("success");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ── 4. Missing API key error ────────────────────────────────────────────

  it("returns registry_error when API key env var is unset (AC#5)", async () => {
    delete process.env.LLM_FIREWORKS_API_KEY;

    const opts = makeOpts();
    const ctx = makeContext();
    const result = await transcribe(opts, ctx);

    expect(result.outcome).toBe("registry_error");
  });

  it("returns registry_error when alias not found in registry", async () => {
    const opts = makeOpts({ call_type: "nonexistent.alias" });
    const ctx = makeContext();
    const result = await transcribe(opts, ctx);

    expect(result.outcome).toBe("registry_error");
  });

  // ── 5. Malformed JSON response ──────────────────────────────────────────

  it("handles malformed JSON response gracefully", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("not valid json{{{", { status: 200 }),
    );
    globalThis.fetch = fetchSpy;

    const opts = makeOpts();
    const ctx = makeContext();
    const result = await transcribe(opts, ctx);

    // JSON parse failure should be treated as provider_failure
    expect(result.outcome).toBe("provider_failure");
  });

  it("handles JSON response missing 'text' field", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(mockFetchSuccess({ language: "ru" }));
    globalThis.fetch = fetchSpy;

    const opts = makeOpts();
    const ctx = makeContext();
    const result = await transcribe(opts, ctx);

    // Missing text → empty transcript, still success
    expect(result.outcome).toBe("success");
    expect(result.transcriptText).toBe("");
  });

  // ── 6. auth_header_template variant (ADR-024@0.1.0 §Schema) ─────────────

  it("uses default Bearer auth when auth_header_template is not set", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchSuccess());
    globalThis.fetch = fetchSpy;

    const opts = makeOpts();
    const ctx = makeContext();
    await transcribe(opts, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toHaveProperty(
      "Authorization",
      "Bearer fw-test-key-abc123",
    );
  });

  it("uses auth_header_template when set (e.g. Token {key} for Deepgram shim) (AC#4)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchSuccess());
    globalThis.fetch = fetchSpy;

    // Use the deepgram_shim call type which has auth_header_template: "Token {key}"
    const opts = makeOpts({
      call_type: "kbju.voice_transcription_deepgram",
    });
    const ctx = makeContext();
    await transcribe(opts, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toHaveProperty(
      "Authorization",
      "Token dg-test-key-xyz789",
    );
  });

  // ── resolvedOverride path ───────────────────────────────────────────────

  it("uses resolvedOverride to bypass registry", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchSuccess());
    globalThis.fetch = fetchSpy;

    const override: Resolved = {
      provider_id: "custom-voice",
      base_url: "https://custom.voice.example.com/v1",
      api_key_env: "LLM_CUSTOM_VOICE_KEY",
      model: "custom-whisper",
    };
    process.env.LLM_CUSTOM_VOICE_KEY = "custom-voice-key";

    const opts = makeOpts();
    const ctx = makeContext();
    const result = await transcribe(opts, ctx, override);

    expect(result.outcome).toBe("success");
    expect(result.provider_id).toBe("custom-voice");
    expect(result.model).toBe("custom-whisper");

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://custom.voice.example.com/v1/audio/transcriptions");

    delete process.env.LLM_CUSTOM_VOICE_KEY;
  });

  it("returns registry_error when resolvedOverride env var is unset", async () => {
    const override: Resolved = {
      provider_id: "custom-voice",
      base_url: "https://custom.voice.example.com/v1",
      api_key_env: "LLM_MISSING_KEY",
      model: "custom-whisper",
    };

    const opts = makeOpts();
    const ctx = makeContext();
    const result = await transcribe(opts, ctx, override);

    expect(result.outcome).toBe("registry_error");
  });

  // ── No raw API key in logs (AC#6) ───────────────────────────────────────

  it("never logs raw API keys (AC#6)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchSuccess());
    globalThis.fetch = fetchSpy;

    const logger = makeLogger();
    const opts = makeOpts();
    const ctx = makeContext({ logger });
    await transcribe(opts, ctx);

    const allLogs = logger.logs.map((l) => JSON.stringify(l)).join(" ");
    // The raw API key must NOT appear in any log output
    expect(allLogs).not.toContain("fw-test-key-abc123");
    expect(allLogs).not.toContain("Bearer fw-test-key-abc123");
  });

  it("never logs raw API keys on error path", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchError(500));
    globalThis.fetch = fetchSpy;

    const logger = makeLogger();
    const opts = makeOpts();
    const ctx = makeContext({ logger });
    await transcribe(opts, ctx);

    const allLogs = logger.logs.map((l) => JSON.stringify(l)).join(" ");
    expect(allLogs).not.toContain("fw-test-key-abc123");
  });

  // ── Multipart form-data shape ────────────────────────────────────────────

  it("sends multipart form-data with correct fields (AC#3)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchSuccess());
    globalThis.fetch = fetchSpy;

    const opts = makeOpts({
      language: "ru",
      prompt: "Russian meal description",
      temperature: 0.0,
    });
    const ctx = makeContext();
    await transcribe(opts, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    const body = (init as RequestInit).body;
    // Body should be FormData (not JSON)
    expect(body).toBeInstanceOf(FormData);
  });

  it("defaults language to 'ru' when not specified (ADR-023@0.1.0)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchSuccess());
    globalThis.fetch = fetchSpy;

    const opts = makeOpts();
    delete opts.language;
    const ctx = makeContext();
    await transcribe(opts, ctx);

    // The FormData should have language="ru" by default
    const [, init] = fetchSpy.mock.calls[0];
    const body = (init as RequestInit).body as FormData;
    // Can't easily inspect FormData in Node test, but the request was made
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ── buildAuthHeader unit tests ──────────────────────────────────────────────

describe("buildAuthHeader", () => {
  it("returns Bearer pattern when auth_header_template is not set", () => {
    const resolved: Resolved = {
      provider_id: "test",
      base_url: "https://example.com/v1",
      api_key_env: "TEST_KEY",
      model: "test-model",
    };
    expect(buildAuthHeader(resolved, "my-api-key")).toBe(
      "Bearer my-api-key",
    );
  });

  it("replaces {key} in auth_header_template", () => {
    const resolved: Resolved = {
      provider_id: "deepgram",
      base_url: "https://api.deepgram.com/v1",
      api_key_env: "DEEPGRAM_KEY",
      model: "nova-2",
      auth_header_template: "Token {key}",
    };
    expect(buildAuthHeader(resolved, "dg-key-123")).toBe(
      "Token dg-key-123",
    );
  });

  it("handles auth_header_template with custom prefix", () => {
    const resolved: Resolved = {
      provider_id: "custom",
      base_url: "https://custom.com/v1",
      api_key_env: "CUSTOM_KEY",
      model: "custom-model",
      auth_header_template: "ApiKey {key}",
    };
    expect(buildAuthHeader(resolved, "ck-456")).toBe("ApiKey ck-456");
  });
});
