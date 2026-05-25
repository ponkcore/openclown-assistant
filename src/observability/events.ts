import type { OpenClawLogger } from "../shared/types.js";
import type { ComponentId, MetricOutcome } from "../shared/types.js";
import {
  LOG_SCHEMA_VERSION,
  LOG_FORBIDDEN_FIELDS,
  type KpiEventName,
} from "./kpiEvents.js";

type LogLevel = "info" | "warn" | "error" | "critical";

export interface ObservabilityEvent {
  timestamp_utc: string;
  level: LogLevel;
  service: string;
  component: ComponentId;
  event_name: KpiEventName | string;
  request_id: string;
  user_id: string;
  outcome: MetricOutcome | string;
  degrade_mode_enabled: boolean;
  schema_version: string;
  telegram_message_id_hash?: string;
  source?: string;
  latency_ms?: number;
  provider_alias?: string;
  model_alias?: string;
  estimated_cost_usd?: number;
  error_code?: string;
  [key: string]: unknown;
}

const PII_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b\d{8,10}:\S{30,}\b/g, "[TELEGRAM_TOKEN_REDACTED]"],
  [/bot\d{8,10}:[A-Za-z0-9_-]{30,}/g, "[TELEGRAM_TOKEN_REDACTED]"],
  [/sk-[A-Za-z0-9]{20,}/g, "[PROVIDER_KEY_REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, "[PROVIDER_KEY_REDACTED]"],
  [/API_KEY[=:]\s*\S+/gi, "[PROVIDER_KEY_REDACTED]"],
  [/audio_duration_seconds.*?raw_audio/g, "[AUDIO_MARKER_REDACTED]"],
  [/raw_audio.*?(bytes|clip|file)/gi, "[AUDIO_MARKER_REDACTED]"],
  [/raw_photo.*?(bytes|file|image)/gi, "[PHOTO_MARKER_REDACTED]"],
];

const ALLOWED_EXTRA_KEYS: readonly string[] = [
  "call_type",
  "component",
  "model_alias",
  "provider_alias",
  "outcome",
  "estimated_cost_usd",
  "duration_ms",
  "error_code",
  "tenant_id",
  "period_type",
  "source",
  "latency_ms",
  "telegram_message_id_hash",
  "degrade_mode_enabled",
  "message_subtype",
  "threshold_ms",
  "actual_stall_ms",
  "retry_count",
  "kill_switch_path",
  "modality",
  "volume_ml",
  "duration_min",
  "distance_km",
  "score",
  "is_nap",
  "attribution_date_local",
  "event_id",
];

const CORE_EVENT_KEYS: readonly string[] = [
  "timestamp_utc",
  "level",
  "service",
  "component",
  "event_name",
  "request_id",
  "user_id",
  "outcome",
  "degrade_mode_enabled",
  "schema_version",
];

// F-M4: allowlist fully closes free-text leak surface; no Cyrillic regex needed (high false-positive risk avoided)

function redactStringValues(value: string): string {
  let result = value;
  for (const [pattern, replacement] of PII_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function redactPii(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!ALLOWED_EXTRA_KEYS.includes(key)) {
      continue;
    }
    if (typeof value === "string") {
      result[key] = redactStringValues(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "string"
          ? redactStringValues(item)
          : item !== null && typeof item === "object"
            ? redactPii(item as Record<string, unknown>)
            : item
      );
    } else if (value !== null && typeof value === "object") {
      result[key] = redactPii(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function buildLogEvent(params: {
  level: LogLevel;
  service: string;
  component: ComponentId;
  eventName: KpiEventName | string;
  requestId: string;
  userId: string;
  outcome: MetricOutcome | string;
  degradeModeEnabled: boolean;
  extra?: Record<string, unknown>;
}): ObservabilityEvent {
  const event: ObservabilityEvent = {
    timestamp_utc: new Date().toISOString(),
    level: params.level,
    service: params.service,
    component: params.component,
    event_name: params.eventName,
    request_id: params.requestId,
    user_id: params.userId,
    outcome: params.outcome,
    degrade_mode_enabled: params.degradeModeEnabled,
    schema_version: LOG_SCHEMA_VERSION,
  };

  if (params.extra) {
    const redactedExtra = redactPii(params.extra);
    for (const [key, value] of Object.entries(redactedExtra)) {
      if ((CORE_EVENT_KEYS as readonly string[]).includes(key)) {
        continue;
      }
      event[key] = value;
    }
  }

  for (const forbidden of LOG_FORBIDDEN_FIELDS) {
    if (forbidden in event && event[forbidden] !== "[REDACTED]") {
      event[forbidden] = "[REDACTED]";
    }
  }

  return event;
}

export function emitLog(
  logger: OpenClawLogger,
  event: ObservabilityEvent
): void {
  const { level } = event;
  const message = `${event.component}:${event.event_name}`;
  const meta: Record<string, unknown> = { ...event };
  delete (meta as Record<string, unknown>).level;

  const redactedMeta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if ((CORE_EVENT_KEYS as readonly string[]).includes(key)) {
      redactedMeta[key] = value;
    } else if ((ALLOWED_EXTRA_KEYS as readonly string[]).includes(key)) {
      if (typeof value === "string") {
        redactedMeta[key] = redactStringValues(value);
      } else {
        redactedMeta[key] = value;
      }
    }
  }

  for (const forbidden of LOG_FORBIDDEN_FIELDS) {
    if (forbidden in meta) {
      redactedMeta[forbidden] = "[REDACTED]";
    }
  }

  switch (level) {
    case "critical":
      logger.critical(message, redactedMeta);
      break;
    case "error":
      logger.error(message, redactedMeta);
      break;
    case "warn":
      logger.warn(message, redactedMeta);
      break;
    default:
      logger.info(message, redactedMeta);
  }
}

export function buildRedactedEvent(
  level: LogLevel,
  service: string,
  component: ComponentId,
  eventName: KpiEventName | string,
  requestId: string,
  userId: string,
  outcome: MetricOutcome | string,
  degradeModeEnabled: boolean,
  extra?: Record<string, unknown>
): ObservabilityEvent {
  return buildLogEvent({
    level,
    service,
    component,
    eventName,
    requestId,
    userId,
    outcome,
    degradeModeEnabled,
    extra,
  });
}
