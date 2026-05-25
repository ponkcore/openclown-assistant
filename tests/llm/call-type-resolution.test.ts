/**
 * Smoke test per TKT-035@0.1.0 §6 AC #5:
 * Load every migrated manifest, resolve every call_type against a fixture
 * config/llm.json, none miss.
 *
 * This test uses the real registry (not mocked) initialized with a test
 * fixture that mirrors config/llm.example.json's alias set.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initRegistry, closeRegistry, resolve } from "../../src/llm/registry.js";
import type { OpenClawLogger } from "../../src/shared/types.js";
import type { MetricsRegistry } from "../../src/observability/metricsEndpoint.js";

// ── Fixture: a minimal llm.json with all call_type aliases ────────────────

const FIXTURE_LLMPATH = (() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-smoke-"));
  const filePath = path.join(tmpDir, "llm.json");
  const fixture = {
    version: 1,
    providers: {
      fireworks: {
        base_url: "https://api.fireworks.ai/inference/v1",
        api_key_env: "LLM_FIREWORKS_API_KEY",
      },
    },
    call_types: {
      "kbju.water_volume_extractor": {
        provider: "fireworks",
        model: "accounts/fireworks/models/gpt-oss-20b",
      },
      "kbju.workout_extractor": {
        provider: "fireworks",
        model: "accounts/fireworks/models/qwen3-vl-30b-a3b",
      },
      "kbju.mood_inferrer": {
        provider: "fireworks",
        model: "accounts/fireworks/models/executor",
        fallback_call_type: "kbju.mood_inferrer_fallback",
      },
      "kbju.mood_inferrer_fallback": {
        provider: "fireworks",
        model: "accounts/fireworks/models/reviewer",
      },
      "kbju.modality_router_classifier": {
        provider: "fireworks",
        model: "accounts/fireworks/models/gpt-oss-20b",
        fallback_call_type: "kbju.modality_router_classifier_fallback",
      },
      "kbju.modality_router_classifier_fallback": {
        provider: "fireworks",
        model: "accounts/fireworks/models/qwen3-vl-30b-a3b",
      },
      "kbju.photo_recognition": {
        provider: "fireworks",
        model: "accounts/fireworks/models/qwen3-vl-30b-a3b",
      },
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2), "utf-8");
  return filePath;
})();

const stubLogger: OpenClawLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  critical: vi.fn(),
};

const stubMetrics: MetricsRegistry = {
  increment: vi.fn(),
  set: vi.fn(),
  observe: vi.fn(),
  getSamples: vi.fn().mockReturnValue([]),
  render: vi.fn().mockReturnValue(""),
};

// ── Migrated manifests to verify ───────────────────────────────────────────

const MIGRATED_MANIFESTS = [
  { path: "config/water-extractor.json", expectedCallType: "kbju.water_volume_extractor" },
  { path: "config/workout-extractor-text.json", expectedCallType: "kbju.workout_extractor" },
  { path: "config/workout-extractor-photo.json", expectedCallType: "kbju.workout_extractor" },
  { path: "config/mood-extractor.json", expectedCallType: "kbju.mood_inferrer" },
  { path: "config/modality-router-classifier.json", expectedCallType: "kbju.modality_router_classifier" },
];

// ── Registry init with fixture ─────────────────────────────────────────────

beforeAll(() => {
  process.env.LLM_FIREWORKS_API_KEY = "test-smoke-key";
  initRegistry(FIXTURE_LLMPATH, stubLogger, stubMetrics);
});

afterAll(() => {
  closeRegistry();
  delete process.env.LLM_FIREWORKS_API_KEY;
  const tmpDir = path.dirname(FIXTURE_LLMPATH);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("call-type resolution smoke test (TKT-035@0.1.0 §6 AC #5)", () => {
  it.each(MIGRATED_MANIFESTS)(
    "manifest $path has call_type=$expectedCallType that resolves in registry",
    ({ path: manifestPath, expectedCallType }) => {
      const projectRoot = path.resolve(import.meta.dirname, "../..");
      const fullPath = path.join(projectRoot, manifestPath);
      const raw = fs.readFileSync(fullPath, "utf-8");
      const manifest = JSON.parse(raw) as { call_type: string };

      expect(manifest.call_type).toBe(expectedCallType);

      const resolved = resolve(manifest.call_type);
      expect(resolved).toBeDefined();
      expect(resolved.provider_id).toBe("fireworks");
      expect(resolved.model).toBeTruthy();
      expect(resolved.base_url).toContain("fireworks.ai");
      expect(resolved.api_key_env).toBe("LLM_FIREWORKS_API_KEY");
    }
  );

  it("no migrated manifest has a hard-coded model field", () => {
    const projectRoot = path.resolve(import.meta.dirname, "../..");
    for (const { path: manifestPath } of MIGRATED_MANIFESTS) {
      const fullPath = path.join(projectRoot, manifestPath);
      const raw = fs.readFileSync(fullPath, "utf-8");
      const manifest = JSON.parse(raw) as Record<string, unknown>;

      expect(manifest).not.toHaveProperty("model");
      expect(manifest).not.toHaveProperty("base_url");
      expect(manifest).not.toHaveProperty("api_key_env");
    }
  });

  it("all call_type aliases from ADR-024@0.1.0 resolve in registry", () => {
    const aliases = [
      "kbju.water_volume_extractor",
      "kbju.workout_extractor",
      "kbju.mood_inferrer",
      "kbju.modality_router_classifier",
      "kbju.modality_router_classifier_fallback",
      "kbju.photo_recognition",
    ];

    for (const alias of aliases) {
      const resolved = resolve(alias);
      expect(resolved, `alias "${alias}" should resolve`).toBeDefined();
      expect(resolved.provider_id).toBe("fireworks");
      expect(resolved.model).toBeTruthy();
    }
  });
});
