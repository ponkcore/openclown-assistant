/**
 * C18 Sleep GC — hourly cron skill that deletes expired sleep_pairing_state rows.
 *
 * Per ADR-017@0.1.0 §Decision path 6 and ARCH-001@0.6.2 §3.18:
 * deletes rows where expires_at_utc < now().
 *
 * Reuses C8 Cron Dispatcher pattern.
 * No ctx.log / console.log per docs/knowledge/openclaw.md Hard Constraints.
 */

import type { TenantStore } from "../../store/types.js";
import type { OpenClawLogger, ComponentId } from "../../shared/types.js";
import { KPI_EVENT_NAMES } from "../../observability/kpiEvents.js";
import { buildRedactedEvent, emitLog } from "../../observability/events.js";

const C18 = "C18" as ComponentId;

export interface SleepGcDeps {
  store: TenantStore;
  logger: OpenClawLogger;
  /** Injectable clock returning ISO 8601 UTC string for now() */
  nowUtc?: () => string;
  degradeModeEnabled?: boolean;
}

/**
 * Run the hourly GC: delete expired sleep_pairing_state rows.
 * Returns the number of rows deleted.
 */
export async function runSleepGc(deps: SleepGcDeps): Promise<{ rows_deleted: number }> {
  const nowUtc = deps.nowUtc?.() ?? new Date().toISOString();
  const degrade = deps.degradeModeEnabled ?? false;

  const result = await deps.store.gcExpiredSleepPairingState(nowUtc);

  if (result.rows_deleted > 0) {
    emitLog(deps.logger, buildRedactedEvent(
      "info",
      "kbju-meal-logging",
      C18,
      KPI_EVENT_NAMES.modality_event_persisted,
      "cron-sleep-gc",
      "__system__",
      "gc_expired",
      degrade,
      { modality: "sleep", source: "cron", rows_deleted: result.rows_deleted },
    ));
  }

  return result;
}
