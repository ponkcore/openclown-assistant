import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const ENV_EXAMPLE_PATH = resolve(ROOT, ".env.example");

function readEnvExample(): string {
  return readFileSync(ENV_EXAMPLE_PATH, "utf-8");
}

function parseEnvVars(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const value = trimmed.substring(eqIdx + 1).trim();
    result.set(key, value);
  }
  return result;
}

const REQUIRED_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_PILOT_USER_IDS",
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
  "OMNIROUTE_BASE_URL",
  "OMNIROUTE_API_KEY",
  "FIREWORKS_API_KEY",
  "USDA_FDC_API_KEY",
  "PERSONA_PATH",
  "PO_ALERT_CHAT_ID",
  "MONTHLY_SPEND_CEILING_USD",
  "KBJU_PUBLIC_DOMAIN",
  "CLOUDFLARED_TUNNEL_TOKEN",
  "INSTALL_TLS_MODE",
  "AUDIT_DB_URL",
];

const PLAUSSIBLE_SECRET_PATTERNS = [
  /[0-9]{8,}:[a-zA-Z0-9_-]{20,}/,
  /sk-[a-zA-Z0-9]{20,}/,
  /pk_[a-zA-Z0-9]{20,}/,
  /eyJ[a-zA-Z0-9_-]{20,}/,
  /[a-f0-9]{32}/i,
  /password\s*=\s*\S+/i,
  /token\s*=\s*\S+/i,
  /secret\s*=\s*\S+/i,
  /[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/,
  /api[-_]?key\s*=\s*\S+/i,
];

describe(".env.example", () => {
  const content = readEnvExample();
  const vars = parseEnvVars(content);

  it("exists and is non-empty", () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it("contains every required variable from ARCH-001@0.4.0 §9.1", () => {
    for (const name of REQUIRED_VARS) {
      expect(vars.has(name), `missing required variable: ${name}`).toBe(true);
    }
  });

  it("contains no plausible secret values", () => {
    const contentStr = content;
    for (const pattern of PLAUSSIBLE_SECRET_PATTERNS) {
      const linesWithSecrets = contentStr
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .filter((line) => {
          const eqIdx = line.indexOf("=");
          if (eqIdx === -1) return false;
          const value = line.substring(eqIdx + 1).trim();
          return value.length > 0 && pattern.test(value);
        });
      expect(
        linesWithSecrets,
        `plausible secret found matching ${pattern}: ${linesWithSecrets.join("; ")}`
      ).toHaveLength(0);
    }
  });

  it("MONTHLY_SPEND_CEILING_USD uses safe default 10", () => {
    const value = vars.get("MONTHLY_SPEND_CEILING_USD");
    expect(value).toBe("10");
  });

  it("all other variables have blank or obviously-safe placeholder values", () => {
    for (const [key, value] of vars.entries()) {
      if (key === "MONTHLY_SPEND_CEILING_USD") continue;
      if (key === "INSTALL_TLS_MODE") continue;
      expect(
        value === "" || value === "10",
        `${key} has non-blank non-safe value: "${value}"`
      ).toBe(true);
    }
  });
});

describe(".env.example — TLS termination vars (ADR-020@0.1.0)", () => {
  const content = readEnvExample();
  const vars = parseEnvVars(content);

  it("contains KBJU_PUBLIC_DOMAIN", () => {
    expect(vars.has("KBJU_PUBLIC_DOMAIN"), "missing KBJU_PUBLIC_DOMAIN").toBe(true);
  });

  it("contains CLOUDFLARED_TUNNEL_TOKEN", () => {
    expect(vars.has("CLOUDFLARED_TUNNEL_TOKEN"), "missing CLOUDFLARED_TUNNEL_TOKEN").toBe(true);
  });

  it("contains INSTALL_TLS_MODE", () => {
    expect(vars.has("INSTALL_TLS_MODE"), "missing INSTALL_TLS_MODE").toBe(true);
  });

  it("KBJU_PUBLIC_DOMAIN has a blank placeholder", () => {
    expect(vars.get("KBJU_PUBLIC_DOMAIN")).toBe("");
  });

  it("CLOUDFLARED_TUNNEL_TOKEN has a blank placeholder", () => {
    expect(vars.get("CLOUDFLARED_TUNNEL_TOKEN")).toBe("");
  });

  it("INSTALL_TLS_MODE defaults to caddy", () => {
    expect(vars.get("INSTALL_TLS_MODE")).toBe("caddy");
  });
});
