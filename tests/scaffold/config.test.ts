import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError, REQUIRED_CONFIG_NAMES, redactSecrets, LLM_ENV_ALIASES } from "../../src/shared/config.js";

function makeFullEnv(): Record<string, string> {
  return {
    TELEGRAM_BOT_TOKEN: "123456:ABC-DEF",
    TELEGRAM_PILOT_USER_IDS: "111,222",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/kbju",
    POSTGRES_PASSWORD: "secret_pg_pass",
    OMNIROUTE_BASE_URL: "http://localhost:8000/v1",
    OMNIROUTE_API_KEY: "omni-key-abc",
    FIREWORKS_API_KEY: "fw-key-xyz",
    USDA_FDC_API_KEY: "fdc-key-123",
    PERSONA_PATH: "/app/persona.md",
    PO_ALERT_CHAT_ID: "999",
    MONTHLY_SPEND_CEILING_USD: "10",
    AUDIT_DB_URL: "postgresql://audit:pass@localhost:5432/kbju",
  };
}

describe("parseConfig", () => {
  it("parses a complete valid environment", () => {
    const config = parseConfig(makeFullEnv());
    expect(config.telegramBotToken).toBe("123456:ABC-DEF");
    expect(config.telegramPilotUserIds).toEqual(["111", "222"]);
    expect(config.databaseUrl).toBe("postgresql://user:pass@localhost:5432/kbju");
    expect(config.monthlySpendCeilingUsd).toBe(10);
    expect(config.auditDbUrl).toBe("postgresql://audit:pass@localhost:5432/kbju");
  });

  it("throws ConfigError with field names only when required names are missing", () => {
    const env = makeFullEnv();
    delete env["TELEGRAM_BOT_TOKEN"];
    delete env["DATABASE_URL"];

    try {
      parseConfig(env);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.missingNames).toContain("TELEGRAM_BOT_TOKEN");
      expect(ce.missingNames).toContain("DATABASE_URL");
      expect(ce.message).not.toContain("secret_pg_pass");
      expect(ce.message).not.toContain("omni-key-abc");
      expect(ce.message).not.toContain("fw-key-xyz");
    }
  });

  it("treats blank values as missing", () => {
    const env = makeFullEnv();
    env["PERSONA_PATH"] = "   ";
    env["PO_ALERT_CHAT_ID"] = "";

    try {
      parseConfig(env);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.missingNames).toContain("PERSONA_PATH");
      expect(ce.missingNames).toContain("PO_ALERT_CHAT_ID");
    }
  });

  it("ConfigError never exposes any secret values from the environment", () => {
    const env = makeFullEnv();
    delete env["FIREWORKS_API_KEY"];
    delete env["OMNIROUTE_API_KEY"];
    delete env["POSTGRES_PASSWORD"];

    try {
      parseConfig(env);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.message).not.toContain("fw-key-xyz");
      expect(ce.message).not.toContain("omni-key-abc");
      expect(ce.message).not.toContain("secret_pg_pass");
      expect(ce.message).not.toContain("123456:ABC-DEF");
      expect(ce.message).not.toContain("fdc-key-123");
    }
  });

  it("lists all REQUIRED_CONFIG_NAMES", () => {
    expect(REQUIRED_CONFIG_NAMES.length).toBe(12);
    expect(REQUIRED_CONFIG_NAMES).toContain("TELEGRAM_BOT_TOKEN");
    expect(REQUIRED_CONFIG_NAMES).toContain("TELEGRAM_PILOT_USER_IDS");
    expect(REQUIRED_CONFIG_NAMES).toContain("DATABASE_URL");
    expect(REQUIRED_CONFIG_NAMES).toContain("POSTGRES_PASSWORD");
    expect(REQUIRED_CONFIG_NAMES).toContain("OMNIROUTE_BASE_URL");
    expect(REQUIRED_CONFIG_NAMES).toContain("OMNIROUTE_API_KEY");
    expect(REQUIRED_CONFIG_NAMES).toContain("FIREWORKS_API_KEY");
    expect(REQUIRED_CONFIG_NAMES).toContain("USDA_FDC_API_KEY");
    expect(REQUIRED_CONFIG_NAMES).toContain("PERSONA_PATH");
    expect(REQUIRED_CONFIG_NAMES).toContain("PO_ALERT_CHAT_ID");
    expect(REQUIRED_CONFIG_NAMES).toContain("MONTHLY_SPEND_CEILING_USD");
    expect(REQUIRED_CONFIG_NAMES).toContain("AUDIT_DB_URL");
  });

  it("rejects non-numeric MONTHLY_SPEND_CEILING_USD", () => {
    const env = makeFullEnv();
    env["MONTHLY_SPEND_CEILING_USD"] = "ten";
    try {
      parseConfig(env);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.message).not.toContain("ten");
      expect(ce.message).toContain("MONTHLY_SPEND_CEILING_USD");
    }
  });

  it("rejects negative MONTHLY_SPEND_CEILING_USD", () => {
    const env = makeFullEnv();
    env["MONTHLY_SPEND_CEILING_USD"] = "-5";
    try {
      parseConfig(env);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
    }
  });

  it("accepts valid numeric MONTHLY_SPEND_CEILING_USD", () => {
    const env = makeFullEnv();
    env["MONTHLY_SPEND_CEILING_USD"] = "10";
    const config = parseConfig(env);
    expect(config.monthlySpendCeilingUsd).toBe(10);
  });

  it("rejects Infinity for MONTHLY_SPEND_CEILING_USD", () => {
    const env = makeFullEnv();
    env["MONTHLY_SPEND_CEILING_USD"] = "Infinity";
    try {
      parseConfig(env);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.message).not.toContain("Infinity");
      expect(ce.message).toContain("MONTHLY_SPEND_CEILING_USD");
    }
  });

  it("rejects partial-numeric MONTHLY_SPEND_CEILING_USD like 10abc", () => {
    const env = makeFullEnv();
    env["MONTHLY_SPEND_CEILING_USD"] = "10abc";
    try {
      parseConfig(env);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
    }
  });

  it("rejects overflow MONTHLY_SPEND_CEILING_USD like 1e999", () => {
    const env = makeFullEnv();
    env["MONTHLY_SPEND_CEILING_USD"] = "1e999";
    try {
      parseConfig(env);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts known secret names from log-like strings", () => {
    const logLine = "TELEGRAM_BOT_TOKEN=123456:ABC-DEF DATABASE_URL=pg://host";
    const result = redactSecrets(logLine, ["TELEGRAM_BOT_TOKEN"]);
    expect(result).toBe("TELEGRAM_BOT_TOKEN=[REDACTED] DATABASE_URL=pg://host");
  });

  it("does not redact non-secret content", () => {
    const logLine = "event=skill_ready component=C1";
    const result = redactSecrets(logLine, ["TELEGRAM_BOT_TOKEN"]);
    expect(result).toBe("event=skill_ready component=C1");
  });

  it("redacts multiple secret names", () => {
    const logLine = "FIREWORKS_API_KEY=abc123 OMNIROUTE_API_KEY=xyz789";
    const result = redactSecrets(logLine, ["FIREWORKS_API_KEY", "OMNIROUTE_API_KEY"]);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("xyz789");
  });

  it("redacts values containing spaces", () => {
    const logLine = "PERSONA_PATH=/path/with spaces/file.md and more";
    const result = redactSecrets(logLine, ["PERSONA_PATH"]);
    expect(result).not.toContain("/path/with");
    expect(result).not.toContain("spaces");
    expect(result).not.toContain("more");
    expect(result).toContain("PERSONA_PATH=[REDACTED]");
  });

  it("does not redact differently-cased names (case-sensitive matching)", () => {
    const logLine = "telegram_bot_token=hello";
    const result = redactSecrets(logLine, ["TELEGRAM_BOT_TOKEN"]);
    expect(result).toBe("telegram_bot_token=hello");
  });
});

describe("parseConfig LLM_* env-var aliases (ADR-024@0.1.0 §Backward compatibility)", () => {
  it("boots with only new LLM_* env-var names (no legacy, no deprecation warning from config)", () => {
    const env = makeFullEnv();
    // Remove legacy names, set new names
    delete env["OMNIROUTE_BASE_URL"];
    delete env["OMNIROUTE_API_KEY"];
    delete env["FIREWORKS_API_KEY"];
    env["LLM_OMNIROUTE_BASE_URL"] = "http://new-llm.example.com/v1";
    env["LLM_OMNIROUTE_API_KEY"] = "new-omni-key";
    env["LLM_FIREWORKS_API_KEY"] = "new-fw-key";

    const config = parseConfig(env);
    expect(config.omnirouteBaseUrl).toBe("http://new-llm.example.com/v1");
    expect(config.omnirouteApiKey).toBe("new-omni-key");
    expect(config.fireworksApiKey).toBe("new-fw-key");
  });

  it("boots with only legacy env-var names (backward compat, no error)", () => {
    const env = makeFullEnv();
    // makeFullEnv already has only legacy names — just verify it works
    const config = parseConfig(env);
    expect(config.omnirouteBaseUrl).toBe("http://localhost:8000/v1");
    expect(config.omnirouteApiKey).toBe("omni-key-abc");
    expect(config.fireworksApiKey).toBe("fw-key-xyz");
  });

  it("prefers new LLM_* name over legacy when both are set", () => {
    const env = makeFullEnv();
    env["LLM_OMNIROUTE_BASE_URL"] = "http://preferred-new.example.com/v1";
    env["LLM_OMNIROUTE_API_KEY"] = "preferred-new-key";
    env["LLM_FIREWORKS_API_KEY"] = "preferred-fw-key";

    const config = parseConfig(env);
    expect(config.omnirouteBaseUrl).toBe("http://preferred-new.example.com/v1");
    expect(config.omnirouteApiKey).toBe("preferred-new-key");
    expect(config.fireworksApiKey).toBe("preferred-fw-key");
  });

  it("fails with clear error when both new and legacy names are absent", () => {
    const env = makeFullEnv();
    delete env["OMNIROUTE_BASE_URL"];
    delete env["OMNIROUTE_API_KEY"];
    delete env["FIREWORKS_API_KEY"];
    // No LLM_* names set either

    try {
      parseConfig(env);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      // The missingNames should mention both candidates
      const allMissing = ce.missingNames.join(", ");
      expect(allMissing).toContain("OMNIROUTE_BASE_URL");
      expect(allMissing).toContain("LLM_OMNIROUTE_BASE_URL");
      expect(allMissing).toContain("OMNIROUTE_API_KEY");
      expect(allMissing).toContain("LLM_OMNIROUTE_API_KEY");
      expect(allMissing).toContain("FIREWORKS_API_KEY");
      expect(allMissing).toContain("LLM_FIREWORKS_API_KEY");
    }
  });

  it("treats blank LLM_* value as absent (falls through to legacy)", () => {
    const env = makeFullEnv();
    env["LLM_OMNIROUTE_BASE_URL"] = "   ";
    env["LLM_OMNIROUTE_API_KEY"] = "";
    env["LLM_FIREWORKS_API_KEY"] = "";

    const config = parseConfig(env);
    // Falls through to legacy values
    expect(config.omnirouteBaseUrl).toBe("http://localhost:8000/v1");
    expect(config.omnirouteApiKey).toBe("omni-key-abc");
    expect(config.fireworksApiKey).toBe("fw-key-xyz");
  });

  it("exports LLM_ENV_ALIASES mapping for downstream consumers", () => {
    expect(LLM_ENV_ALIASES["OMNIROUTE_BASE_URL"]).toBe("LLM_OMNIROUTE_BASE_URL");
    expect(LLM_ENV_ALIASES["OMNIROUTE_API_KEY"]).toBe("LLM_OMNIROUTE_API_KEY");
    expect(LLM_ENV_ALIASES["FIREWORKS_API_KEY"]).toBe("LLM_FIREWORKS_API_KEY");
  });
});
