/**
 * C10 Observability — Cached getWebhookInfo poll
 *
 * Per ADR-021@0.1.0 §`/diag` command contract: the /diag handler reads
 * webhook error data from a cached background poll of getWebhookInfo
 * refreshed every 60 s — never per-invocation.
 *
 * The cache runs a periodic tick (via setInterval) that calls
 * `getWebhookInfo()` on the Telegram Bot API. The /diag handler reads
 * the most recent snapshot via `getCachedInfo()`.
 *
 * Conventions mirror TKT-015@0.1.0 (redactPii allowlist) and the
 * C15 Allowlist hot-reload pattern from ADR-013@0.1.0.
 */

export interface WebhookErrorInfo {
  last_error_date: number | null;
  last_error_message: string | null;
}

export interface WebhookInfoSnapshot {
  last_error_date: number | null;
  last_error_message: string | null;
  fetchedAtUtc: string;
}

export interface GetWebhookInfoFn {
  (): Promise<{
    last_error_date?: number | null;
    last_error_message?: string | null;
    [key: string]: unknown;
  }>;
}

const CACHE_TTL_MS = 60_000;
const NULL_SNAPSHOT: WebhookInfoSnapshot = {
  last_error_date: null,
  last_error_message: null,
  fetchedAtUtc: "",
};

export class WebhookInfoCache {
  private snapshot: WebhookInfoSnapshot = { ...NULL_SNAPSHOT };
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private getWebhookInfo: GetWebhookInfoFn;
  private ttlMs: number;

  constructor(getWebhookInfoFn: GetWebhookInfoFn, ttlMs: number = CACHE_TTL_MS) {
    this.getWebhookInfo = getWebhookInfoFn;
    this.ttlMs = ttlMs;
  }

  /** Start the background refresh tick. */
  start(): void {
    if (this.intervalHandle !== null) return;
    // Fetch immediately on start
    this.refresh().catch(() => { /* swallow — cache stays stale */ });
    this.intervalHandle = setInterval(() => {
      this.refresh().catch(() => { /* swallow — cache stays stale */ });
    }, this.ttlMs);
  }

  /** Stop the background refresh tick. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Read the most recent cached snapshot. */
  getCachedInfo(): WebhookInfoSnapshot {
    return this.snapshot;
  }

  /** Force a refresh (exposed for tests). */
  async refresh(): Promise<void> {
    try {
      const info = await this.getWebhookInfo();
      this.snapshot = {
        last_error_date: info.last_error_date ?? null,
        last_error_message: info.last_error_message ?? null,
        fetchedAtUtc: new Date().toISOString(),
      };
    } catch {
      // On failure, keep the last valid snapshot (same pattern as C15 Allowlist).
    }
  }
}
