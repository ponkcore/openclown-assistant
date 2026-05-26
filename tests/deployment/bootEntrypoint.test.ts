import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { createServer, stopServer, startServer, BRIDGE_VERSION } from "../../src/main.js";
import type { C1Deps, TelegramHandlers, NormalizedTelegramUpdate } from "../../src/telegram/types.js";
import type { RussianReplyEnvelope } from "../../src/shared/types.js";
import type { BridgeRequest } from "../../src/sidecar/types.js";
import { routeBridgeRequest } from "../../src/sidecar/seam.js";
import { readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { Allowlist, AllowlistSeedError } from "../../src/security/allowlist.js";
import { resolve } from "node:path";
import { runMigrations } from "../../src/store/migrations.js";

// Mock pg Pool so startServer never attempts a real TCP connection (TKT-041).
vi.mock("pg", () => {
  const mockPool = {
    query: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
  return { Pool: vi.fn(() => mockPool) };
});

// Default: runMigrations resolves (success path). Individual tests override.
vi.mock("../../src/store/migrations.js", () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
  TENANT_STORE_SCHEMA_COMPONENT: "C3 Tenant-Scoped Store",
  TENANT_STORE_SCHEMA_VERSION: "TKT-021@0.1.0",
  SchemaVersionError: class SchemaVersionError extends Error {},
  validateSchemaVersion: vi.fn().mockResolvedValue(undefined),
}));

const PORT = 32102;

interface FetchResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

function fetch(opts: {
  path: string;
  method: string;
  body?: unknown;
}): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: opts.path,
        method: opts.method,
        headers: {
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: data ? (JSON.parse(data) as Record<string, unknown>) : {},
          });
        });
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) {
      req.write(JSON.stringify(opts.body));
    }
    req.end();
  });
}

function makeStubHandler(): {
  handler: (update: NormalizedTelegramUpdate) => Promise<RussianReplyEnvelope>;
  calls: NormalizedTelegramUpdate[];
} {
  const calls: NormalizedTelegramUpdate[] = [];
  const handler = async (update: NormalizedTelegramUpdate): Promise<RussianReplyEnvelope> => {
    calls.push(update);
    return {
      chatId: update.telegramChatId,
      text: "Тестовый ответ шва C1",
      typingRenewalRequired: false,
    };
  };
  return { handler, calls };
}

function makeStubHandlers(): {
  handlers: TelegramHandlers;
  textMealCalls: NormalizedTelegramUpdate[];
  summaryDeliveryCalls: NormalizedTelegramUpdate[];
  callbackCalls: NormalizedTelegramUpdate[];
} {
  const textMeal = makeStubHandler();
  const summaryDelivery = makeStubHandler();
  const callback = makeStubHandler();
  const nullHandler = makeStubHandler();

  return {
    handlers: {
      start: nullHandler.handler,
      forgetMe: nullHandler.handler,
      textMeal: textMeal.handler,
      voiceMeal: nullHandler.handler,
      photoMeal: nullHandler.handler,
      history: nullHandler.handler,
      callback: callback.handler,
      summaryDelivery: summaryDelivery.handler,
    },
    textMealCalls: textMeal.calls,
    summaryDeliveryCalls: summaryDelivery.calls,
    callbackCalls: callback.calls,
  };
}

function makeC1Deps(
  handlers: TelegramHandlers,
  pilotUserIds: string[] = ["111", "222"]
): C1Deps {
  return {
    handlers,
    sendMessage: vi.fn(),
    sendChatAction: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      critical: vi.fn(),
    },
    pilotUserIds,
    metricsRegistry: {
      increment: vi.fn(),
      set: vi.fn(),
      observe: vi.fn(),
      getSamples: vi.fn().mockReturnValue([]),
      render: vi.fn().mockReturnValue(""),
    },
  };
}

describe("bootEntrypoint", () => {
  let server: ReturnType<typeof createServer>;
  const stubH = makeStubHandlers();
  const deps = makeC1Deps(stubH.handlers);

  beforeAll(async () => {
    process.env.TELEGRAM_PILOT_USER_IDS = "111,222";
    server = createServer({ pilotUserIds: ["111", "222"], deps });
    await new Promise<void>((resolve) => {
      server.listen(PORT, () => resolve());
    });
  });

  afterAll(async () => {
    await stopServer(server);
  });

  it("GET /kbju/health returns 200 with X-Kbju-Bridge-Version: 1.0 header", async () => {
    const result = await fetch({ path: "/kbju/health", method: "GET" });
    expect(result.status).toBe(200);
    expect(result.headers["x-kbju-bridge-version"]).toBe(BRIDGE_VERSION);
    expect(result.body.status).toBe("ok");
    expect(typeof result.body.uptime_seconds).toBe("number");
  });

  it("POST /kbju/message with missing fields returns 400 and error: invalid_request", async () => {
    const result = await fetch({
      path: "/kbju/message",
      method: "POST",
      body: { text: "hello" },
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_request");
  });

  it("POST /kbju/message for a blocked Telegram ID returns 403 and error: tenant_not_allowed", async () => {
    const result = await fetch({
      path: "/kbju/message",
      method: "POST",
      body: { telegram_id: 999, chat_id: 999, text: "hello" },
    });
    expect(result.status).toBe(403);
    expect(result.body.error).toBe("tenant_not_allowed");
    expect(result.body.telegram_id).toBe(999);
  });

  it("valid POST /kbju/message reaches C1 sidecar seam exactly once and returns Russian reply", async () => {
    stubH.textMealCalls.length = 0;

    const result = await fetch({
      path: "/kbju/message",
      method: "POST",
      body: {
        telegram_id: 111,
        chat_id: 111,
        text: "hello",
        message_id: 1001,
        source: "text",
      },
    });

    expect(result.status).toBe(200);
    expect(typeof result.body.reply_text).toBe("string");
    expect((result.body.reply_text as string).length).toBeGreaterThan(0);

    expect(stubH.textMealCalls.length).toBe(1);
    const call = stubH.textMealCalls[0];
    expect(call.telegramUserId).toBe(111);
    expect(call.telegramChatId).toBe(111);
    expect(call.routeKind).toBe("text_meal");
    expect(call.text).toBe("hello");
  });

  it("POST /kbju/callback reaches the callback handler through seam", async () => {
    stubH.callbackCalls.length = 0;

    const result = await fetch({
      path: "/kbju/callback",
      method: "POST",
      body: {
        callback_data: "confirm_meal:draft123",
        telegram_id: 111,
        chat_id: 111,
        message_id: 1002,
      },
    });

    expect(result.status).toBe(200);
    expect(stubH.callbackCalls.length).toBe(1);
    const call = stubH.callbackCalls[0];
    expect(call.routeKind).toBe("callback");
    expect(call.callbackData).toBe("confirm_meal:draft123");
  });

  it("POST /kbju/callback with missing telegram_id returns 400 invalid_request", async () => {
    const result = await fetch({
      path: "/kbju/callback",
      method: "POST",
      body: { callback_data: "confirm_meal:draft123" },
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_request");
  });

  it("POST /kbju/callback for blocked Telegram ID returns 403 and does not invoke handler", async () => {
    stubH.callbackCalls.length = 0;

    const result = await fetch({
      path: "/kbju/callback",
      method: "POST",
      body: {
        callback_data: "confirm_meal:draft123",
        telegram_id: 999,
        chat_id: 999,
      },
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toBe("tenant_not_allowed");
    expect(result.body.telegram_id).toBe(999);
    expect(stubH.callbackCalls.length).toBe(0);
  });

  it("valid callback still reaches callback handler exactly once", async () => {
    stubH.callbackCalls.length = 0;

    const result = await fetch({
      path: "/kbju/callback",
      method: "POST",
      body: {
        callback_data: "confirm_meal:draft456",
        telegram_id: 222,
        chat_id: 222,
        message_id: 1003,
      },
    });

    expect(result.status).toBe(200);
    expect(result.headers["x-kbju-bridge-version"]).toBe("1.0");
    expect(stubH.callbackCalls.length).toBe(1);
    const call = stubH.callbackCalls[0];
    expect(call.telegramUserId).toBe(222);
    expect(call.callbackData).toBe("confirm_meal:draft456");
  });

  it("oversized /kbju/message returns 413 payload_too_large and does not invoke handler", async () => {
    stubH.textMealCalls.length = 0;
    const bigText = "x".repeat(70 * 1024);

    const result = await fetch({
      path: "/kbju/message",
      method: "POST",
      body: { telegram_id: 111, chat_id: 111, text: bigText },
    });

    expect(result.status).toBe(413);
    expect(result.body.error).toBe("payload_too_large");
    expect(stubH.textMealCalls.length).toBe(0);
  });

  it("oversized /kbju/callback returns 413 payload_too_large and does not invoke handler", async () => {
    stubH.callbackCalls.length = 0;
    const bigData = "x".repeat(70 * 1024);

    const result = await fetch({
      path: "/kbju/callback",
      method: "POST",
      body: { telegram_id: 111, chat_id: 111, callback_data: bigData },
    });

    expect(result.status).toBe(413);
    expect(result.body.error).toBe("payload_too_large");
    expect(stubH.callbackCalls.length).toBe(0);
  });

  it("oversized /kbju/cron returns 413 payload_too_large and does not invoke handler", async () => {
    stubH.summaryDeliveryCalls.length = 0;
    const bigData = "x".repeat(70 * 1024);

    const result = await fetch({
      path: "/kbju/cron",
      method: "POST",
      body: { big: bigData },
    });

    expect(result.status).toBe(413);
    expect(result.body.error).toBe("payload_too_large");
    expect(stubH.summaryDeliveryCalls.length).toBe(0);
  });

  it("413 payload_too_large responses include X-Kbju-Bridge-Version: 1.0", async () => {
    const bigText = "x".repeat(70 * 1024);

    const result = await fetch({
      path: "/kbju/message",
      method: "POST",
      body: { telegram_id: 111, chat_id: 111, text: bigText },
    });

    expect(result.status).toBe(413);
    expect(result.headers["x-kbju-bridge-version"]).toBe("1.0");
  });

  it("POST /kbju/cron reaches the summaryDelivery handler through seam", async () => {
    stubH.summaryDeliveryCalls.length = 0;

    const result = await fetch({
      path: "/kbju/cron",
      method: "POST",
      body: { trigger_type: "daily_summary" },
    });

    expect(result.status).toBe(200);
    expect(stubH.summaryDeliveryCalls.length).toBe(1);
    const call = stubH.summaryDeliveryCalls[0];
    expect(call.routeKind).toBe("summary_delivery");
    expect(Array.isArray(result.body.summary_sent_to)).toBe(true);
    expect(result.body.skipped_count).toBe(0);
  });

  it("unknown route returns 404", async () => {
    const result = await fetch({ path: "/unknown", method: "GET" });
    expect(result.status).toBe(404);
    expect(result.body.error).toBe("not_found");
  });

  it("every sidecar response includes X-Kbju-Bridge-Version: 1.0", async () => {
    const result200 = await fetch({ path: "/kbju/health", method: "GET" });
    const result400 = await fetch({
      path: "/kbju/message",
      method: "POST",
      body: { text: "x" },
    });
    const result403 = await fetch({
      path: "/kbju/message",
      method: "POST",
      body: { telegram_id: 999, chat_id: 999 },
    });
    const result404 = await fetch({ path: "/unknown", method: "GET" });

    expect(result200.headers["x-kbju-bridge-version"]).toBe("1.0");
    expect(result400.headers["x-kbju-bridge-version"]).toBe("1.0");
    expect(result403.headers["x-kbju-bridge-version"]).toBe("1.0");
    expect(result404.headers["x-kbju-bridge-version"]).toBe("1.0");
  });
});

describe("C1 sidecar seam unit", () => {
  it("routeBridgeRequest calls textMeal handler for text source", async () => {
    const stubH = makeStubHandlers();
    const deps = makeC1Deps(stubH.handlers);

    const request: BridgeRequest = {
      telegram_id: 111,
      chat_id: 111,
      source: "text",
      text: "test message",
    };

    const reply = await routeBridgeRequest(deps, request);

    expect(reply).not.toBeNull();
    expect(reply!.text).toBe("Тестовый ответ шва C1");
    expect(stubH.textMealCalls.length).toBe(1);
    expect(stubH.textMealCalls[0].routeKind).toBe("text_meal");
    expect(stubH.textMealCalls[0].sourceLabel).toBe("bridge:text");
  });

  it("routeBridgeRequest calls summaryDelivery handler for cron source", async () => {
    const stubH = makeStubHandlers();
    const deps = makeC1Deps(stubH.handlers);

    const request: BridgeRequest = {
      telegram_id: 0,
      chat_id: 0,
      source: "cron",
      trigger_type: "daily_summary",
    };

    const reply = await routeBridgeRequest(deps, request);

    expect(reply).not.toBeNull();
    expect(stubH.summaryDeliveryCalls.length).toBe(1);
    expect(stubH.summaryDeliveryCalls[0].routeKind).toBe("summary_delivery");
    expect(stubH.summaryDeliveryCalls[0].sourceLabel).toBe("bridge:cron");
  });

  it("routeBridgeRequest returns null for unsupported source", async () => {
    const stubH = makeStubHandlers();
    const deps = makeC1Deps(stubH.handlers);

    const request: BridgeRequest = {
      telegram_id: 111,
      chat_id: 111,
      source: "text",
      text: "",
    } as BridgeRequest;

    const typedRequest = { ...request, source: "unknown" } as unknown as BridgeRequest;
    // bridgeToRouteKind will return "unsupported" for unknown
    const reply = await routeBridgeRequest(deps, typedRequest);

    expect(reply).toBeNull();
  });
});
// ── TKT-041: Boot migration wiring tests ──────────────────────────────────
//
// Per ARCH-001@0.7.0 §11.1: mandatory boot-smoke test.
// Two assertions from TKT-041 §2:
//   (a) On a fresh DB, runMigrations applies all migrations (verified via
//       schema-string assertion since testcontainers/pg-mem are not available).
//   (b) When runMigrations throws, the server does NOT call server.listen.

const prd003Tables = [
  "water_events",
  "sleep_records",
  "sleep_pairing_state",
  "workout_events",
  "mood_events",
  "modality_settings",
  "modality_settings_audit",
] as const;

const mockRunMigrations = vi.mocked(runMigrations);

describe("TKT-041: runMigrations on boot", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot original env vars so we can restore
    for (const key of [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_PILOT_USER_IDS",
      "DATABASE_URL",
      "POSTGRES_PASSWORD",
      "OMNIROUTE_BASE_URL",
      "OMNIROUTE_API_KEY",
      "FIREWORKS_API_KEY",
      "USDA_FDC_API_KEY",
      "PERSONA_PATH",
      "PO_ALERT_CHAT_ID",
      "MONTHLY_SPEND_CEILING_USD",
      "AUDIT_DB_URL",
      "SERVER_PORT",
    ]) {
      origEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    // Restore env
    for (const [key, val] of Object.entries(origEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it("schema.sql + migrations/*.sql together define all seven PRD-003@0.1.3 tables", () => {
    // Schema-string assertion: the combined SQL that runMigrations would
    // apply (schema.sql + migrations/*.sql) must define all seven PRD-003
    // modality tables. This is the lightweight alternative to a real-PG
    // integration test (no testcontainers/pg-mem available in v0.1).
    const schemaSql = readFileSync(
      resolve(process.cwd(), "src/store/schema.sql"),
      "utf8"
    );

    // Collect migration file SQL
    const migrationsDir = resolve(process.cwd(), "migrations");
    let migrationSql = "";
    try {
      const entries = readdirSync(migrationsDir)
        .filter((e) => e.endsWith(".sql"))
        .sort();
      for (const entry of entries) {
        migrationSql += readFileSync(resolve(migrationsDir, entry), "utf8");
      }
    } catch {
      // migrations/ is optional; schema.sql is the source of truth
    }

    const combinedSql = schemaSql + "\n" + migrationSql;

    for (const table of prd003Tables) {
      expect(combinedSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("on migration failure, startServer does NOT call server.listen and exits non-zero", async () => {
    // Make runMigrations throw to simulate a partial migration failure
    mockRunMigrations.mockRejectedValueOnce(new Error("simulated migration failure"));

    const mockExit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      // Prevent actual exit; throw to short-circuit the async flow
      throw new Error(`process.exit:${code ?? 0}`);
    });

    // Set up required env vars for parseConfig to succeed
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_PILOT_USER_IDS = "111";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";
    process.env.POSTGRES_PASSWORD = "testpw";
    process.env.OMNIROUTE_BASE_URL = "http://localhost:4000";
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.FIREWORKS_API_KEY = "test-fw-key";
    process.env.USDA_FDC_API_KEY = "test-usda-key";
    process.env.PERSONA_PATH = "/tmp/test-persona.md";
    process.env.PO_ALERT_CHAT_ID = "12345";
    process.env.MONTHLY_SPEND_CEILING_USD = "10";
    process.env.AUDIT_DB_URL = "postgresql://user:pass@localhost:5432/audit";
    process.env.SERVER_PORT = "0";

    // Spy on server.listen to verify it is NOT called
    const listenSpy = vi.spyOn(http.Server.prototype, "listen");

    try {
      await startServer();
      // If we reach here, startServer didn't exit — that's a failure
      expect.unreachable("startServer should have exited due to migration failure");
    } catch (err: unknown) {
      // The process.exit(1) mock throws; verify the right code was used
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("process.exit:1");
      expect(mockExit).toHaveBeenCalledWith(1);
      // server.listen must NOT have been called
      expect(listenSpy).not.toHaveBeenCalled();
    } finally {
      mockExit.mockRestore();
      listenSpy.mockRestore();
      mockRunMigrations.mockReset();
      mockRunMigrations.mockResolvedValue(undefined);
    }
  });

  it("on successful migration, startServer calls runMigrations then server.listen", async () => {
    // runMigrations succeeds (default mock)
    mockRunMigrations.mockResolvedValueOnce(undefined);

    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("unexpected process.exit");
    });

    // Set up required env vars
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_PILOT_USER_IDS = "111";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";
    process.env.POSTGRES_PASSWORD = "testpw";
    process.env.OMNIROUTE_BASE_URL = "http://localhost:4000";
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.FIREWORKS_API_KEY = "test-fw-key";
    process.env.USDA_FDC_API_KEY = "test-usda-key";
    process.env.PERSONA_PATH = "/tmp/test-persona.md";
    process.env.PO_ALERT_CHAT_ID = "12345";
    process.env.MONTHLY_SPEND_CEILING_USD = "10";
    process.env.AUDIT_DB_URL = "postgresql://user:pass@localhost:5432/audit";
    process.env.SERVER_PORT = "0";

    let server: http.Server | null = null;
    try {
      server = await startServer();

      // runMigrations must have been called
      expect(mockRunMigrations).toHaveBeenCalledTimes(1);
      // server should be listening (startServer resolves after listen callback)
      expect(server.listening).toBe(true);
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => (err ? reject(err) : resolve()));
        });
      }
      mockExit.mockRestore();
      mockRunMigrations.mockReset();
      mockRunMigrations.mockResolvedValue(undefined);
    }
  });
});

  it("on migration timeout, startServer does NOT call server.listen and exits non-zero", async () => {
    // Simulate a migration that exceeds the timeout budget.
    // Use KBJU_MIGRATION_TIMEOUT_MS env var to lower the timeout to 50 ms
    // so the test completes quickly without waiting 120 s.
    process.env.KBJU_MIGRATION_TIMEOUT_MS = "50";

    // Make runMigrations return a promise that never resolves within the budget
    mockRunMigrations.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 10_000)) // 10 s — well over 50 ms budget
    );

    const mockExit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });

    // Set up required env vars
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_PILOT_USER_IDS = "111";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";
    process.env.POSTGRES_PASSWORD = "testpw";
    process.env.OMNIROUTE_BASE_URL = "http://localhost:4000";
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.FIREWORKS_API_KEY = "test-fw-key";
    process.env.USDA_FDC_API_KEY = "test-usda-key";
    process.env.PERSONA_PATH = "/tmp/test-persona.md";
    process.env.PO_ALERT_CHAT_ID = "12345";
    process.env.MONTHLY_SPEND_CEILING_USD = "10";
    process.env.AUDIT_DB_URL = "postgresql://user:pass@localhost:5432/audit";
    process.env.SERVER_PORT = "0";

    const listenSpy = vi.spyOn(http.Server.prototype, "listen");

    try {
      await startServer();
      expect.unreachable("startServer should have exited due to migration timeout");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("process.exit:1");
      expect(mockExit).toHaveBeenCalledWith(1);
      // server.listen must NOT have been called
      expect(listenSpy).not.toHaveBeenCalled();
    } finally {
      mockExit.mockRestore();
      listenSpy.mockRestore();
      mockRunMigrations.mockReset();
      mockRunMigrations.mockResolvedValue(undefined);
      delete process.env.KBJU_MIGRATION_TIMEOUT_MS;
    }
  });



// Mock the Allowlist module so we can control when AllowlistSeedError is thrown.
// The real Allowlist constructor accesses the filesystem (config/allowlist.json)
// which may or may not exist in the test environment, making tests flaky.
const mockAllowlistSeedError = AllowlistSeedError;
vi.mock("../../src/security/allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/security/allowlist.js")>();
  return {
    ...actual,
    Allowlist: vi.fn(),
    AllowlistSeedError: actual.AllowlistSeedError,
  };
});

describe("BACKLOG-004: AllowlistSeedError in boot path", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_PILOT_USER_IDS",
      "DATABASE_URL",
      "POSTGRES_PASSWORD",
      "OMNIROUTE_BASE_URL",
      "OMNIROUTE_API_KEY",
      "FIREWORKS_API_KEY",
      "USDA_FDC_API_KEY",
      "PERSONA_PATH",
      "PO_ALERT_CHAT_ID",
      "MONTHLY_SPEND_CEILING_USD",
      "AUDIT_DB_URL",
      "SERVER_PORT",
    ]) {
      origEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(origEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    vi.mocked(Allowlist).mockReset();
  });

  it("when Allowlist constructor throws AllowlistSeedError, startServer exits non-zero within 5 s", async () => {
    // Simulate the misconfig scenario: the Allowlist constructor throws
    // AllowlistSeedError when neither file nor env var provides valid IDs.
    vi.mocked(Allowlist).mockImplementationOnce(() => {
      throw new mockAllowlistSeedError(
        "Allowlist misconfiguration: config/allowlist.json is missing and TELEGRAM_PILOT_USER_IDS is unset"
      );
    });

    // Set up all required env vars so parseConfig succeeds
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_PILOT_USER_IDS = "111";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";
    process.env.POSTGRES_PASSWORD = "testpw";
    process.env.OMNIROUTE_BASE_URL = "http://localhost:4000";
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.FIREWORKS_API_KEY = "test-fw-key";
    process.env.USDA_FDC_API_KEY = "test-usda-key";
    process.env.PERSONA_PATH = "/tmp/test-persona.md";
    process.env.PO_ALERT_CHAT_ID = "12345";
    process.env.MONTHLY_SPEND_CEILING_USD = "10";
    process.env.AUDIT_DB_URL = "postgresql://user:pass@localhost:5432/audit";
    process.env.SERVER_PORT = "0";

    const mockExit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error("process.exit:" + String(code ?? 0));
    });

    const listenSpy = vi.spyOn(http.Server.prototype, "listen");

    try {
      await startServer();
      expect.unreachable("startServer should have exited due to AllowlistSeedError");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Must exit with code 1
      expect(msg).toContain("process.exit:1");
      expect(mockExit).toHaveBeenCalledWith(1);
      // server.listen must NOT have been called
      expect(listenSpy).not.toHaveBeenCalled();
    } finally {
      mockExit.mockRestore();
      listenSpy.mockRestore();
      mockRunMigrations.mockReset();
      mockRunMigrations.mockResolvedValue(undefined);
    }
  });

  it("when Allowlist constructor succeeds, startServer proceeds to server.listen", async () => {
    // Simulate the success scenario: Allowlist constructor returns a valid object.
    vi.mocked(Allowlist).mockImplementationOnce(() => ({
      isAllowed: vi.fn().mockReturnValue(true),
      getMode: vi.fn().mockReturnValue("normal"),
      getSize: vi.fn().mockReturnValue(1),
      close: vi.fn(),
    }) as unknown as InstanceType<typeof Allowlist>);

    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_PILOT_USER_IDS = "111";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/testdb";
    process.env.POSTGRES_PASSWORD = "testpw";
    process.env.OMNIROUTE_BASE_URL = "http://localhost:4000";
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.FIREWORKS_API_KEY = "test-fw-key";
    process.env.USDA_FDC_API_KEY = "test-usda-key";
    process.env.PERSONA_PATH = "/tmp/test-persona.md";
    process.env.PO_ALERT_CHAT_ID = "12345";
    process.env.MONTHLY_SPEND_CEILING_USD = "10";
    process.env.AUDIT_DB_URL = "postgresql://user:pass@localhost:5432/audit";
    process.env.SERVER_PORT = "0";

    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("unexpected process.exit");
    });

    let server: http.Server | null = null;
    try {
      server = await startServer();

      // runMigrations must have been called
      expect(mockRunMigrations).toHaveBeenCalledTimes(1);
      // server should be listening
      expect(server.listening).toBe(true);
      // Allowlist constructor must have been called
      expect(Allowlist).toHaveBeenCalled();
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => (err ? reject(err) : resolve()));
        });
      }
      mockExit.mockRestore();
      mockRunMigrations.mockReset();
      mockRunMigrations.mockResolvedValue(undefined);
    }
  });
});
