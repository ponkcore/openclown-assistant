/**
 * C23 LLM Gateway — Model Registry (config/llm.json)
 *
 * Per ADR-024@0.1.0: PO-pluggable model registry with hot-reload.
 * Mirrors the C15 Allowlist hot-reload pattern from ADR-013@0.1.0:
 *   - fs.watchFile (NOT chokidar)
 *   - atomic write expected (tmp + rename)
 *   - failure keeps old snapshot
 *   - observability counter on reload
 *
 * Lookup contract (ADR-024@0.1.0 §Lookup contract):
 *   resolve(callType) → { provider_id, base_url, api_key_env, model, fallback? }
 *   reload()          → re-reads file; idempotent
 */

import fs from "node:fs";
import type { OpenClawLogger } from "../shared/types.js";

// ── Schema types (ADR-024@0.1.0 §Schema) ──────────────────────────────────

export interface ProviderEntry {
  base_url: string;
  api_key_env: string;
  auth_header_template?: string;
  comment?: string;
}

export interface CallTypeEntry {
  provider: string;
  model: string;
  fallback_call_type?: string;
  comment?: string;
}

export interface LlmRegistryFile {
  version: number;
  providers: Record<string, ProviderEntry>;
  call_types: Record<string, CallTypeEntry>;
  comment?: string;
}

// ── Resolved type (ADR-024@0.1.0 §Lookup contract — character-for-character) ─

export type Resolved = {
  provider_id: string;
  base_url: string;
  api_key_env: string;
  model: string;
  auth_header_template?: string;
  fallback?: Resolved;
};

// ── Errors ────────────────────────────────────────────────────────────────

export class RegistryError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

// ── Metrics sink (avoids coupling to PrometheusMetricName union) ───────────

export interface RegistryMetricsSink {
  increment(name: string, labels: Record<string, string>, delta?: number): void;
}

/** Adapts a MetricsRegistry to RegistryMetricsSink via type assertion. */
export function adaptMetricsSink(
  registry: { increment: (name: unknown, labels?: Record<string, string>, delta?: number) => void },
): RegistryMetricsSink {
  return {
    increment(name, labels, delta) {
      registry.increment(name as never, labels, delta);
    },
  };
}

// ── Legacy env-var fallback (ADR-024@0.1.0 §Backward compatibility) ───────

const LEGACY_ENV_MAP: Readonly<Record<string, string>> = {
  LLM_OMNIROUTE_BASE_URL: "OMNIROUTE_BASE_URL",
  LLM_OMNIROUTE_API_KEY: "OMNIROUTE_API_KEY",
  LLM_FIREWORKS_API_KEY: "FIREWORKS_API_KEY",
};

const legacyWarned = new Set<string>();

function resolveEnvVar(
  newName: string,
  logger: OpenClawLogger,
): string | undefined {
  const value = process.env[newName];
  if (value !== undefined && value !== "") return value;

  const legacyName = LEGACY_ENV_MAP[newName];
  if (legacyName) {
    const legacyValue = process.env[legacyName];
    if (legacyValue !== undefined && legacyValue !== "") {
      if (!legacyWarned.has(newName)) {
        legacyWarned.add(newName);
        logger.warn(
          `kbju_llm_legacy_env_in_use{var="${newName}"}: using deprecated env var ${legacyName} instead of ${newName}. Removal target: v0.8.0`,
        );
      }
      return legacyValue;
    }
  }

  return undefined;
}

/** Reset legacy warn tracking (for tests). */
export function _resetLegacyWarned(): void {
  legacyWarned.clear();
}

// ── Registry class ────────────────────────────────────────────────────────

class LlmRegistry {
  private snapshot: LlmRegistryFile | null = null;
  private lastValidSnapshot: LlmRegistryFile | null = null;
  private filePath: string;
  private logger: OpenClawLogger;
  private metrics: RegistryMetricsSink;

  constructor(
    filePath: string,
    logger: OpenClawLogger,
    metrics: RegistryMetricsSink,
  ) {
    this.filePath = filePath;
    this.logger = logger;
    this.metrics = metrics;

    if (fs.existsSync(filePath)) {
      this.loadFile();
    } else {
      this.logger.warn(
        `LLM registry file missing at ${filePath}; registry is empty. ` +
        "Copy config/llm.example.json → config/llm.json and edit.",
      );
    }

    // Hot-reload: mirror ADR-013@0.1.0 allowlist pattern
    fs.watchFile(filePath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs > prev.mtimeMs) {
        this.loadFile();
      }
    });
  }

  resolve(callType: string): Resolved {
    if (!this.snapshot) {
      throw new RegistryError(
        "registry_empty",
        "Registry is empty — no config loaded",
      );
    }

    const entry = this.snapshot.call_types[callType];
    if (!entry) {
      throw new RegistryError(
        "missing_alias",
        `Call-type alias "${callType}" not found in registry`,
      );
    }

    const provider = this.snapshot.providers[entry.provider];
    if (!provider) {
      throw new RegistryError(
        "dangling_provider",
        `Provider "${entry.provider}" referenced by call-type "${callType}" not found in registry`,
      );
    }

    const result: Resolved = {
      provider_id: entry.provider,
      base_url: provider.base_url,
      api_key_env: provider.api_key_env,
      model: entry.model,
      auth_header_template: provider.auth_header_template,
    };

    if (entry.fallback_call_type) {
      // Depth 1 only — no chains beyond depth 2 (ADR-024@0.1.0 invariant 5)
      const fbEntry = this.snapshot.call_types[entry.fallback_call_type];
      if (fbEntry) {
        const fbProvider = this.snapshot.providers[fbEntry.provider];
        if (fbProvider) {
          result.fallback = {
            provider_id: fbEntry.provider,
            base_url: fbProvider.base_url,
            api_key_env: fbProvider.api_key_env,
            model: fbEntry.model,
          };
        }
      }
    }

    return result;
  }

  getApiKey(apiKeyEnv: string): string {
    const value = resolveEnvVar(apiKeyEnv, this.logger);
    if (value === undefined) {
      throw new RegistryError(
        "missing_env_var",
        `Environment variable "${apiKeyEnv}" is not set`,
      );
    }
    return value;
  }

  reload(): void {
    this.loadFile();
  }

  close(): void {
    fs.unwatchFile(this.filePath);
  }

  getCallTypeCount(): number {
    if (!this.snapshot) return 0;
    return Object.keys(this.snapshot.call_types).length;
  }

  getProviderCount(): number {
    if (!this.snapshot) return 0;
    return Object.keys(this.snapshot.providers).length;
  }

  private loadFile(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.logger.warn(
          `LLM registry file missing at ${this.filePath}, preserving last valid snapshot`,
        );
        this.metrics.increment("kbju_llm_registry_reload_failed", {
          component: "C23",
          outcome: "failed",
          source: "file_missing",
        });
        return;
      }

      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed: LlmRegistryFile = JSON.parse(raw);

      // Frozen invariant 1: version is integer; reject unknown majors
      if (parsed.version !== 1) {
        throw new Error(`Unsupported registry version: ${parsed.version}`);
      }

      // Schema validation
      if (!parsed.providers || typeof parsed.providers !== "object") {
        throw new Error("Registry missing 'providers' object");
      }
      if (!parsed.call_types || typeof parsed.call_types !== "object") {
        throw new Error("Registry missing 'call_types' object");
      }

      // Frozen invariant 3: every call_types[*].provider MUST resolve
      // ADR-024 invariant 6: comment keys are allowed at any level and ignored
      for (const [alias, entry] of Object.entries(parsed.call_types)) {
        if (typeof entry !== "object" || entry === null || !("provider" in entry)) {
          continue; // skip comment keys and other non-call-type entries
        }
        if (!parsed.providers[entry.provider]) {
          throw new Error(
            `Call-type "${alias}" references dangling provider "${entry.provider}"`,
          );
        }
        // Frozen invariant 5: fallback_call_type must point at another entry
        if (entry.fallback_call_type && !parsed.call_types[entry.fallback_call_type]) {
          throw new Error(
            `Call-type "${alias}" references dangling fallback_call_type "${entry.fallback_call_type}"`,
          );
        }
      }

      // Success — replace snapshot
      this.snapshot = parsed;
      this.lastValidSnapshot = parsed;

      this.metrics.increment("kbju_llm_registry_reload", {
        component: "C23",
        outcome: "success",
      });

      this.logger.info(
        `LLM registry reloaded: ${Object.keys(parsed.call_types).length} call-types, ` +
        `${Object.keys(parsed.providers).length} providers`,
      );
    } catch (error) {
      this.logger.warn(
        `LLM registry reload failed, preserving last valid snapshot: ` +
        `${error instanceof Error ? error.message : "unknown"}`,
      );
      this.metrics.increment("kbju_llm_registry_reload_failed", {
        component: "C23",
        outcome: "failed",
        source: "parse_or_validation_error",
      });
    }
  }
}

// ── Singleton API ─────────────────────────────────────────────────────────

let instance: LlmRegistry | null = null;

export function initRegistry(
  filePath: string,
  logger: OpenClawLogger,
  metrics: RegistryMetricsSink,
): void {
  if (instance) {
    instance.close();
  }
  instance = new LlmRegistry(filePath, logger, metrics);
}

export function resolve(callType: string): Resolved {
  if (!instance) {
    throw new RegistryError(
      "registry_not_initialized",
      "Registry has not been initialized — call initRegistry() first",
    );
  }
  return instance.resolve(callType);
}

export function reload(): void {
  if (!instance) {
    throw new RegistryError(
      "registry_not_initialized",
      "Registry has not been initialized — call initRegistry() first",
    );
  }
  instance.reload();
}

export function getApiKey(apiKeyEnv: string): string {
  if (!instance) {
    throw new RegistryError(
      "registry_not_initialized",
      "Registry has not been initialized — call initRegistry() first",
    );
  }
  return instance.getApiKey(apiKeyEnv);
}

export function closeRegistry(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Return the current call-type count (for diagnostics / tests). */
export function getCallTypeCount(): number {
  if (!instance) return 0;
  return instance.getCallTypeCount();
}

/** Return the current provider count (for diagnostics / tests). */
export function getProviderCount(): number {
  if (!instance) return 0;
  return instance.getProviderCount();
}
