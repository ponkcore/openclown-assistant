import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const DOCKERFILE_PATH = resolve(ROOT, "Dockerfile");

function readDockerfile(): string {
  return readFileSync(DOCKERFILE_PATH, "utf-8");
}

/**
 * Minimal Dockerfile parser — extracts FROM lines with their stage aliases.
 * Handles both `FROM image AS alias` and bare `FROM image` forms.
 * Does not handle ARG interpolation (not needed for our static checks).
 */
function parseStages(content: string): { image: string; alias?: string }[] {
  const stages: { image: string; alias?: string }[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and the syntax directive
    if (trimmed.startsWith("#")) continue;
    const match = trimmed.match(
      /^FROM\s+([^\s]+)(?:\s+AS\s+(\S+))?/i
    );
    if (match) {
      stages.push({ image: match[1], alias: match[2] });
    }
  }
  return stages;
}

/**
 * Return all directive lines (trimmed) in the runtime stage only.
 * The runtime stage starts at the second FROM and runs to EOF.
 */
function runtimeStageLines(content: string): string[] {
  const lines = content.split("\n");
  let runtimeStart = -1;
  let stageCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^FROM\s+/i.test(trimmed)) {
      stageCount++;
      if (stageCount === 2) {
        runtimeStart = i;
        break;
      }
    }
  }
  if (runtimeStart === -1) return [];
  return lines.slice(runtimeStart).map((l) => l.trim());
}

describe("Dockerfile", () => {
  const content = readDockerfile();

  it("exists and is non-empty", () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it("declares the BuildKit syntax directive", () => {
    expect(content).toMatch(/^# syntax=docker\/dockerfile:1/);
  });

  it("declares exactly two FROM stages", () => {
    const stages = parseStages(content);
    expect(stages.length).toBe(2);
  });

  it("first stage is named 'builder'", () => {
    const stages = parseStages(content);
    expect(stages[0].alias).toBe("builder");
  });

  it("second stage is named 'runtime'", () => {
    const stages = parseStages(content);
    expect(stages[1].alias).toBe("runtime");
  });

  it("both stages use node:24-slim base image pinned to a digest", () => {
    const stages = parseStages(content);
    for (const stage of stages) {
      expect(stage.image).toMatch(/^node:24-slim@sha256:[a-f0-9]{64}$/);
    }
  });

  it("builder stage runs npm ci (full deps)", () => {
    const lines = content.split("\n");
    let inBuilder = false;
    let foundNpmCi = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^FROM\s+/i.test(trimmed)) {
        inBuilder = trimmed.includes("builder");
        continue;
      }
      if (/^FROM\s+/i.test(trimmed) && !trimmed.includes("builder")) {
        inBuilder = false;
        continue;
      }
      if (inBuilder && /npm ci/.test(trimmed) && !/--omit=dev/.test(trimmed)) {
        foundNpmCi = true;
      }
    }
    expect(foundNpmCi, "builder stage must run 'npm ci' without --omit=dev").toBe(true);
  });

  it("builder stage runs npm run build", () => {
    const lines = content.split("\n");
    let inBuilder = false;
    let foundBuild = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^FROM\s+/i.test(trimmed)) {
        inBuilder = trimmed.includes("builder");
        continue;
      }
      if (/^FROM\s+/i.test(trimmed) && !trimmed.includes("builder")) {
        inBuilder = false;
        continue;
      }
      if (inBuilder && /^RUN\s+.*npm run build/.test(trimmed)) {
        foundBuild = true;
      }
    }
    expect(foundBuild, "builder stage must run 'npm run build'").toBe(true);
  });

  it("runtime stage runs npm ci --omit=dev (prod deps only)", () => {
    const runtimeLines = runtimeStageLines(content);
    const found = runtimeLines.some(
      (l) => /npm ci/.test(l) && /--omit=dev/.test(l)
    );
    expect(found, "runtime stage must run 'npm ci --omit=dev'").toBe(true);
  });

  it("runtime stage copies dist/ from builder", () => {
    const runtimeLines = runtimeStageLines(content);
    const found = runtimeLines.some(
      (l) => /COPY\s+--from=builder/.test(l) && /dist/.test(l)
    );
    expect(found, "runtime stage must COPY --from=builder ... dist").toBe(true);
  });

  it("runtime stage uses a non-root user (USER node)", () => {
    const runtimeLines = runtimeStageLines(content);
    const found = runtimeLines.some((l) => /^USER\s+node/.test(l));
    expect(found, "runtime stage must declare 'USER node'").toBe(true);
  });

  it("does not COPY dist/ from host (must come from builder)", () => {
    // The old single-stage pattern was: COPY dist/ ./dist/
    // In the new multi-stage, dist/ should only come via --from=builder
    const runtimeLines = runtimeStageLines(content);
    for (const line of runtimeLines) {
      if (/^COPY\s+/.test(line) && !/--from=/.test(line) && /dist/.test(line)) {
        expect.unreachable(
          `runtime stage copies dist/ from host instead of builder: ${line}`
        );
      }
    }
  });

  it("npm ci steps use BuildKit cache mounts", () => {
    const cacheMountLines = content
      .split("\n")
      .filter((l) => /--mount=type=cache/.test(l) && /npm ci/.test(l));
    expect(
      cacheMountLines.length,
      "expected at least one 'npm ci' step with --mount=type=cache"
    ).toBeGreaterThanOrEqual(1);
  });
});

describe(".dockerignore", () => {
  const dockerignorePath = resolve(ROOT, ".dockerignore");

  it("exists", () => {
    expect(existsSync(dockerignorePath)).toBe(true);
  });

  const content = existsSync(dockerignorePath)
    ? readFileSync(dockerignorePath, "utf-8")
    : "";

  it("excludes node_modules/", () => {
    expect(content).toContain("node_modules/");
  });

  it("excludes dist/", () => {
    expect(content).toContain("dist/");
  });

  it("excludes tests/", () => {
    expect(content).toContain("tests/");
  });

  it("excludes docs/", () => {
    expect(content).toContain("docs/");
  });

  it("excludes .git/", () => {
    expect(content).toContain(".git/");
  });

  it("excludes .env files (secrets)", () => {
    expect(content).toMatch(/\.env/);
  });
});

describe("docker-compose.yml build targets", () => {
  const COMPOSE_PATH = resolve(ROOT, "docker-compose.yml");
  const content = readFileSync(COMPOSE_PATH, "utf-8");

  it("kbju-sidecar build block targets the 'runtime' stage", () => {
    // Find the kbju-sidecar section
    const sidecarStart = content.indexOf("kbju-sidecar:");
    expect(sidecarStart).toBeGreaterThanOrEqual(0);
    const nextService = content.indexOf("\n  openclaw-gateway:", sidecarStart + 1);
    const sidecarSection = content.substring(
      sidecarStart,
      nextService > sidecarStart ? nextService : content.length
    );
    expect(sidecarSection).toContain("target: runtime");
  });

  it("metrics build block targets the 'runtime' stage", () => {
    const metricsStart = content.indexOf("metrics:");
    expect(metricsStart).toBeGreaterThanOrEqual(0);
    const nextSection = content.indexOf("\nvolumes:", metricsStart + 1);
    const metricsSection = content.substring(
      metricsStart,
      nextSection > metricsStart ? nextSection : content.length
    );
    expect(metricsSection).toContain("target: runtime");
  });

  it("both build blocks reference Dockerfile", () => {
    const dockerfileRefs = content.match(/dockerfile:\s*Dockerfile/g);
    expect(dockerfileRefs?.length, "expected 2 dockerfile references").toBe(2);
  });
});
