/**
 * Provider-swap smoke tests — ARCH-001@0.7.2 §11.1 mandatory boot smoke
 *
 * Proves that swapping a provider in `config/llm.json` (and / or its
 * referenced `LLM_*` env var) redirects the next call without code change
 * or rebuild, satisfying PRD-001@0.3.0 §7.
 *
 * Three swap scenarios (chat, vision, voice) + one env-var boundary test.
 * Mocks use Node's built-in `http` module — no extra deps (TKT-036@0.1.0 §7).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createMockServer,
  type MockServer,
  type MockServerConfig,
} from "../_helpers/mockOpenAiServer.js";
import {
  initRegistry,
  resolve,
  reload,
  getApiKey,
  closeRegistry,
  _resetLegacyWarned,
  type LlmRegistryFile,
} from "../../src/llm/registry.js";
import {
  chatCompletion,
  vision,
  type LlmCallContext,
  type ChatCompletionResult,
} from "../../src/llm/llmClient.js";
import {
  transcribe,
  type VoiceCallContext,
  type TranscribeResult,
} from "../../src/voice/voiceClient.js";
import type { OpenClawLogger, CallType } from "../../src/shared/types.js";
import type {
  SpendTracker,
  PreflightResult,
  SpendState,
} from "../../src/observability/costGuard.js";

// ── Shared helpers ──────────────────────────────────────────────────────────

function makeLogger(): OpenClawLogger & {
  logs: Array<{ level: string; msg: string }>;
} {
  const logs: Array<{ level: string; msg: string }> = [];
  return {
    logs,
    info(msg: string) {
      logs.push({ level: "info", msg });
    },
    warn(msg: string) {
      logs.push({ level: "warn", msg });
    },
    error(msg: string) {
      logs.push({ level: "error", msg });
    },
    critical(msg: string) {
      logs.push({ level: "critical", msg });
    },
  };
}

function makeMetrics() {
  const increments: Array<{
    name: string;
    labels: Record<string, string>;
    delta?: number;
  }> = [];
  return {
    increments,
    increment(name: string, labels: Record<string, string>, delta?: number) {
      increments.push({ name, labels, delta });
    },
  };
}

/**
 * Mock SpendTracker that satisfies the `SpendTracker` contract without
 * needing Postgres.  Always allows the call and records zero cost.
 */
function makeMockSpendTracker(): SpendTracker {
  return {
    async preflightCheck(): Promise<PreflightResult> {
      return {
        allowed: true,
        projectedSpendUsd: 0,
        estimatedCallCostUsd: 0,
      };
    },
    async recordCostAndCheckBudget(): Promise<SpendState> {
      return {
        estimatedSpendUsd: 0,
        degradeModeEnabled: false,
        poAlertSentAt: null,
        monthUtc: "2026-05",
      };
    },
  } as unknown as SpendTracker;
}

/** Atomic rewrite: write to `.tmp` then `fs.renameSync` over the target. */
function atomicRewrite(filePath: string, data: LlmRegistryFile): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function writeRegistry(dir: string, data: LlmRegistryFile): string {
  const filePath = path.join(dir, "llm.json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

/**
 * Poll `resolve(callType)` until `model` matches `expectedModel` or
 * `deadlineMs` elapses.  Returns `true` on success.
 */
async function waitForHotReload(
  callType: string,
  expectedModel: string,
  deadlineMs: number = 3000,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      if (resolve(callType).model === expectedModel) return true;
    } catch {
      // registry may be mid-reload; keep polling
    }
  }
  return false;
}

/** Build a `LlmCallContext` for smoke tests (no Postgres, no kill-switch). */
function makeLlmCtx(
  logger: OpenClawLogger,
  spendTracker: SpendTracker,
  callType: CallType = "text_llm",
): LlmCallContext {
  return {
    callType,
    requestId: "smoke-test-req-001",
    userId: "smoke-test-user",
    logger,
    spendTracker,
    degradeModeEnabled: false,
    stallConfig: { thresholdMs: 60000, pollIntervalMs: 30000, maxRetries: 0 },
    fileExists: () => false,
  };
}

/** Build a `VoiceCallContext` for smoke tests. */
function makeVoiceCtx(logger: OpenClawLogger): VoiceCallContext {
  return {
    requestId: "smoke-test-req-001",
    userId: "smoke-test-user",
    logger,
    stallConfig: { thresholdMs: 60000, pollIntervalMs: 30000, maxRetries: 0 },
    fileExists: () => false,
  };
}

/** Dummy audio buffer (1 KiB of zeros). */
const DUMMY_AUDIO = new Uint8Array(1024);

/** Env-var names used in these tests (cleaned up in afterEach). */
const ENV_VARS = [
  "LLM_MOCK_A_API_KEY",
  "LLM_MOCK_B_API_KEY",
  "LLM_SWAP_TEST_API_KEY",
] as const;

// ── Test suite ──────────────────────────────────────────────────────────────

describe("Provider swap smoke tests (ARCH-001@0.7.2 §11.1)", () => {
  let tmpDir: string;
  let logger: ReturnType<typeof makeLogger>;
  let metrics: ReturnType<typeof makeMetrics>;
  let mockSpendTracker: SpendTracker;
  let serverA: MockServer;
  let serverB: MockServer;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-swap-test-"));
    logger = makeLogger();
    metrics = makeMetrics();
    mockSpendTracker = makeMockSpendTracker();
    _resetLegacyWarned();

    // Clean up env vars that might be left from a previous run
    for (const v of ENV_VARS) delete process.env[v];

    // Spin up two mock servers on OS-assigned ports
    serverA = await createMockServer({
      chatResponseText: "response-from-A",
      voiceResponseText: "transcript-from-A",
      model: "mock-a-model",
    });
    serverB = await createMockServer({
      chatResponseText: "response-from-B",
      voiceResponseText: "transcript-from-B",
      model: "mock-b-model",
    });

    // Set API keys for both mock providers
    process.env.LLM_MOCK_A_API_KEY = "test-mock-key-a-do-not-log";
    process.env.LLM_MOCK_B_API_KEY = "test-mock-key-b-do-not-log";
  });

  afterEach(async () => {
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await serverA.close();
    await serverB.close();
    for (const v of ENV_VARS) delete process.env[v];
  });

  // ── Helpers to build a registry config for the two mock servers ──────────

  function configPointingAtA(callType: string): LlmRegistryFile {
    return {
      version: 1,
      providers: {
        mock_a: {
          base_url: serverA.baseUrl,
          api_key_env: "LLM_MOCK_A_API_KEY",
        },
        mock_b: {
          base_url: serverB.baseUrl,
          api_key_env: "LLM_MOCK_B_API_KEY",
        },
      },
      call_types: {
        [callType]: { provider: "mock_a", model: "mock-a-model" },
      },
    };
  }

  function configPointingAtB(callType: string): LlmRegistryFile {
    return {
      version: 1,
      providers: {
        mock_a: {
          base_url: serverA.baseUrl,
          api_key_env: "LLM_MOCK_A_API_KEY",
        },
        mock_b: {
          base_url: serverB.baseUrl,
          api_key_env: "LLM_MOCK_B_API_KEY",
        },
      },
      call_types: {
        [callType]: { provider: "mock_b", model: "mock-b-model" },
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Chat swap: A → B via hot-reload
  // ─────────────────────────────────────────────────────────────────────────

  it("chat: config-only provider swap via hot-reload (A → B)", async () => {
    const callType = "kbju.modality_router_classifier";
    const filePath = writeRegistry(tmpDir, configPointingAtA(callType));
    initRegistry(filePath, logger, metrics);

    // ── Call #1 → server A ────────────────────────────────────────────────
    const result1 = await chatCompletion(
      {
        call_type: callType,
        messages: [{ role: "user", content: "hello" }],
      },
      makeLlmCtx(logger, mockSpendTracker, "text_llm"),
    );

    expect(result1.outcome).toBe("success");
    expect(result1.rawResponseText).toBe("response-from-A");
    expect(result1.provider_id).toBe("mock_a");

    // ── Atomic rewrite: swap call-type from mock_a → mock_b ───────────────
    atomicRewrite(filePath, configPointingAtB(callType));

    // ── Wait for hot-reload (fs.watchFile, ≤2 s target) ───────────────────
    const reloaded = await waitForHotReload(callType, "mock-b-model");
    expect(reloaded).toBe(true);

    // ── Call #2 → server B ────────────────────────────────────────────────
    const result2 = await chatCompletion(
      {
        call_type: callType,
        messages: [{ role: "user", content: "hello" }],
      },
      makeLlmCtx(logger, mockSpendTracker, "text_llm"),
    );

    expect(result2.outcome).toBe("success");
    expect(result2.rawResponseText).toBe("response-from-B");
    expect(result2.provider_id).toBe("mock_b");

    // ── AC: no raw API key in any log line ─────────────────────────────────
    const allLogs = logger.logs.map((l) => l.msg).join(" ");
    expect(allLogs).not.toContain("test-mock-key-a-do-not-log");
    expect(allLogs).not.toContain("test-mock-key-b-do-not-log");
  }, 15_000);

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Vision swap: A → B via hot-reload
  // ─────────────────────────────────────────────────────────────────────────

  it("vision: config-only provider swap via hot-reload (A → B)", async () => {
    const callType = "kbju.photo_recognition";
    const filePath = writeRegistry(tmpDir, configPointingAtA(callType));
    initRegistry(filePath, logger, metrics);

    // ── Call #1 → server A ────────────────────────────────────────────────
    const result1 = await vision(
      {
        call_type: callType,
        messages: [{ role: "user", content: "What is in this photo?" }],
        image_url: "https://example.com/photo.jpg",
      },
      makeLlmCtx(logger, mockSpendTracker, "vision_llm"),
    );

    expect(result1.outcome).toBe("success");
    expect(result1.rawResponseText).toBe("response-from-A");
    expect(result1.provider_id).toBe("mock_a");

    // ── Atomic rewrite: swap to mock_b ────────────────────────────────────
    atomicRewrite(filePath, configPointingAtB(callType));

    // ── Wait for hot-reload ───────────────────────────────────────────────
    const reloaded = await waitForHotReload(callType, "mock-b-model");
    expect(reloaded).toBe(true);

    // ── Call #2 → server B ────────────────────────────────────────────────
    const result2 = await vision(
      {
        call_type: callType,
        messages: [{ role: "user", content: "What is in this photo?" }],
        image_url: "https://example.com/photo.jpg",
      },
      makeLlmCtx(logger, mockSpendTracker, "vision_llm"),
    );

    expect(result2.outcome).toBe("success");
    expect(result2.rawResponseText).toBe("response-from-B");
    expect(result2.provider_id).toBe("mock_b");

    // ── AC: no raw API key in any log line ─────────────────────────────────
    const allLogs = logger.logs.map((l) => l.msg).join(" ");
    expect(allLogs).not.toContain("test-mock-key-a-do-not-log");
    expect(allLogs).not.toContain("test-mock-key-b-do-not-log");
  }, 15_000);

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Voice swap: A → B via hot-reload
  // ─────────────────────────────────────────────────────────────────────────

  it("voice: config-only provider swap via hot-reload (A → B)", async () => {
    const callType = "kbju.voice_transcription";
    const filePath = writeRegistry(tmpDir, configPointingAtA(callType));
    initRegistry(filePath, logger, metrics);

    // ── Call #1 → server A ────────────────────────────────────────────────
    const result1 = await transcribe(
      {
        call_type: callType,
        audio_buffer: DUMMY_AUDIO,
        audio_mime: "audio/ogg",
        audio_filename: "voice.ogg",
      },
      makeVoiceCtx(logger),
    );

    expect(result1.outcome).toBe("success");
    expect(result1.transcriptText).toBe("transcript-from-A");
    expect(result1.provider_id).toBe("mock_a");

    // ── Atomic rewrite: swap to mock_b ────────────────────────────────────
    atomicRewrite(filePath, configPointingAtB(callType));

    // ── Wait for hot-reload ───────────────────────────────────────────────
    const reloaded = await waitForHotReload(callType, "mock-b-model");
    expect(reloaded).toBe(true);

    // ── Call #2 → server B ────────────────────────────────────────────────
    const result2 = await transcribe(
      {
        call_type: callType,
        audio_buffer: DUMMY_AUDIO,
        audio_mime: "audio/ogg",
        audio_filename: "voice.ogg",
      },
      makeVoiceCtx(logger),
    );

    expect(result2.outcome).toBe("success");
    expect(result2.transcriptText).toBe("transcript-from-B");
    expect(result2.provider_id).toBe("mock_b");

    // ── AC: no raw API key in any log line ─────────────────────────────────
    const allLogs = logger.logs.map((l) => l.msg).join(" ");
    expect(allLogs).not.toContain("test-mock-key-a-do-not-log");
    expect(allLogs).not.toContain("test-mock-key-b-do-not-log");
  }, 15_000);

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Env-var boundary: getApiKey() re-reads process.env at call time;
  //    env-var changes do NOT trigger hot-reload of resolve() output.
  // ─────────────────────────────────────────────────────────────────────────

  it("env-var boundary: getApiKey() re-reads process.env at call time, resolve() does not auto-reload env vars", async () => {
    const callType = "kbju.meal_text";
    const envVarName = "LLM_SWAP_TEST_API_KEY";

    const config: LlmRegistryFile = {
      version: 1,
      providers: {
        mock_a: {
          base_url: serverA.baseUrl,
          api_key_env: envVarName,
        },
      },
      call_types: {
        [callType]: { provider: "mock_a", model: "mock-a-model" },
      },
    };

    // ── Set env var to value A ────────────────────────────────────────────
    process.env[envVarName] = "key-value-alpha";

    const filePath = writeRegistry(tmpDir, config);
    initRegistry(filePath, logger, metrics);

    // resolve() returns the api_key_env NAME (not the value) — this is
    // static config, unaffected by env-var changes.
    const resolved1 = resolve(callType);
    expect(resolved1.api_key_env).toBe(envVarName);
    expect(resolved1.base_url).toBe(serverA.baseUrl);

    // getApiKey() reads the current value from process.env at call time.
    expect(getApiKey(envVarName)).toBe("key-value-alpha");

    // ── Change the env var to value B (no config file change) ─────────────
    process.env[envVarName] = "key-value-beta";

    // resolve() output is UNCHANGED — env-var changes do NOT trigger
    // hot-reload and do not affect the static fields (base_url, model, etc.)
    const resolved2 = resolve(callType);
    expect(resolved2.api_key_env).toBe(envVarName);
    expect(resolved2.base_url).toBe(serverA.baseUrl);
    expect(resolved2.model).toBe("mock-a-model");

    // getApiKey() picks up the new value immediately — env vars are
    // re-read from process.env at each call, not cached from boot.
    expect(getApiKey(envVarName)).toBe("key-value-beta");

    // ── Unset the env var entirely ────────────────────────────────────────
    delete process.env[envVarName];

    // resolve() still returns the same static config
    const resolved3 = resolve(callType);
    expect(resolved3.api_key_env).toBe(envVarName);

    // getApiKey() now throws because the env var is gone
    expect(() => getApiKey(envVarName)).toThrow();

    // ── AC: no raw API key in any log line ─────────────────────────────────
    const allLogs = logger.logs.map((l) => l.msg).join(" ");
    expect(allLogs).not.toContain("key-value-alpha");
    expect(allLogs).not.toContain("key-value-beta");
  });
});
