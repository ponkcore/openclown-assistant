/**
 * Tests for src/incident/diagHandler.ts
 *
 * Per TKT-044@0.1.0 §2: unit tests at ≥80% coverage covering:
 *   - redaction allowlist enforcement
 *   - missing-data graceful degradation ("none" / "n/a")
 *   - allowlist gate (non-allowlisted user gets the standard "not allowed" copy)
 *   - webhook cache freshness boundary
 *   - metric label hashing
 *   - plain-text format (no Markdown, no parse_mode)
 *   - field set character-for-character per ADR-021@0.1.0 §`/diag` command contract
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleDiag,
  redactBlock,
  redactStringValue,
  formatDiagBlock,
  queryLastEventId,
  queryLastErrorId,
  measureDbPing,
  measureLlmPingDefault,
  measureLlmPingVoice,
  type DiagBlock,
  type DiagDeps,
} from "../../src/incident/diagHandler.js";
import type { NormalizedTelegramUpdate } from "../../src/telegram/types.js";
import { WebhookInfoCache, type WebhookInfoSnapshot } from "../../src/observability/webhookInfoCache.js";
import type { MetricsRegistry } from "../../src/observability/metricsEndpoint.js";
import type { TenantQueryable } from "../../src/store/tenantStore.js";

// ── Test helper: a WebhookInfoCache that returns a pre-set snapshot ───────

class FixedWebhookInfoCache extends WebhookInfoCache {
  constructor(snapshot: WebhookInfoSnapshot) {
    super(async () => ({
      last_error_date: snapshot.last_error_date,
      last_error_message: snapshot.last_error_message,
    }));
    // Overwrite the snapshot directly
    (this as any).snapshot = { ...snapshot };
  }
}

// ── Mocks ────────────────────────────────────────────────────────────────

function createMockDb(overrides?: {
  lastEventId?: string;
  lastErrorId?: string;
}): TenantQueryable {
  const lastEventRows = overrides?.lastEventId
    ? [{ id: overrides.lastEventId }]
    : [];
  const lastErrorRows = overrides?.lastErrorId
    ? [{ id: overrides.lastErrorId }]
    : [];
  return {
    query: vi.fn().mockImplementation((sql: string, _values?: unknown[]) => {
      if (sql.includes("outcome = 'success'")) {
        return { rows: lastEventRows };
      }
      if (sql.includes("outcome IN")) {
        return { rows: lastErrorRows };
      }
      if (sql.includes("SELECT 1")) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

function createMockMetricsRegistry(): MetricsRegistry {
  return {
    increment: vi.fn(),
    set: vi.fn(),
    observe: vi.fn(),
    getSamples: () => [],
    render: () => "",
  };
}

function createNoErrorsWebhookCache(): FixedWebhookInfoCache {
  return new FixedWebhookInfoCache({
    last_error_date: null,
    last_error_message: null,
    fetchedAtUtc: "2026-05-26T00:00:00.000Z",
  });
}

function createMinimalDeps(overrides?: Partial<DiagDeps>): DiagDeps {
  const defaultDeps: DiagDeps = {
    appVersion: "0.1.0",
    buildSha: "abc123def456",
    startedAtUtc: "2026-05-26T00:00:00.000Z",
    db: createMockDb(),
    chatCompletion: vi.fn().mockResolvedValue({
      latencyMs: 42,
      outcome: "success",
    }),
    voiceTranscribe: vi.fn().mockResolvedValue({
      latencyMs: 150,
      outcome: "success",
    }),
    webhookCache: createNoErrorsWebhookCache(),
    isAllowed: vi.fn().mockReturnValue(true),
    metricsRegistry: createMockMetricsRegistry(),
    audioProbe: new Uint8Array([0x80]), // minimal probe
  };
  return { ...defaultDeps, ...overrides };
}

function createUpdate(telegramUserId = 12345): NormalizedTelegramUpdate {
  return {
    requestId: "req-001",
    telegramUserId,
    telegramChatId: 99999,
    routeKind: "text_meal",
    text: "/diag",
    sourceLabel: "command:/diag",
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("diagHandler", () => {
  describe("allowlist gate", () => {
    it("returns the exact blocked-user copy for non-allowlisted users", async () => {
      const deps = createMinimalDeps({
        isAllowed: vi.fn().mockReturnValue(false),
      });
      const update = createUpdate(99999);

      const result = await handleDiag(update, deps);

      expect(result.text).toBe("Извините, бот пока в закрытом тестировании.");
      expect(result.parseMode).toBeUndefined();
      expect(result.replyMarkup).toBeUndefined();
    });

    it("does not invoke LLM pings for non-allowlisted users", async () => {
      const chatCompletion = vi.fn().mockResolvedValue({
        latencyMs: 42,
        outcome: "success",
      });
      const deps = createMinimalDeps({
        isAllowed: vi.fn().mockReturnValue(false),
        chatCompletion,
      });
      const update = createUpdate(99999);

      await handleDiag(update, deps);

      expect(chatCompletion).not.toHaveBeenCalled();
    });
  });

  describe("field set (ADR-021@0.1.0 character-for-character)", () => {
    it("renders all 13 fields plus delimiters in plain text", async () => {
      const deps = createMinimalDeps();
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("--- KBJU diag ---");
      expect(result.text).toContain("--- end ---");

      // All 13 fields must be present
      expect(result.text).toContain("version:");
      expect(result.text).toContain("build_sha:");
      expect(result.text).toContain("started_at_utc:");
      expect(result.text).toContain("telegram_user_id:");
      expect(result.text).toContain("last_event_id:");
      expect(result.text).toContain("last_error_id:");
      expect(result.text).toContain("db_ping_ms:");
      expect(result.text).toContain("llm_ping_ms_default:");
      expect(result.text).toContain("llm_ping_ms_voice:");
      expect(result.text).toContain("webhook_last_error_date:");
      expect(result.text).toContain("webhook_last_error_message:");
      expect(result.text).toContain("redaction_version:");
    });

    it("renders fields in the exact order per ADR-021@0.1.0", async () => {
      const deps = createMinimalDeps();
      const update = createUpdate();

      const result = await handleDiag(update, deps);
      const lines = result.text.split("\n");

      // Verify field order by finding the index of each field line
      const fieldOrder = [
        "version:",
        "build_sha:",
        "started_at_utc:",
        "telegram_user_id:",
        "last_event_id:",
        "last_error_id:",
        "db_ping_ms:",
        "llm_ping_ms_default:",
        "llm_ping_ms_voice:",
        "webhook_last_error_date:",
        "webhook_last_error_message:",
        "redaction_version:",
      ];

      const indices = fieldOrder.map((field) =>
        lines.findIndex((l) => l.startsWith(field))
      );

      // Each field must be found
      for (const idx of indices) {
        expect(idx).toBeGreaterThan(-1);
      }

      // Indices must be strictly increasing (correct order)
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBeGreaterThan(indices[i - 1]);
      }
    });

    it("uses numeric telegram_user_id as a string", async () => {
      const deps = createMinimalDeps();
      const update = createUpdate(12345);

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("telegram_user_id: 12345");
    });
  });

  describe("plain-text output (no Markdown)", () => {
    it("does not set parseMode on the reply envelope", async () => {
      const deps = createMinimalDeps();
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.parseMode).toBeUndefined();
    });

    it("does not set replyMarkup on the reply envelope", async () => {
      const deps = createMinimalDeps();
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.replyMarkup).toBeUndefined();
    });
  });

  describe("missing-data graceful degradation", () => {
    it("returns 'none' for last_event_id when no recent success events", async () => {
      const deps = createMinimalDeps({
        db: createMockDb(), // no lastEventId → "none"
      });
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("last_event_id: none");
    });

    it("returns 'none' for last_error_id when no recent error events", async () => {
      const deps = createMinimalDeps({
        db: createMockDb(), // no lastErrorId → "none"
      });
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("last_error_id: none");
    });

    it("returns 'n/a' for llm_ping_ms_default when provider unreachable", async () => {
      const deps = createMinimalDeps({
        chatCompletion: vi.fn().mockRejectedValue(new Error("unreachable")),
      });
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("llm_ping_ms_default: n/a");
    });

    it("returns 'n/a' for llm_ping_ms_default when outcome is not success", async () => {
      const deps = createMinimalDeps({
        chatCompletion: vi.fn().mockResolvedValue({
          latencyMs: 100,
          outcome: "provider_failure",
        }),
      });
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("llm_ping_ms_default: n/a");
    });

    it("returns 'n/a' for llm_ping_ms_voice when provider unreachable", async () => {
      const deps = createMinimalDeps({
        voiceTranscribe: vi.fn().mockRejectedValue(new Error("unreachable")),
      });
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("llm_ping_ms_voice: n/a");
    });

    it("returns 'n/a' for llm_ping_ms_voice when outcome is not success", async () => {
      const deps = createMinimalDeps({
        voiceTranscribe: vi.fn().mockResolvedValue({
          latencyMs: 100,
          outcome: "registry_error",
        }),
      });
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("llm_ping_ms_voice: n/a");
    });

    it("returns 'none' for webhook fields when no webhook errors", async () => {
      const deps = createMinimalDeps();
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("webhook_last_error_date: none");
      expect(result.text).toContain("webhook_last_error_message: none");
    });

    it("returns 'unknown' for build_sha when BUILD_SHA is empty", async () => {
      const deps = createMinimalDeps({ buildSha: "" });
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("build_sha: unknown");
    });
  });

  describe("redaction (PII patterns)", () => {
    it("redacts a Telegram bot token in field values", () => {
      const result = redactStringValue("bot1234567890:AAH_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
      expect(result).toContain("[TELEGRAM_TOKEN_REDACTED]");
      expect(result).not.toContain("AAH_");
    });

    it("redacts an OpenAI-style API key in field values", () => {
      const result = redactStringValue("sk-1234567890abcdef1234567890");
      expect(result).toContain("[PROVIDER_KEY_REDACTED]");
      expect(result).not.toContain("sk-1234567890");
    });

    it("redacts a Bearer token in field values", () => {
      const result = redactStringValue("Bearer abc123def456ghi789");
      expect(result).toContain("[PROVIDER_KEY_REDACTED]");
      expect(result).not.toContain("abc123def456ghi789");
    });

    it("redactBlock applies redaction to all string fields", () => {
      const block: DiagBlock = {
        version: "0.1.0",
        build_sha: "abc123",
        started_at_utc: "2026-01-01T00:00:00Z",
        telegram_user_id: "12345",
        last_event_id: "none",
        last_error_id: "none",
        db_ping_ms: 5,
        llm_ping_ms_default: "n/a",
        llm_ping_ms_voice: "n/a",
        webhook_last_error_date: "none",
        webhook_last_error_message: "Bearer secret-token-value-here",
        redaction_version: "1",
      };

      const result = redactBlock(block);

      expect(result.webhook_last_error_message).toContain("[PROVIDER_KEY_REDACTED]");
      expect(result.webhook_last_error_message).not.toContain("secret-token-value-here");
    });

    it("no raw user text leaks into the rendered block", async () => {
      // Even if a webhook error message contains user text, it must be redacted
      const cache = new FixedWebhookInfoCache({
        last_error_date: 1716681600,
        last_error_message: "Bad request: message from user with API_KEY=sk-secret1234567890abcdef",
        fetchedAtUtc: "2026-05-26T00:00:00.000Z",
      });
      const deps = createMinimalDeps({ webhookCache: cache });
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).not.toContain("sk-secret1234567890abcdef");
      expect(result.text).not.toContain("API_KEY=sk-");
    });

    it("no raw API key leaks into the rendered block", async () => {
      const deps = createMinimalDeps({
        chatCompletion: vi.fn().mockRejectedValue(new Error("key sk-abcdef1234567890abcdef12 is bad")),
      });
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      // The error doesn't reach the block — the catch returns "n/a"
      expect(result.text).toContain("llm_ping_ms_default: n/a");
      // And no raw API key in the output at all
      expect(result.text).not.toContain("sk-abcdef1234567890");
    });
  });

  describe("webhook cache freshness", () => {
    it("reads from cache, not from a fresh getWebhookInfo call", async () => {
      const getWebhookInfoFn = vi.fn().mockResolvedValue({
        last_error_date: 1716681600,
        last_error_message: "Something went wrong",
      });
      const cache = new WebhookInfoCache(getWebhookInfoFn, 60_000);
      await cache.refresh();

      const deps = createMinimalDeps({ webhookCache: cache });
      const update = createUpdate();

      // Call handleDiag twice — getWebhookInfoFn should not be called again
      const getCallCount = getWebhookInfoFn.mock.calls.length;
      await handleDiag(update, deps);
      await handleDiag(update, deps);

      // getWebhookInfoFn was called once (for the initial refresh) and not again
      expect(getWebhookInfoFn.mock.calls.length).toBe(getCallCount);
    });

    it("webhook_last_error_message updates when cache is refreshed", async () => {
      let callCount = 0;
      const getWebhookInfoFn = vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          last_error_date: callCount === 1 ? 1716681600 : 1716681700,
          last_error_message: callCount === 1 ? "Error A" : "Error B",
        };
      });
      const cache = new WebhookInfoCache(getWebhookInfoFn, 60_000);
      await cache.refresh();

      const deps1 = createMinimalDeps({ webhookCache: cache });
      const result1 = await handleDiag(createUpdate(), deps1);
      expect(result1.text).toContain("webhook_last_error_message: Error A");

      // Simulate a cache refresh (like a 60-s tick)
      await cache.refresh();

      const deps2 = createMinimalDeps({ webhookCache: cache });
      const result2 = await handleDiag(createUpdate(), deps2);
      expect(result2.text).toContain("webhook_last_error_message: Error B");
    });

    it("cache keeps stale data when getWebhookInfo fails", async () => {
      let callCount = 0;
      const getWebhookInfoFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { last_error_date: 1716681600, last_error_message: "Old error" };
        }
        throw new Error("API timeout");
      });
      const cache = new WebhookInfoCache(getWebhookInfoFn, 60_000);
      await cache.refresh();

      // Second refresh fails — should keep old snapshot
      await cache.refresh();

      const deps = createMinimalDeps({ webhookCache: cache });
      const result = await handleDiag(createUpdate(), deps);

      expect(result.text).toContain("webhook_last_error_message: Old error");
    });
  });

  describe("metric: kbju_diag_invocations_total", () => {
    it("increments with hashed telegram_user_id label", async () => {
      const metrics = createMockMetricsRegistry();
      const deps = createMinimalDeps({ metricsRegistry: metrics });
      const update = createUpdate(12345);

      await handleDiag(update, deps);

      expect(metrics.increment).toHaveBeenCalledWith(
        "kbju_diag_invocations_total",
        expect.objectContaining({
          telegram_user_id_hashed: expect.stringMatching(/^[0-9a-f]{16}$/),
        }),
      );
    });

    it("does NOT include raw telegram user ID in metric labels", async () => {
      const metrics = createMockMetricsRegistry();
      const deps = createMinimalDeps({ metricsRegistry: metrics });
      const update = createUpdate(12345);

      await handleDiag(update, deps);

      const call = (metrics.increment as ReturnType<typeof vi.fn>).mock.calls[0];
      const labels = call[1] as Record<string, string>;
      // The hashed value must not be the raw numeric ID
      expect(labels.telegram_user_id_hashed).not.toBe("12345");
      // And no raw-ID label exists
      expect(labels.telegram_user_id).toBeUndefined();
      expect(labels.user_id).toBeUndefined();
    });

    it("does NOT increment for non-allowlisted users", async () => {
      const metrics = createMockMetricsRegistry();
      const deps = createMinimalDeps({
        metricsRegistry: metrics,
        isAllowed: vi.fn().mockReturnValue(false),
      });
      const update = createUpdate(99999);

      await handleDiag(update, deps);

      expect(metrics.increment).not.toHaveBeenCalledWith(
        "kbju_diag_invocations_total",
        expect.anything(),
      );
    });
  });

  describe("LLM pings", () => {
    it("calls chatCompletion with kbju.modality_router_classifier alias", async () => {
      const chatCompletion = vi.fn().mockResolvedValue({
        latencyMs: 50,
        outcome: "success",
      });
      const deps = createMinimalDeps({ chatCompletion });
      const update = createUpdate();

      await handleDiag(update, deps);

      expect(chatCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          call_type: "kbju.modality_router_classifier",
          max_tokens: 1,
        }),
      );
    });

    it("calls voiceTranscribe with kbju.voice_transcription alias", async () => {
      const voiceTranscribe = vi.fn().mockResolvedValue({
        latencyMs: 120,
        outcome: "success",
      });
      const audioProbe = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
      const deps = createMinimalDeps({ voiceTranscribe, audioProbe });
      const update = createUpdate();

      await handleDiag(update, deps);

      expect(voiceTranscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          call_type: "kbju.voice_transcription",
        }),
      );
    });

    it("reports latency in ms when LLM ping succeeds", async () => {
      const deps = createMinimalDeps({
        chatCompletion: vi.fn().mockResolvedValue({
          latencyMs: 42,
          outcome: "success",
        }),
      });
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("llm_ping_ms_default: 42");
    });
  });

  describe("DB queries", () => {
    it("queries last_event_id scoped to the requesting user", async () => {
      const db = createMockDb({ lastEventId: "event-uuid-001" });
      const deps = createMinimalDeps({ db });
      const update = createUpdate(12345);

      const result = await handleDiag(update, deps);

      // The query should have been called with the user's ID
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("outcome = 'success'"),
        ["12345"],
      );
      expect(result.text).toContain("last_event_id: event-uuid-001");
    });

    it("queries last_error_id scoped to the requesting user", async () => {
      const db = createMockDb({ lastErrorId: "error-uuid-002" });
      const deps = createMinimalDeps({ db });
      const update = createUpdate(12345);

      const result = await handleDiag(update, deps);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("outcome IN"),
        ["12345"],
      );
      expect(result.text).toContain("last_error_id: error-uuid-002");
    });
  });

  describe("formatDiagBlock", () => {
    it("formats a complete block with all fields", () => {
      const block: DiagBlock = {
        version: "0.1.0",
        build_sha: "abc123",
        started_at_utc: "2026-01-01T00:00:00Z",
        telegram_user_id: "42",
        last_event_id: "evt-001",
        last_error_id: "err-001",
        db_ping_ms: 5,
        llm_ping_ms_default: 42,
        llm_ping_ms_voice: 150,
        webhook_last_error_date: "2026-01-01T12:00:00.000Z",
        webhook_last_error_message: "Bad gateway",
        redaction_version: "1",
      };

      const formatted = formatDiagBlock(block);

      expect(formatted).toBe(
        [
          "--- KBJU diag ---",
          "version: 0.1.0",
          "build_sha: abc123",
          "started_at_utc: 2026-01-01T00:00:00Z",
          "telegram_user_id: 42",
          "last_event_id: evt-001",
          "last_error_id: err-001",
          "db_ping_ms: 5",
          "llm_ping_ms_default: 42",
          "llm_ping_ms_voice: 150",
          "webhook_last_error_date: 2026-01-01T12:00:00.000Z",
          "webhook_last_error_message: Bad gateway",
          "redaction_version: 1",
          "--- end ---",
        ].join("\n"),
      );
    });
  });

  describe("redactStringValue", () => {
    it("passes through clean strings unchanged", () => {
      expect(redactStringValue("0.1.0")).toBe("0.1.0");
      expect(redactStringValue("none")).toBe("none");
      expect(redactStringValue("n/a")).toBe("n/a");
      expect(redactStringValue("abc123def456")).toBe("abc123def456");
    });

    it("redacts Telegram bot tokens", () => {
      const val = "error: bot123456789:AAH_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx failed";
      const result = redactStringValue(val);
      expect(result).toContain("[TELEGRAM_TOKEN_REDACTED]");
      expect(result).not.toContain("AAH_");
    });

    it("redacts provider API keys (sk- prefix)", () => {
      const val = "using key sk-1234567890abcdef1234567890abcdef";
      const result = redactStringValue(val);
      expect(result).toContain("[PROVIDER_KEY_REDACTED]");
      expect(result).not.toContain("sk-1234567890");
    });

    it("redacts Bearer tokens", () => {
      const val = "Authorization: Bearer abc123def456ghi789jkl012";
      const result = redactStringValue(val);
      expect(result).toContain("[PROVIDER_KEY_REDACTED]");
      expect(result).not.toContain("abc123def456ghi789");
    });
  });

  describe("queryLastEventId / queryLastErrorId", () => {
    it("returns 'none' when no rows found", async () => {
      const db: TenantQueryable = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const result = await queryLastEventId(db, "user-1");
      expect(result).toBe("none");
    });

    it("returns the id when a row is found", async () => {
      const db: TenantQueryable = {
        query: vi.fn().mockResolvedValue({ rows: [{ id: "uuid-123" }] }),
      };

      const result = await queryLastEventId(db, "user-1");
      expect(result).toBe("uuid-123");
    });

    it("queryLastErrorId returns 'none' when no rows", async () => {
      const db: TenantQueryable = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const result = await queryLastErrorId(db, "user-1");
      expect(result).toBe("none");
    });

    it("queryLastErrorId returns the id when found", async () => {
      const db: TenantQueryable = {
        query: vi.fn().mockResolvedValue({ rows: [{ id: "err-uuid-456" }] }),
      };

      const result = await queryLastErrorId(db, "user-1");
      expect(result).toBe("err-uuid-456");
    });
  });

  describe("measureDbPing", () => {
    it("returns a non-negative latency", async () => {
      const db: TenantQueryable = {
        query: vi.fn().mockImplementation(async () => {
          return { rows: [] };
        }),
      };

      const ms = await measureDbPing(db);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(db.query).toHaveBeenCalledWith("SELECT 1");
    });
  });

  describe("measureLlmPingDefault", () => {
    it("returns latency when outcome is success", async () => {
      const chatCompletion = vi.fn().mockResolvedValue({
        latencyMs: 55,
        outcome: "success",
      });

      const result = await measureLlmPingDefault(chatCompletion);
      expect(result).toBe(55);
    });

    it("returns 'n/a' when provider is unreachable", async () => {
      const chatCompletion = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await measureLlmPingDefault(chatCompletion);
      expect(result).toBe("n/a");
    });
  });

  describe("measureLlmPingVoice", () => {
    it("returns latency when outcome is success", async () => {
      const voiceTranscribe = vi.fn().mockResolvedValue({
        latencyMs: 200,
        outcome: "success",
      });

      const result = await measureLlmPingVoice(voiceTranscribe, new Uint8Array([1, 2, 3]));
      expect(result).toBe(200);
    });

    it("returns 'n/a' when provider is unreachable", async () => {
      const voiceTranscribe = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await measureLlmPingVoice(voiceTranscribe, new Uint8Array([1, 2, 3]));
      expect(result).toBe("n/a");
    });
  });

  describe("webhook_last_error_date conversion", () => {
    it("converts Unix timestamp to ISO-8601", async () => {
      // 2024-05-26T00:00:00Z = 1716681600
      const cache = new FixedWebhookInfoCache({
        last_error_date: 1716681600,
        last_error_message: "test error",
        fetchedAtUtc: "2026-05-26T00:00:00.000Z",
      });
      const deps = createMinimalDeps({ webhookCache: cache });
      const update = createUpdate();

      const result = await handleDiag(update, deps);

      expect(result.text).toContain("webhook_last_error_date: 2024-05-26T00:00:00.000Z");
    });
  });
});
