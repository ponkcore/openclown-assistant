export interface AppConfig {
  telegramBotToken: string;
  telegramPilotUserIds: string[];
  databaseUrl: string;
  postgresPassword: string;
  omnirouteBaseUrl: string;
  omnirouteApiKey: string;
  fireworksApiKey: string;
  usdaFdcApiKey: string;
  personaPath: string;
  poAlertChatId: string;
  monthlySpendCeilingUsd: number;
  auditDbUrl: string;
}

export const REQUIRED_CONFIG_NAMES = [
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
  "AUDIT_DB_URL",
] as const;

export type RequiredConfigName = (typeof REQUIRED_CONFIG_NAMES)[number];

/**
 * Alias mapping per ADR-024@0.1.0 §Backward compatibility.
 * Each legacy env var has a canonical LLM_* replacement.
 * `parseConfig` treats a var as present if EITHER name is set,
 * and prefers the new name when both are present.
 * The deprecation warning is emitted in the registry layer (one-shot,
 * per-var, `kbju_llm_legacy_env_in_use{var}`), NOT here.
 */
export const LLM_ENV_ALIASES: Readonly<Record<string, string>> = {
  OMNIROUTE_BASE_URL: "LLM_OMNIROUTE_BASE_URL",
  OMNIROUTE_API_KEY: "LLM_OMNIROUTE_API_KEY",
  FIREWORKS_API_KEY: "LLM_FIREWORKS_API_KEY",
};

export class ConfigError extends Error {
  public readonly missingNames: readonly string[];

  constructor(missingNames: readonly string[]);
  constructor(missingNames: readonly string[], message: string);
  constructor(missingNames: readonly string[], message?: string) {
    const fieldList = missingNames.join(", ");
    super(message ?? `Missing required config: ${fieldList}`);
    this.name = "ConfigError";
    this.missingNames = missingNames;
  }
}

/**
 * Read an env var that has an LLM_* alias.
 * Returns the value from the new name if set; falls back to the legacy name.
 * Returns undefined when neither is set.
 */
function readAliasedEnv(
  env: Record<string, string | undefined>,
  legacyName: string,
): string | undefined {
  const newName = LLM_ENV_ALIASES[legacyName];
  if (newName) {
    const newValue = env[newName];
    if (newValue !== undefined && newValue.trim() !== "") return newValue.trim();
  }
  const legacyValue = env[legacyName];
  if (legacyValue !== undefined && legacyValue.trim() !== "") return legacyValue.trim();
  return undefined;
}

/**
 * Check whether an env var (or its LLM_* alias) is present and non-empty.
 */
function isAliasedPresent(
  env: Record<string, string | undefined>,
  legacyName: string,
): boolean {
  return readAliasedEnv(env, legacyName) !== undefined;
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const missing: string[] = [];

  for (const name of REQUIRED_CONFIG_NAMES) {
    if (name in LLM_ENV_ALIASES) {
      // Aliased var: present if either the new name or legacy name is set
      if (!isAliasedPresent(env, name)) {
        const newName = LLM_ENV_ALIASES[name];
        missing.push(`${name} (or ${newName})`);
      }
    } else {
      if (!env[name] || env[name]!.trim() === "") {
        missing.push(name);
      }
    }
  }

  if (missing.length > 0) {
    throw new ConfigError(missing);
  }

  return {
    telegramBotToken: env["TELEGRAM_BOT_TOKEN"]!.trim(),
    telegramPilotUserIds: env["TELEGRAM_PILOT_USER_IDS"]!.split(",").map((s) => s.trim()),
    databaseUrl: env["DATABASE_URL"]!.trim(),
    postgresPassword: env["POSTGRES_PASSWORD"]!.trim(),
    omnirouteBaseUrl: readAliasedEnv(env, "OMNIROUTE_BASE_URL")!,
    omnirouteApiKey: readAliasedEnv(env, "OMNIROUTE_API_KEY")!,
    fireworksApiKey: readAliasedEnv(env, "FIREWORKS_API_KEY")!,
    usdaFdcApiKey: env["USDA_FDC_API_KEY"]!.trim(),
    personaPath: env["PERSONA_PATH"]!.trim(),
    poAlertChatId: env["PO_ALERT_CHAT_ID"]!.trim(),
    monthlySpendCeilingUsd: (() => {
      const raw = env["MONTHLY_SPEND_CEILING_USD"]!.trim();
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new ConfigError(
          ["MONTHLY_SPEND_CEILING_USD"],
          `Invalid numeric value for MONTHLY_SPEND_CEILING_USD`
        );
      }
      return parsed;
    })(),
    auditDbUrl: env["AUDIT_DB_URL"]!.trim(),
  };
}

export function redactSecrets(input: string, secretNames: readonly string[]): string {
  let result = input;
  const allNames = REQUIRED_CONFIG_NAMES as readonly string[];
  const otherNamePattern = allNames
    .map((n) => escapeRegExp(n))
    .join("|");
  for (const name of secretNames) {
    const escaped = escapeRegExp(name);
    const pattern = new RegExp(
      escaped + `=([^\\n]*?)(?=(?:\\s(?:${otherNamePattern})=)|\\n|$)`,
      "g"
    );
    result = result.replace(pattern, `${name}=[REDACTED]`);
  }
  return result;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
