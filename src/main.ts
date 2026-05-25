import http from "node:http";
import { parseConfig } from "./shared/config.js";
import { createSidecarDeps } from "./sidecar/factory.js";
import { routeBridgeRequest } from "./sidecar/seam.js";
import { setMetricsRegistry } from "./deployment/healthCheck.js";
import type { BridgeRequest } from "./sidecar/types.js";
import type { C1Deps } from "./telegram/types.js";

import { runMigrations } from "./store/migrations.js";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";

const SERVER_PORT_DEFAULT = 3000;
const BRIDGE_VERSION = "1.0";

let startTime = 0;
let pilotUserIds: string[] = [];
let deps: C1Deps | null = null;

function resolvePort(): number {
  const raw = process.env.SERVER_PORT;
  if (!raw) return SERVER_PORT_DEFAULT;
  const p = parseInt(raw, 10);
  return Number.isFinite(p) && p > 0 ? p : SERVER_PORT_DEFAULT;
}

function isAllowlisted(telegramIdStr: string): boolean {
  return pilotUserIds.includes(telegramIdStr);
}

function jsonResponse(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "X-Kbju-Bridge-Version": BRIDGE_VERSION,
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const MAX_BODY_SIZE = 64 * 1024;

type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; oversized: true };

function readBody(req: http.IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    let overflow = false;

    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        overflow = true;
        data = "";
        return;
      }
      data += chunk.toString();
    });
    req.on("end", () => {
      if (overflow) {
        resolve({ ok: false, oversized: true });
        return;
      }
      if (!data) {
        resolve({ ok: true, body: {} });
        return;
      }
      try {
        resolve({ ok: true, body: JSON.parse(data) as Record<string, unknown> });
      } catch {
        resolve({ ok: true, body: { _parse_error: true } });
      }
    });
    req.on("error", reject);
  });
}

async function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const uptime = startTime > 0 ? Math.floor((Date.now() - startTime) / 1000) : 0;
  const breachCount = deps?.breachDetector?.getBreachCountLastHour() ?? 0;
  jsonResponse(res, 200, {
    status: "ok",
    uptime_seconds: uptime,
    tenant_count: pilotUserIds.length,
    breach_count_last_hour: breachCount,
    stall_count_last_hour: 0,
  });
}

function toBridgeRequest(body: Record<string, unknown>): BridgeRequest | null {
  const telegram_id = body.telegram_id as number | undefined;
  const chat_id = body.chat_id as number | undefined;
  const source = (body.source as string) ?? "text";

  if (!telegram_id || !chat_id) {
    return null;
  }

  return {
    telegram_id,
    chat_id,
    source: source as BridgeRequest["source"],
    text: (body.text as string) ?? undefined,
    message_id: body.message_id as number | undefined,
    callback_data: body.callback_data as string | undefined,
    trigger_type: body.trigger_type as string | undefined,
  };
}

async function handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const result = await readBody(req);
  if (!result.ok) {
    jsonResponse(res, 413, { error: "payload_too_large" });
    return;
  }
  const bridgeReq = toBridgeRequest(result.body);

  if (!bridgeReq) {
    jsonResponse(res, 400, {
      error: "invalid_request",
      detail: "missing required fields: telegram_id, chat_id",
    });
    return;
  }

  const idStr = String(bridgeReq.telegram_id);
  if (!isAllowlisted(idStr)) {
    jsonResponse(res, 403, {
      error: "tenant_not_allowed",
      telegram_id: bridgeReq.telegram_id,
    });
    return;
  }

  const effectiveDeps = deps ?? createSidecarDeps(pilotUserIds);
  const reply = await routeBridgeRequest(effectiveDeps, bridgeReq);

  if (reply) {
    jsonResponse(res, 200, {
      reply_text: reply.text,
      typing_renewal_required: reply.typingRenewalRequired,
      reply_markup: reply.replyMarkup,
      ...(bridgeReq.message_id ? { reply_to_message_id: bridgeReq.message_id } : {}),
    });
  } else {
    jsonResponse(res, 200, {
      reply_text: "Привет! Отправь описание еды, и я помогу.",
      typing_renewal_required: false,
    });
  }
}

async function handleCallback(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const result = await readBody(req);
  if (!result.ok) {
    jsonResponse(res, 413, { error: "payload_too_large" });
    return;
  }

  const bridgeReq = toBridgeRequest({ ...result.body, source: "callback" });
  if (!bridgeReq) {
    jsonResponse(res, 400, {
      error: "invalid_request",
      detail: "missing required fields: telegram_id, chat_id",
    });
    return;
  }

  const idStr = String(bridgeReq.telegram_id);
  if (!isAllowlisted(idStr)) {
    jsonResponse(res, 403, {
      error: "tenant_not_allowed",
      telegram_id: bridgeReq.telegram_id,
    });
    return;
  }

  const effectiveDeps = deps ?? createSidecarDeps(pilotUserIds);
  const reply = await routeBridgeRequest(effectiveDeps, bridgeReq);
  jsonResponse(res, 200, {
    reply_text: reply?.text ?? "Обработано.",
    edit_message_id: result.body.message_id ?? undefined,
  });
}

async function handleCron(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const result = await readBody(req);
  if (!result.ok) {
    jsonResponse(res, 413, { error: "payload_too_large" });
    return;
  }

  const effectiveDeps = deps ?? createSidecarDeps(pilotUserIds);

  const bridgeReq: BridgeRequest = {
    telegram_id: 0,
    chat_id: 0,
    source: "cron",
    trigger_type: "daily_summary",
  };

  const reply = await routeBridgeRequest(effectiveDeps, bridgeReq);
  jsonResponse(res, 200, {
    reply_text: reply?.text ?? "",
    summary_sent_to: pilotUserIds.map((id) => parseInt(id, 10)).filter((n) => Number.isFinite(n)),
    skipped_count: 0,
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/kbju/health") {
    await handleHealth(req, res);
    return;
  }

  if (method === "POST" && url === "/kbju/message") {
    await handleMessage(req, res);
    return;
  }

  if (method === "POST" && url === "/kbju/callback") {
    await handleCallback(req, res);
    return;
  }

  if (method === "POST" && url === "/kbju/cron") {
    await handleCron(req, res);
    return;
  }

  jsonResponse(res, 404, { error: "not_found" });
}

export interface ServerOptions {
  pilotUserIds?: string[];
  deps?: C1Deps;
}

export function createServer(opts?: ServerOptions): http.Server {
  if (opts?.pilotUserIds) {
    pilotUserIds = opts.pilotUserIds;
  }
  if (opts?.deps) {
    deps = opts.deps;
  }
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        jsonResponse(res, 500, {
          error: "internal_error",
          request_id: "unknown",
        });
      }
    });
  });
}

export async function startServer(): Promise<http.Server> {
  let config: ReturnType<typeof parseConfig> | null = null;
  try {
    config = parseConfig(process.env as Record<string, string | undefined>);
    pilotUserIds = config.telegramPilotUserIds;
  } catch {
    pilotUserIds = [];
    console.warn("Config parse failed; allowlist is empty. Sidecar will reject all requests.");
  }

  const port = resolvePort();

  // Apply database migrations before starting the HTTP server.
  // Per TKT-041: on migration failure, log structured error and exit
  // non-zero — never start the HTTP server with a partially-applied schema.
  if (config?.databaseUrl) {
    const pool = new Pool({ connectionString: config.databaseUrl });
    try {
      await runMigrations(pool);
    } catch (err: unknown) {
      console.error("Migration failed; refusing to start HTTP server:", err);
      await pool.end().catch(() => {});
      process.exit(1);
    }
  }

  const server = createServer();
  // Wire the shared metrics registry into the /metrics endpoint
  if (!deps) {
    deps = createSidecarDeps(pilotUserIds);
  }
  setMetricsRegistry(deps.metricsRegistry);
  startTime = Date.now();

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`KBJU sidecar listening on port ${port}`);
      resolve(server);
    });
  });
}

export function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Self-invoke only when run as the main entry point (e.g. Dockerfile CMD).
// Prevents the side-effect of starting the server when the module is
// imported by test files.
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  startServer().catch((err: unknown) => {
    console.error("Boot failed:", err);
    process.exit(1);
  });
}

export { BRIDGE_VERSION };