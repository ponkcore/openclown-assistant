import fs from "node:fs";
import path from "node:path";
import type { OpenClawLogger } from "../shared/types.js";
import type { MetricsRegistry } from "../observability/metricsEndpoint.js";
import { PROMETHEUS_METRIC_NAMES } from "../observability/kpiEvents.js";

export type AllowlistMode = "normal" | "block_all" | "safe_mode" | "read_only";

interface AllowlistFile {
  users: number[];
  comment?: string;
  mode?: AllowlistMode;
}

const SAFE_MODE_ROUTES = new Set(["start", "history", "summary_delivery"]);
const READ_ONLY_ROUTES = new Set(["history", "summary_delivery"]);

export class AllowlistSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistSeedError";
  }
}

export function isOperationAllowed(
  routeKind: string,
  mode: AllowlistMode
): boolean {
  switch (mode) {
    case "normal":
      return true;
    case "block_all":
      return false;
    case "safe_mode":
      return SAFE_MODE_ROUTES.has(routeKind);
    case "read_only":
      return READ_ONLY_ROUTES.has(routeKind);
    default:
      return false;
  }
}

export class Allowlist {
  private set: Set<number> = new Set();
  private lastValidSet: Set<number> = new Set();
  private filePath: string;
  private mode: AllowlistMode = "normal";
  private logger: OpenClawLogger;
  private metricsRegistry: MetricsRegistry;

  constructor(
    filePath: string,
    seedIds: readonly string[],
    metricsRegistry: MetricsRegistry,
    logger: OpenClawLogger
  ) {
    this.filePath = filePath;
    this.logger = logger;
    this.metricsRegistry = metricsRegistry;

    if (fs.existsSync(filePath)) {
      this.loadFile();
    } else {
      this.seedFromEnv(seedIds);
    }

    fs.watchFile(filePath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs > prev.mtimeMs) {
        this.loadFile();
      }
    });
  }

  isAllowed(telegramId: number): boolean {
    if (!Number.isFinite(telegramId) || telegramId <= 0) {
      return false;
    }
    const ok = this.set.has(telegramId);
    if (!ok) {
      this.metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_allowlist_blocked,
        { component: "C15" }
      );
    }
    return ok;
  }

  getMode(): AllowlistMode {
    return this.mode;
  }

  getSize(): number {
    return this.set.size;
  }

  close(): void {
    fs.unwatchFile(this.filePath);
  }

  private loadFile(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.logger.warn(
          `allowlist file missing at ${this.filePath}, preserving last valid set of ${this.lastValidSet.size} users`
        );
        this.metricsRegistry.increment(
          PROMETHEUS_METRIC_NAMES.kbju_allowlist_reload,
          { component: "C15", outcome: "failed" }
        );
        return;
      }

      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed: AllowlistFile = JSON.parse(raw);

      if (!Array.isArray(parsed.users)) {
        throw new Error("allowlist.users is not an array");
      }

      const newSet = new Set<number>();
      for (const id of parsed.users) {
        if (typeof id === "number" && Number.isFinite(id) && id > 0) {
          newSet.add(id);
        }
      }

      const mode = parsed.mode ?? "normal";
      if (
        mode !== "normal" &&
        mode !== "block_all" &&
        mode !== "safe_mode" &&
        mode !== "read_only"
      ) {
        this.logger.warn(`unknown allowlist mode "${mode}", falling back to "normal"`);
        this.mode = "normal";
      } else {
        this.mode = mode;
      }

      this.set = newSet;
      this.lastValidSet = newSet;

      this.metricsRegistry.set(
        PROMETHEUS_METRIC_NAMES.kbju_allowlist_size,
        { component: "C15" },
        newSet.size
      );
      this.metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_allowlist_reload,
        { component: "C15", outcome: "success" }
      );
    } catch (error) {
      this.logger.warn(
        `allowlist reload failed, preserving last valid set of ${this.lastValidSet.size} users: ${error instanceof Error ? error.message : "unknown"}`
      );
      this.metricsRegistry.increment(
        PROMETHEUS_METRIC_NAMES.kbju_allowlist_reload,
        { component: "C15", outcome: "failed" }
      );
    }
  }

  private seedFromEnv(seedIds: readonly string[]): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const ids = seedIds
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);

    if (ids.length === 0) {
      throw new AllowlistSeedError(
        "Allowlist misconfiguration: config/allowlist.json is missing and TELEGRAM_PILOT_USER_IDS is unset or contains no valid user IDs. Refusing to start with an empty allowlist."
      );
    }

    const newSet = new Set(ids);
    this.set = newSet;
    this.lastValidSet = newSet;

    const allowlist: AllowlistFile = {
      users: ids,
      comment: "Seeded from TELEGRAM_PILOT_USER_IDS on first boot.",
    };

    const tmpPath = this.filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(allowlist, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, this.filePath);

    this.metricsRegistry.set(
      PROMETHEUS_METRIC_NAMES.kbju_allowlist_size,
      { component: "C15" },
      newSet.size
    );
    this.metricsRegistry.increment(
      PROMETHEUS_METRIC_NAMES.kbju_allowlist_reload,
      { component: "C15", outcome: "success" }
    );
  }
}
