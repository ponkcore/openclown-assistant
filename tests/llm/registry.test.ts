import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  initRegistry,
  resolve,
  reload,
  getApiKey,
  closeRegistry,
  getCallTypeCount,
  getProviderCount,
  RegistryError,
  _resetLegacyWarned,
  type LlmRegistryFile,
} from "../../src/llm/registry.js";
import type { OpenClawLogger } from "../../src/shared/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLogger(): OpenClawLogger & { logs: Array<{ level: string; msg: string }> } {
  const logs: Array<{ level: string; msg: string }> = [];
  return {
    logs,
    info(msg: string) { logs.push({ level: "info", msg }); },
    warn(msg: string) { logs.push({ level: "warn", msg }); },
    error(msg: string) { logs.push({ level: "error", msg }); },
    critical(msg: string) { logs.push({ level: "critical", msg }); },
  };
}

function makeMetrics() {
  const increments: Array<{ name: string; labels: Record<string, string>; delta?: number }> = [];
  return {
    increments,
    increment(name: string, labels: Record<string, string>, delta?: number) {
      increments.push({ name, labels, delta });
    },
  };
}

const VALID_REGISTRY: LlmRegistryFile = {
  version: 1,
  providers: {
    omniroute: { base_url: "http://omniroute:8000/v1", api_key_env: "LLM_OMNIROUTE_API_KEY" },
    fireworks: { base_url: "https://api.fireworks.ai/inference/v1", api_key_env: "LLM_FIREWORKS_API_KEY" },
  },
  call_types: {
    "kbju.meal_text": { provider: "omniroute", model: "gpt-oss-120b" },
    "kbju.photo_recognition": { provider: "fireworks", model: "accounts/fireworks/models/qwen3-vl-30b-a3b" },
    "kbju.modality_router_classifier": {
      provider: "fireworks",
      model: "accounts/fireworks/models/gpt-oss-20b",
      fallback_call_type: "kbju.modality_router_classifier_fallback",
    },
    "kbju.modality_router_classifier_fallback": {
      provider: "fireworks",
      model: "accounts/fireworks/models/qwen3-vl-30b-a3b",
    },
  },
};

function writeRegistry(dir: string, data: LlmRegistryFile | object): string {
  const filePath = path.join(dir, "llm.json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("LlmRegistry", () => {
  let tmpDir: string;
  let logger: ReturnType<typeof makeLogger>;
  let metrics: ReturnType<typeof makeMetrics>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-reg-test-"));
    logger = makeLogger();
    metrics = makeMetrics();
    _resetLegacyWarned();
    delete process.env.LLM_OMNIROUTE_API_KEY;
    delete process.env.LLM_FIREWORKS_API_KEY;
    delete process.env.OMNIROUTE_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
    delete process.env.LLM_OMNIROUTE_BASE_URL;
    delete process.env.OMNIROUTE_BASE_URL;
  });

  afterEach(() => {
    closeRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves a valid call-type alias", () => {
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    const result = resolve("kbju.meal_text");
    expect(result.provider_id).toBe("omniroute");
    expect(result.base_url).toBe("http://omniroute:8000/v1");
    expect(result.api_key_env).toBe("LLM_OMNIROUTE_API_KEY");
    expect(result.model).toBe("gpt-oss-120b");
    expect(result.fallback).toBeUndefined();
  });

  it("resolves a call-type with fallback", () => {
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    const result = resolve("kbju.modality_router_classifier");
    expect(result.provider_id).toBe("fireworks");
    expect(result.model).toBe("accounts/fireworks/models/gpt-oss-20b");
    expect(result.fallback).toBeDefined();
    expect(result.fallback!.provider_id).toBe("fireworks");
    expect(result.fallback!.model).toBe("accounts/fireworks/models/qwen3-vl-30b-a3b");
  });

  it("rejects unknown version", () => {
    const filePath = writeRegistry(tmpDir, { version: 2, providers: {}, call_types: {} });
    initRegistry(filePath, logger, metrics);

    expect(logger.logs.some((l) => l.level === "warn" && l.msg.includes("registry reload failed"))).toBe(true);
    expect(() => resolve("kbju.meal_text")).toThrow(RegistryError);
  });

  it("throws RegistryError on missing alias", () => {
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    expect(() => resolve("nonexistent.alias")).toThrow(RegistryError);
    try { resolve("nonexistent.alias"); } catch (e) {
      expect((e as RegistryError).code).toBe("missing_alias");
    }
  });

  it("rejects config with dangling provider reference at boot", () => {
    const bad: LlmRegistryFile = {
      version: 1,
      providers: { omniroute: { base_url: "http://x", api_key_env: "K" } },
      call_types: { "kbju.meal_text": { provider: "nonexistent", model: "m" } },
    };
    const filePath = writeRegistry(tmpDir, bad);
    initRegistry(filePath, logger, metrics);

    expect(logger.logs.some((l) => l.level === "warn" && l.msg.includes("registry reload failed"))).toBe(true);
    expect(() => resolve("kbju.meal_text")).toThrow(RegistryError);
  });

  it("throws RegistryError on missing env var", () => {
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    expect(() => getApiKey("LLM_OMNIROUTE_API_KEY")).toThrow(RegistryError);
    try { getApiKey("LLM_OMNIROUTE_API_KEY"); } catch (e) {
      expect((e as RegistryError).code).toBe("missing_env_var");
    }
  });

  it("reads api key from new env var", () => {
    process.env.LLM_OMNIROUTE_API_KEY = "test-key-new";
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    expect(getApiKey("LLM_OMNIROUTE_API_KEY")).toBe("test-key-new");
  });

  it("hot-reloads on file change via reload()", () => {
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    expect(resolve("kbju.meal_text").model).toBe("gpt-oss-120b");
    expect(getCallTypeCount()).toBe(4);
    expect(getProviderCount()).toBe(2);

    // Write updated config directly
    const updated: LlmRegistryFile = {
      ...VALID_REGISTRY,
      call_types: {
        ...VALID_REGISTRY.call_types,
        "kbju.meal_text": { provider: "omniroute", model: "new-model-300b" },
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));

    // Explicitly trigger reload (covers both manual and fs.watchFile paths)
    reload();

    const result = resolve("kbju.meal_text");
    expect(result.model).toBe("new-model-300b");
  });

  it("preserves old snapshot on reload failure (malformed JSON)", () => {
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    expect(resolve("kbju.meal_text").model).toBe("gpt-oss-120b");

    // Write malformed JSON directly
    fs.writeFileSync(filePath, "{ invalid json }}}");

    // Trigger reload
    reload();

    // Old snapshot still works
    expect(resolve("kbju.meal_text").model).toBe("gpt-oss-120b");

    // Failed metric emitted
    expect(metrics.increments.some(
      (i) => i.name === "kbju_llm_registry_reload_failed" && i.labels.outcome === "failed",
    )).toBe(true);
  });

  it("falls back to legacy OMNIROUTE_API_KEY with one-shot warn", () => {
    process.env.OMNIROUTE_API_KEY = "legacy-key";
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    expect(getApiKey("LLM_OMNIROUTE_API_KEY")).toBe("legacy-key");

    expect(logger.logs.some(
      (l) => l.level === "warn" && l.msg.includes("kbju_llm_legacy_env_in_use") && l.msg.includes("OMNIROUTE_API_KEY"),
    )).toBe(true);

    // Second call should NOT emit another warn (one-shot)
    const warnCountBefore = logger.logs.filter(
      (l) => l.level === "warn" && l.msg.includes("kbju_llm_legacy_env_in_use"),
    ).length;
    getApiKey("LLM_OMNIROUTE_API_KEY");
    const warnCountAfter = logger.logs.filter(
      (l) => l.level === "warn" && l.msg.includes("kbju_llm_legacy_env_in_use"),
    ).length;
    expect(warnCountAfter).toBe(warnCountBefore);
  });

  it("prefers new LLM_* env var over legacy", () => {
    process.env.LLM_OMNIROUTE_API_KEY = "new-key";
    process.env.OMNIROUTE_API_KEY = "legacy-key";
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    expect(getApiKey("LLM_OMNIROUTE_API_KEY")).toBe("new-key");
    expect(logger.logs.some(
      (l) => l.level === "warn" && l.msg.includes("kbju_llm_legacy_env_in_use"),
    )).toBe(false);
  });

  it("falls back to legacy FIREWORKS_API_KEY", () => {
    process.env.FIREWORKS_API_KEY = "fw-legacy-key";
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    expect(getApiKey("LLM_FIREWORKS_API_KEY")).toBe("fw-legacy-key");
    expect(logger.logs.some(
      (l) => l.level === "warn" && l.msg.includes("kbju_llm_legacy_env_in_use") && l.msg.includes("FIREWORKS_API_KEY"),
    )).toBe(true);
  });

  it("emits success metric on valid reload", () => {
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    expect(metrics.increments.some(
      (i) => i.name === "kbju_llm_registry_reload" && i.labels.outcome === "success",
    )).toBe(true);
  });

  it("warns when config file is missing at init", () => {
    const missingPath = path.join(tmpDir, "nonexistent.json");
    initRegistry(missingPath, logger, metrics);

    expect(logger.logs.some((l) => l.level === "warn" && l.msg.includes("missing"))).toBe(true);
    expect(() => resolve("kbju.meal_text")).toThrow(RegistryError);
  });

  it("ignores fallback_call_type that points to a nonexistent alias", () => {
    const reg: LlmRegistryFile = {
      version: 1,
      providers: { omniroute: { base_url: "http://x/v1", api_key_env: "K" } },
      call_types: {
        "kbju.test": { provider: "omniroute", model: "m1", fallback_call_type: "nonexistent" },
      },
    };
    const filePath = writeRegistry(tmpDir, reg);
    initRegistry(filePath, logger, metrics);

    expect(logger.logs.some((l) => l.level === "warn" && l.msg.includes("registry reload failed"))).toBe(true);
  });

  it("config/llm.example.json is valid and every call_type.provider resolves", () => {
    const examplePath = path.resolve(__dirname, "../../config/llm.example.json");
    const raw = fs.readFileSync(examplePath, "utf-8");
    const parsed: LlmRegistryFile = JSON.parse(raw);

    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.providers).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(parsed.call_types).length).toBeGreaterThanOrEqual(5);

    // Every call_type.provider must resolve to a providers entry
    // (skip comment keys — ADR-024 invariant 6)
    for (const [, entry] of Object.entries(parsed.call_types)) {
      if (typeof entry !== "object" || entry === null || !("provider" in entry)) {
        continue; // skip comment keys
      }
      expect(parsed.providers[entry.provider]).toBeDefined();
      if (entry.fallback_call_type) {
        expect(parsed.call_types[entry.fallback_call_type]).toBeDefined();
      }
    }
  });

  it("never logs raw API key values", () => {
    process.env.LLM_OMNIROUTE_API_KEY = "sk-super-secret-key-12345";
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    resolve("kbju.meal_text");
    getApiKey("LLM_OMNIROUTE_API_KEY");

    const allLogs = logger.logs.map((l) => l.msg).join(" ");
    expect(allLogs).not.toContain("sk-super-secret-key-12345");
    expect(allLogs).not.toContain("LLM_OMNIROUTE_API_KEY=");
  });


  it("hot-reloads via fs.watchFile on atomic rename within 5 s", async () => {
    const filePath = writeRegistry(tmpDir, VALID_REGISTRY);
    initRegistry(filePath, logger, metrics);

    expect(resolve("kbju.meal_text").model).toBe("gpt-oss-120b");

    // Allow fs.watchFile watcher to stabilise after init
    await new Promise((r) => setTimeout(r, 100));

    // Write updated config using atomic rename (tmp + rename)
    const updated: LlmRegistryFile = {
      ...VALID_REGISTRY,
      call_types: {
        ...VALID_REGISTRY.call_types,
        "kbju.meal_text": { provider: "omniroute", model: "new-model-via-watch" },
      },
    };
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
    fs.renameSync(tmpPath, filePath);

    // Poll for fs.watchFile to pick up the change (≤2 s target)
    const deadline = Date.now() + 3000;
    let observed = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (resolve("kbju.meal_text").model === "new-model-via-watch") {
        observed = true;
        break;
      }
    }

    expect(observed).toBe(true);
  }, 10000);
});
