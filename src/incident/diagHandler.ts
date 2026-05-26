/**
 * IncidentDiagnostic handler — Telegram `/diag` command
 *
 * Per ADR-021@0.1.0 §`/diag` command contract: returns a plain-text
 * diagnostic block that the user can forward to the operator.
 *
 * All field values pass through the existing redactPii allowlist
 * (TKT-015@0.1.0 + TKT-026@0.1.0); never include raw user text,
 * raw secrets, raw provider responses.
 *
 * Field set (character-for-character per ADR-021@0.1.0):
 *   version, build_sha, started_at_utc, telegram_user_id,
 *   last_event_id, last_error_id, db_ping_ms,
 *   llm_ping_ms_default, llm_ping_ms_voice,
 *   webhook_last_error_date, webhook_last_error_message,
 *   redaction_version
 */

import type { NormalizedTelegramUpdate } from "../telegram/types.js";
import type { RussianReplyEnvelope } from "../shared/types.js";
import { redactPii } from "../observability/events.js";
import { LOG_SCHEMA_VERSION } from "../observability/kpiEvents.js";
import { sha256Half } from "../observability/breachDetector.js";
import type { WebhookInfoCache } from "../observability/webhookInfoCache.js";
import type { MetricsRegistry } from "../observability/metricsEndpoint.js";
import type { TenantQueryable } from "../store/tenantStore.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Audio probe (1-second WAV bundled at build time) ─────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_PROBE_PATH = path.resolve(__dirname, "fixtures", "diag-probe.wav");

/** Load the project-bundled 1-second audio probe for the voice ping. */
export function loadAudioProbe(): Uint8Array {
  return new Uint8Array(readFileSync(AUDIO_PROBE_PATH));
}

// ── Blocked-user message (exact copy from C1 entrypoint) ─────────────────

const MSG_BLOCKED_USER = "Извините, бот пока в закрытом тестировании.";

// ── Diag block field type ─────────────────────────────────────────────────

export interface DiagBlock {
  version: string;
  build_sha: string;
  started_at_utc: string;
  telegram_user_id: string;
  last_event_id: string;
  last_error_id: string;
  db_ping_ms: number | string;
  llm_ping_ms_default: number | string;
  llm_ping_ms_voice: number | string;
  webhook_last_error_date: string;
  webhook_last_error_message: string;
  redaction_version: string;
}

// ── Dependencies (injected for testability) ───────────────────────────────

export interface DiagDeps {
  /** Read package.json version */
  appVersion: string;
  /** BUILD_SHA env var (baked at Dockerfile build time) */
  buildSha: string;
  /** Server start timestamp (ISO-8601) */
  startedAtUtc: string;
  /** DB pool for SELECT 1 ping and metric_events queries */
  db: TenantQueryable;
  /** LLM chatCompletion for kbju.modality_router_classifier ping */
  chatCompletion: (opts: {
    call_type: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens: number;
  }) => Promise<{ latencyMs: number; outcome: string }>;
  /** Voice transcription for kbju.voice_transcription ping */
  voiceTranscribe: (opts: {
    call_type: string;
    audio_buffer: Uint8Array;
    audio_mime: string;
    audio_filename: string;
  }) => Promise<{ latencyMs: number; outcome: string }>;
  /** Webhook info cache (60-s background poll) */
  webhookCache: WebhookInfoCache;
  /** Allowlist: is this user allowed? */
  isAllowed: (telegramUserId: number) => boolean;
  /** Metrics registry for kbju_diag_invocations_total */
  metricsRegistry: MetricsRegistry;
  /** 1-second audio probe (project-bundled fixture) */
  audioProbe: Uint8Array;
}

// ── Queries ───────────────────────────────────────────────────────────────

const LAST_EVENT_SQL = `
  SELECT id FROM metric_events
  WHERE user_id = $1
    AND outcome = 'success'
    AND created_at >= NOW() - INTERVAL '24 hours'
  ORDER BY created_at DESC
  LIMIT 1
`;

const LAST_ERROR_SQL = `
  SELECT id FROM metric_events
  WHERE user_id = $1
    AND outcome IN ('provider_failure', 'validation_blocked', 'budget_blocked')
    AND created_at >= NOW() - INTERVAL '24 hours'
  ORDER BY created_at DESC
  LIMIT 1
`;

// ── Internal helpers (exported for unit-testing) ──────────────────────────

export async function queryLastEventId(
  db: TenantQueryable,
  userId: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(LAST_EVENT_SQL, [userId]);
  if (result.rows.length === 0) return "none";
  return result.rows[0].id;
}

export async function queryLastErrorId(
  db: TenantQueryable,
  userId: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(LAST_ERROR_SQL, [userId]);
  if (result.rows.length === 0) return "none";
  return result.rows[0].id;
}

export async function measureDbPing(db: TenantQueryable): Promise<number> {
  const start = Date.now();
  await db.query("SELECT 1");
  return Date.now() - start;
}

export async function measureLlmPingDefault(
  chatCompletion: DiagDeps["chatCompletion"],
): Promise<number | string> {
  try {
    const result = await chatCompletion({
      call_type: "kbju.modality_router_classifier",
      messages: [{ role: "user", content: "ok" }],
      max_tokens: 1,
    });
    if (result.outcome !== "success") return "n/a";
    return result.latencyMs;
  } catch {
    return "n/a";
  }
}

export async function measureLlmPingVoice(
  voiceTranscribe: DiagDeps["voiceTranscribe"],
  audioProbe: Uint8Array,
): Promise<number | string> {
  try {
    const result = await voiceTranscribe({
      call_type: "kbju.voice_transcription",
      audio_buffer: audioProbe,
      audio_mime: "audio/wav",
      audio_filename: "diag-probe.wav",
    });
    if (result.outcome !== "success") return "n/a";
    return result.latencyMs;
  } catch {
    return "n/a";
  }
}

// ── Redaction ─────────────────────────────────────────────────────────────

/**
 * Apply the existing redactPii PII regex patterns to a single string value.
 *
 * Strategy: wrap the value under an `ALLOWED_EXTRA_KEYS` key (`error_code`)
 * so redactPii preserves it, then extract the redacted result.
 * Numeric values pass through unchanged — they carry no PII.
 */
export function redactStringValue(value: string): string {
  // Use `error_code` — it is in ALLOWED_EXTRA_KEYS and is typically
  // a short string, so it's a safe carrier key.
  const wrapped = redactPii({ error_code: value });
  const redacted = wrapped.error_code;
  return typeof redacted === "string" ? redacted : value;
}

/**
 * Apply redactPii to each field value. Numeric values pass through
 * unchanged (they're not PII-bearing). String values are redacted
 * via redactStringValue.
 */
export function redactBlock(block: DiagBlock): DiagBlock {
  const result: DiagBlock = { ...block };
  for (const key of Object.keys(block) as Array<keyof DiagBlock>) {
    const value = block[key];
    if (typeof value === "string") {
      result[key] = redactStringValue(value) as never;
    }
    // Numeric values (db_ping_ms when it's a number) need no redaction
  }
  return result;
}

// ── Format ────────────────────────────────────────────────────────────────

export function formatDiagBlock(block: DiagBlock): string {
  const lines = [
    "--- KBJU diag ---",
    `version: ${block.version}`,
    `build_sha: ${block.build_sha}`,
    `started_at_utc: ${block.started_at_utc}`,
    `telegram_user_id: ${block.telegram_user_id}`,
    `last_event_id: ${block.last_event_id}`,
    `last_error_id: ${block.last_error_id}`,
    `db_ping_ms: ${block.db_ping_ms}`,
    `llm_ping_ms_default: ${block.llm_ping_ms_default}`,
    `llm_ping_ms_voice: ${block.llm_ping_ms_voice}`,
    `webhook_last_error_date: ${block.webhook_last_error_date}`,
    `webhook_last_error_message: ${block.webhook_last_error_message}`,
    `redaction_version: ${block.redaction_version}`,
    "--- end ---",
  ];
  return lines.join("\n");
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function handleDiag(
  update: NormalizedTelegramUpdate,
  deps: DiagDeps,
): Promise<RussianReplyEnvelope> {
  const userId = String(update.telegramUserId);
  const requestId = update.requestId;

  // Allowlist gate — non-allowlisted users get the standard "not allowed" copy
  if (!deps.isAllowed(update.telegramUserId)) {
    return {
      chatId: update.telegramChatId,
      text: MSG_BLOCKED_USER,
      typingRenewalRequired: false,
    };
  }

  // Metric: kbju_diag_invocations_total{telegram_user_id_hashed}
  const hashedUserId = sha256Half(`${userId}:${requestId}`);
  deps.metricsRegistry.increment(
    "kbju_diag_invocations_total" as never,
    { telegram_user_id_hashed: hashedUserId },
  );

  // Collect all fields in parallel where possible
  const [
    lastEventId,
    lastErrorId,
    dbPingMs,
    llmPingMsDefault,
    llmPingMsVoice,
  ] = await Promise.all([
    queryLastEventId(deps.db, userId).catch(() => "none"),
    queryLastErrorId(deps.db, userId).catch(() => "none"),
    measureDbPing(deps.db).catch(() => -1),
    measureLlmPingDefault(deps.chatCompletion),
    measureLlmPingVoice(deps.voiceTranscribe, deps.audioProbe),
  ]);

  // Webhook info from cache (no fresh API call)
  const webhookInfo = deps.webhookCache.getCachedInfo();
  const webhookLastErrorDate = webhookInfo.last_error_date
    ? new Date(webhookInfo.last_error_date * 1000).toISOString()
    : "none";
  const webhookLastErrorMessage = webhookInfo.last_error_message ?? "none";

  const block: DiagBlock = {
    version: deps.appVersion,
    build_sha: deps.buildSha || "unknown",
    started_at_utc: deps.startedAtUtc,
    telegram_user_id: userId,
    last_event_id: lastEventId,
    last_error_id: lastErrorId,
    db_ping_ms: dbPingMs < 0 ? "n/a" : dbPingMs,
    llm_ping_ms_default: llmPingMsDefault,
    llm_ping_ms_voice: llmPingMsVoice,
    webhook_last_error_date: webhookLastErrorDate,
    webhook_last_error_message: webhookLastErrorMessage,
    redaction_version: LOG_SCHEMA_VERSION,
  };

  // Redact all string fields through redactPii
  const redactedBlock = redactBlock(block);

  // Format as plain text — NO Markdown, NO parse_mode
  return {
    chatId: update.telegramChatId,
    text: formatDiagBlock(redactedBlock),
    typingRenewalRequired: false,
  };
}
