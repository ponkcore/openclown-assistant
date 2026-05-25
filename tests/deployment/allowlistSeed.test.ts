import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Allowlist, AllowlistSeedError } from "../../src/security/allowlist.js";
import type { MetricsRegistry } from "../../src/observability/metricsEndpoint.js";

function makeNullMetrics(): MetricsRegistry {
  return {
    increment: () => {},
    set: () => {},
    observe: () => {},
    getSamples: () => [],
    render: () => "",
  };
}

function makeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    critical: () => {},
  };
}

/**
 * Atomic write helper — mirrors the production write pattern (tmp + rename)
 * per ADR-013@0.1.0 §3.
 */
function writeAllowlist(filePath: string, users: number[], comment?: string): void {
  const contents: Record<string, unknown> = { users };
  if (comment) contents.comment = comment;
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(contents, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

describe("Allowlist seed — deployment scenarios (TKT-042)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "allowlist-seed-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("fresh container with TELEGRAM_PILOT_USER_IDS and no config/allowlist.json", () => {
    it("seeds the file from env var and the in-memory Set contains both IDs", () => {
      const filePath = path.join(tmpDir, "allowlist.json");

      // File does NOT exist yet — fresh volume.
      expect(fs.existsSync(filePath)).toBe(false);

      const allowlist = new Allowlist(
        filePath,
        ["123", "456"],
        makeNullMetrics(),
        makeLogger()
      );

      // In-memory Set has both IDs.
      expect(allowlist.isAllowed(123)).toBe(true);
      expect(allowlist.isAllowed(456)).toBe(true);
      expect(allowlist.isAllowed(999)).toBe(false);
      expect(allowlist.getSize()).toBe(2);

      // File was atomically written to the named-volume path.
      expect(fs.existsSync(filePath)).toBe(true);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.users).toEqual([123, 456]);
      expect(parsed.comment).toContain("TELEGRAM_PILOT_USER_IDS");

      allowlist.close();
    });
  });

  describe("existing config/allowlist.json — seed is a no-op", () => {
    it("does NOT overwrite the file when it already exists", () => {
      const filePath = path.join(tmpDir, "allowlist.json");

      // Operator-edited file with a custom comment and different IDs.
      writeAllowlist(filePath, [789, 101112], "Operator-edited allowlist");

      const originalContent = fs.readFileSync(filePath, "utf-8");

      // Pass seed IDs that differ from the file — they should be ignored.
      const allowlist = new Allowlist(
        filePath,
        ["123", "456"],
        makeNullMetrics(),
        makeLogger()
      );

      // In-memory Set reflects the FILE, not the env var.
      expect(allowlist.isAllowed(789)).toBe(true);
      expect(allowlist.isAllowed(101112)).toBe(true);
      expect(allowlist.isAllowed(123)).toBe(false);
      expect(allowlist.isAllowed(456)).toBe(false);

      // File content is unchanged.
      const currentContent = fs.readFileSync(filePath, "utf-8");
      expect(currentContent).toEqual(originalContent);

      allowlist.close();
    });
  });

  describe("misconfiguration — neither env var nor file present", () => {
    it("throws AllowlistSeedError (boot exits non-zero with a clear error)", () => {
      const filePath = path.join(tmpDir, "allowlist.json");

      // No file, no valid seed IDs.
      expect(fs.existsSync(filePath)).toBe(false);

      expect(
        () => new Allowlist(filePath, [], makeNullMetrics(), makeLogger())
      ).toThrow(AllowlistSeedError);

      expect(
        () => new Allowlist(filePath, [], makeNullMetrics(), makeLogger())
      ).toThrow(/config\/allowlist\.json is missing/);

      // No file was written — operator must fix configuration.
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("throws AllowlistSeedError when seed IDs are all whitespace or non-numeric", () => {
      const filePath = path.join(tmpDir, "allowlist.json");

      expect(fs.existsSync(filePath)).toBe(false);

      expect(
        () => new Allowlist(filePath, ["", "  ", "abc"], makeNullMetrics(), makeLogger())
      ).toThrow(AllowlistSeedError);

      expect(fs.existsSync(filePath)).toBe(false);
    });
  });
});
