/**
 * stdin → redactPii → stdout stream helper
 *
 * Used by `scripts/diag-bundle.sh` via:
 *   docker compose exec -T kbju-sidecar node /app/dist/src/incident/redactStream.js
 *
 * Reads stdin line-by-line, applies the existing `redactPii` allowlist
 * (TKT-015@0.1.0 + TKT-026@0.1.0) to each JSON-line, and writes the
 * redacted line to stdout. Non-JSON lines pass through after applying
 * the PII regex patterns to the raw string (for plain-text log lines).
 *
 * Per ADR-021@0.1.0 §diag-bundle.sh contract: redaction is applied via
 * the runtime redactPii helper, NOT a re-implementation in shell.
 */

import { redactPii } from "../observability/events.js";

const ENCODING = "utf-8" as const;

/**
 * Apply the existing redactPii PII regex patterns to a single string value.
 *
 * Strategy: wrap the value under an `ALLOWED_EXTRA_KEYS` key (`error_code`)
 * so redactPii preserves it, then extract the redacted result.
 * This is the same trick used by diagHandler.ts `redactStringValue`.
 */
function redactStringValue(value: string): string {
  const wrapped = redactPii({ error_code: value });
  const redacted = wrapped.error_code;
  return typeof redacted === "string" ? redacted : value;
}

function processLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length === 0) return line;

  // Try to parse as JSON — if it works, redact the object via allowlist
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const redacted = redactPii(obj);
    return JSON.stringify(redacted);
  } catch {
    // Not JSON — apply PII regex patterns to the raw string
    return redactStringValue(line);
  }
}

async function main(): Promise<void> {
  process.stdin.setEncoding(ENCODING);

  for await (const chunk of process.stdin) {
    const lines = String(chunk).split("\n");
    const output: string[] = [];
    for (const line of lines) {
      if (line === "" && lines.indexOf(line) === lines.length - 1) {
        // Preserve trailing newline handling
        output.push("");
        continue;
      }
      output.push(processLine(line));
    }
    process.stdout.write(output.join("\n"));
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`redactStream fatal: ${String(err)}\n`);
  process.exit(1);
});
