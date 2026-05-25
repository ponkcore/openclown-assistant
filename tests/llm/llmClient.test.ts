import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  chatCompletion,
  vision,
  isPromptOrResponseSafeForLogging,
  type ChatCompletionOpts,
  type VisionOpts,
  type LlmCallContext,
  type ChatCompletionResult,
} from "../../src/llm/llmClient.js";
import {
  initRegistry,
  closeRegistry,
  _resetLegacyWarned,
  type LlmRegistryFile,
} from "../../src/llm/registry.js";
import type { Resolved } from "../../src/llm/registry.js";
import type { SpendTracker, PreflightResult } from "../../src/observability/costGuard.js";
import type { OpenClawLogger } from "../../src/shared/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLogger(): OpenClawLogger & { logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> } {
  const logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];
  return {
    logs,
    info(msg: string, meta?: Record<string, unknown>) { logs.push({ level: "info", msg, meta }); },
    warn(msg: string, meta?: Record<string, unknown>) { logs.push({ level: "warn", msg, meta }); },
    error(msg: string, meta?: Record<string, unknown>) { logs.push({ level: "error", msg, meta }); },
    critical(msg: string, meta?: Record<string, unknown>) { logs.push({ level: "critical", msg, meta }); },
  };
}

function makeMockSpendTracker(): SpendTracker {
  return {
    preflightCheck: vi.fn().mockResolvedValue({
      allowed: true,
      projectedSpendUsd: 0.001,
      estimatedCallCostUsd: 0.001,
    } as PreflightResult),
    recordCostAndCheckBudget: vi.fn().mockResolvedValue({
      estimatedSpendUsd: 0.001,
      degradeModeEnabled: false,
      poAlertSentAt: null,
      monthUtc: "2026-05",
    }),
  } as unknown as SpendTracker;
}

function makeContext(overrides?: Partial<LlmCallContext>): LlmCallContext {
  return {
    callType: "text_llm",
    requestId: "req-001",
    userId: "user-001",
    logger: makeLogger(),
    spendTracker: makeMockSpendTracker(),
    degradeModeEnabled: false,
    ...overrides,
  };
}

const VALID_REGISTRY: LlmRegistryFile = {
  version: 1,
  providers: {
    testprovider: { base_url: "https://llm.example.com/v1", api_key_env: "LLM_TEST_API_KEY" },
  },
  call_types: {
    "kbju.meal_text": { provider: "testprovider", model: "gpt-test-120b" },
    "kbju.photo_recognition": { provider: "testprovider", model: "qwen3-vl-test" },
  },
};

function setupRegistry(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-client-test-"));
  const filePath = path.join(tmpDir, "llm.json");
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(VALID_REGISTRY, null, 2));
  fs.renameSync(tmpPath, filePath);

  const logger = makeLogger();
  const metrics = { increments: [] as Array<{ name: string; labels: Record<string, string>; delta?: number }>, increment(name: string, labels: Record<string, string>, delta?: number) { this.increments.push({ name, labels, delta }); } };
  initRegistry(filePath, logger, metrics);
  return tmpDir;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("llmClient.chatCompletion", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = setupRegistry();
    process.env.LLM_TEST_API_KEY = "test-api-key-12345";
    _resetLegacyWarned();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.LLM_TEST_API_KEY;
  });

  it("makes a successful chat completion call via registry", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"items":[]}' } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      }),
    });
    globalThis.fetch = fetchSpy;

    const opts: ChatCompletionOpts = {
      call_type: "kbju.meal_text",
      messages: [
        { role: "system", content: "You are a food estimator." },
        { role: "user", content: "гречка" },
      ],
    };

    const ctx = makeContext();
    const result = await chatCompletion(opts, ctx);

    expect(result.outcome).toBe("success");
    expect(result.provider_id).toBe("testprovider");
    expect(result.model).toBe("gpt-test-120b");
    expect(result.rawResponseText).toBe('{"items":[]}');
    expect(result.inputUnits).toBe(50);
    expect(result.outputUnits).toBe(20);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Check the URL and auth header
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    expect((init as RequestInit).headers).toHaveProperty("Authorization", "Bearer test-api-key-12345");
  });

  it("uses resolvedOverride to bypass registry", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    globalThis.fetch = fetchSpy;

    const override: Resolved = {
      provider_id: "custom",
      base_url: "https://custom.example.com/v1",
      api_key_env: "LLM_CUSTOM_KEY",
      model: "custom-model",
    };
    process.env.LLM_CUSTOM_KEY = "custom-key";

    const opts: ChatCompletionOpts = {
      call_type: "any.alias",
      messages: [{ role: "user", content: "test" }],
    };

    const ctx = makeContext();
    const result = await chatCompletion(opts, ctx, override);

    expect(result.outcome).toBe("success");
    expect(result.provider_id).toBe("custom");
    expect(result.model).toBe("custom-model");

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://custom.example.com/v1/chat/completions");

    delete process.env.LLM_CUSTOM_KEY;
  });

  it("returns registry_error when alias not found", async () => {
    const opts: ChatCompletionOpts = {
      call_type: "nonexistent.alias",
      messages: [{ role: "user", content: "test" }],
    };

    const ctx = makeContext();
    const result = await chatCompletion(opts, ctx);

    expect(result.outcome).toBe("registry_error");
  });

  it("returns provider_failure on HTTP error", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad request",
    });
    globalThis.fetch = fetchSpy;

    const opts: ChatCompletionOpts = {
      call_type: "kbju.meal_text",
      messages: [{ role: "user", content: "test" }],
    };

    const ctx = makeContext();
    const result = await chatCompletion(opts, ctx);

    expect(result.outcome).toBe("provider_failure");
    expect(result.rawResponseText).toBe("bad request");
  });

  it("retries on HTTP 429", async () => {
    let callCount = 0;
    const fetchSpy = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 429, text: async () => "rate limited" };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "success after retry" } }],
          usage: { prompt_tokens: 30, completion_tokens: 10 },
        }),
      };
    });
    globalThis.fetch = fetchSpy;

    const opts: ChatCompletionOpts = {
      call_type: "kbju.meal_text",
      messages: [{ role: "user", content: "test" }],
    };

    const ctx = makeContext();
    const result = await chatCompletion(opts, ctx);

    expect(result.outcome).toBe("success");
    expect(result.rawResponseText).toBe("success after retry");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns budget_blocked when preflight denies", async () => {
    const spendTracker = makeMockSpendTracker();
    (spendTracker.preflightCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      projectedSpendUsd: 0.001,
      estimatedCallCostUsd: 0.001,
      reason: "over_ceiling",
    });

    const opts: ChatCompletionOpts = {
      call_type: "kbju.meal_text",
      messages: [{ role: "user", content: "test" }],
    };

    const ctx = makeContext({ spendTracker });
    const result = await chatCompletion(opts, ctx);

    expect(result.outcome).toBe("budget_blocked");
  });

  it("no raw API key appears in any log line", async () => {
    const logger = makeLogger();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    globalThis.fetch = fetchSpy;

    const opts: ChatCompletionOpts = {
      call_type: "kbju.meal_text",
      messages: [{ role: "user", content: "test" }],
    };

    const ctx = makeContext({ logger });
    await chatCompletion(opts, ctx);

    const allLogOutput = logger.logs
      .map((l) => {
        const metaStr = l.meta ? JSON.stringify(l.meta) : "";
        return `${l.msg} ${metaStr}`;
      })
      .join(" ");

    expect(allLogOutput).not.toContain("test-api-key-12345");
    // Only the env-var NAME should appear, not the value
    expect(allLogOutput).toContain("provider_alias");
    expect(allLogOutput).toContain("model_alias");
  });

  it("passes response_format in the request body", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"label":"KBJU"}' } }],
        usage: { prompt_tokens: 30, completion_tokens: 5 },
      }),
    });
    globalThis.fetch = fetchSpy;

    const opts: ChatCompletionOpts = {
      call_type: "kbju.meal_text",
      messages: [{ role: "user", content: "test" }],
      response_format: { type: "json_schema", json_schema: { name: "test" } },
    };

    const ctx = makeContext();
    await chatCompletion(opts, ctx);

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "test" } });
  });
});

describe("llmClient.vision", () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = setupRegistry();
    process.env.LLM_TEST_API_KEY = "test-api-key-12345";
    _resetLegacyWarned();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.LLM_TEST_API_KEY;
  });

  it("sends image_url in the request body for vision calls", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"food":"borsch"}' } }],
        usage: { prompt_tokens: 200, completion_tokens: 30 },
      }),
    });
    globalThis.fetch = fetchSpy;

    const opts: VisionOpts = {
      call_type: "kbju.photo_recognition",
      messages: [
        { role: "system", content: "Identify food in photo." },
        { role: "user", content: "What is in this photo?" },
      ],
      image_url: "data:image/jpeg;base64,/9j/4AAQ",
    };

    const ctx = makeContext({ callType: "vision_llm" });
    const result = await vision(opts, ctx);

    expect(result.outcome).toBe("success");
    expect(result.provider_id).toBe("testprovider");

    // Check the body includes image_url content block
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    const lastMsg = body.messages[body.messages.length - 1];
    expect(lastMsg.role).toBe("user");
    // content should be an array with image_url type
    expect(Array.isArray(lastMsg.content)).toBe(true);
    const imageBlock = lastMsg.content.find((c: { type: string }) => c.type === "image_url");
    expect(imageBlock).toBeDefined();
    expect(imageBlock.image_url.url).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });
});

describe("isPromptOrResponseSafeForLogging", () => {
  it("rejects objects with forbidden fields", () => {
    expect(isPromptOrResponseSafeForLogging({ raw_prompt: "x" })).toBe(false);
    expect(isPromptOrResponseSafeForLogging({ provider_response_raw: "x" })).toBe(false);
    expect(isPromptOrResponseSafeForLogging({ system_prompt: "x" })).toBe(false);
  });

  it("accepts safe objects", () => {
    expect(isPromptOrResponseSafeForLogging({ provider_id: "omniroute" })).toBe(true);
    expect(isPromptOrResponseSafeForLogging({ model_alias: "gpt-oss-120b" })).toBe(true);
  });
});
