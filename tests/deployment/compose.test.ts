import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const COMPOSE_PATH = resolve(ROOT, "docker-compose.yml");
const CF_TUNNEL_PATH = resolve(ROOT, "docker-compose.cf-tunnel.yml");
const DOCKERFILE_PATH = resolve(ROOT, "Dockerfile");

const DIGEST_RE = /^[^:@\s]+@sha256:[a-f0-9]{64}$/;

function readCompose(): string {
  return readFileSync(COMPOSE_PATH, "utf-8");
}

function extractImageLines(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => l.trim().startsWith("image:"))
    .map((l) => l.trim().replace(/^image:\s*/, ""));
}

describe("docker-compose.yml", () => {
  const content = readCompose();

  it("exists and is non-empty", () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it("uses named volumes for PostgreSQL (kbju_pgdata)", () => {
    expect(content).toContain("kbju_pgdata:");
  });

  it("uses named volumes for OpenClaw state (openclaw_state)", () => {
    expect(content).toContain("openclaw_state:");
  });

  it("mounts openclaw_state into a service", () => {
    expect(content).toMatch(/openclaw_state:\/[^\s]+/);
  });

  it("does not use host bind mounts for production data", () => {
    const lines = content.split("\n");
    const volumeLines = lines.filter(
      (line) => line.trim().startsWith("- ") && line.includes(":") && !line.includes("${")
    );
    const hostBindMounts = volumeLines.filter((line) => {
      // Exclude read-only config file bind mounts (e.g. Caddyfile:ro per ADR-020@0.1.0)
      if (line.includes(":ro")) return false;
      const match = line.trim().match(/-\s+(.+):/);
      if (!match) return false;
      const source = match[1].trim();
      return (
        (source.startsWith("/") || source.startsWith("./") || source.startsWith("~")) &&
        !source.includes("var/lib/postgresql")
      );
    });
    expect(
      hostBindMounts,
      `host bind mounts for production data found: ${hostBindMounts.join("; ")}`
    ).toHaveLength(0);
  });

  it("does not use host networking", () => {
    expect(content).not.toMatch(/network_mode:\s*host/);
  });

  it("metrics service binds to host loopback only via ports", () => {
    expect(content).toMatch(/127\.0\.0\.1:9464:9464/);
  });

  it("does not expose metrics on wildcard host addresses", () => {
    const portLines = content
      .split("\n")
      .filter((l) => l.trim().startsWith("- ") && l.includes(":9464"));
    for (const line of portLines) {
      expect(line, `wildcard port mapping found: ${line}`).not.toMatch(
        /-\s*"0\.0\.0\.0:9464/
      );
      expect(line, `wildcard port mapping found: ${line}`).not.toMatch(/-\s*":::9464/);
    }
  });

  it("Docker logs have bounded rotation (max-size and max-file)", () => {
    const services = content.split(/^  \w/m);
    for (const svc of services) {
      if (svc.includes("logging:")) {
        expect(svc).toContain("max-size");
        expect(svc).toContain("max-file");
      }
    }
  });

  it("uses internal network (not host)", () => {
    expect(content).toContain("internal:");
  });

  it("postgres uses the named volume kbju_pgdata", () => {
    expect(content).toContain("kbju_pgdata:/var/lib/postgresql/data");
  });

  it("metrics service has a healthcheck querying /healthz", () => {
    expect(content).toMatch(/metrics:[\s\S]*healthcheck:[\s\S]*\/healthz/);
  });

  it("metrics METRICS_HOST is not a wildcard address", () => {
    expect(content).not.toMatch(/METRICS_HOST:\s*"0\.0\.0\.0"/);
    expect(content).not.toMatch(/METRICS_HOST:\s*"::"/);
    expect(content).not.toMatch(/METRICS_HOST:\s*"\[::\]"/);
    const hostMatch = content.match(/METRICS_HOST:\s*"([^"]+)"/);
    expect(hostMatch, "METRICS_HOST not found").not.toBeNull();
    const host = hostMatch![1];
    expect(
      host === "127.0.0.1" || host === "::1" || /^[a-zA-Z]/.test(host),
      `METRICS_HOST "${host}" is neither loopback nor Docker-internal hostname`
    ).toBe(true);
  });

  it("metrics healthcheck uses container-internal hostname, not loopback", () => {
    const healthcheckLine = content
      .split("\n")
      .find((l) => l.includes("healthz") && l.includes("metrics:9464"));
    expect(healthcheckLine, "no healthcheck line with metrics:9464 found").toBeDefined();
    expect(healthcheckLine!).toContain("http://metrics:9464/healthz");
  });

  it("kbju-sidecar service has a healthcheck using /kbju/health, not metrics port", () => {
    const sidecarStart = content.indexOf("  kbju-sidecar:");
    expect(sidecarStart).toBeGreaterThanOrEqual(0);

    const gatewayStart = content.indexOf("\n  openclaw-gateway:", sidecarStart + 1);
    const postgresStart = content.indexOf("\n  postgres:", sidecarStart + 1);
    const endBoundary =
      gatewayStart > sidecarStart && postgresStart > sidecarStart
        ? Math.min(gatewayStart, postgresStart)
        : Math.max(gatewayStart, postgresStart);

    const sidecarSection = content.substring(
      sidecarStart,
      endBoundary > sidecarStart ? endBoundary : content.length
    );
    expect(sidecarSection).not.toContain("9464/healthz");
    expect(sidecarSection).not.toContain("9464/metrics");
    expect(sidecarSection).toContain("/kbju/health");
    expect(sidecarSection).toContain("healthcheck:");
  });

  it("openclaw-gateway service exists and depends on kbju-sidecar", () => {
    expect(content).toContain("openclaw-gateway:");
    expect(content).toContain("KBJU_SIDECAR_URL");
  });

  // --- TKT-043@0.1.0: digest-pinning assertions ---

  it("every image: reference uses the image@sha256:<digest> form (no bare tags)", () => {
    const imageLines = extractImageLines(content);
    expect(imageLines.length, "no image: lines found").toBeGreaterThan(0);
    for (const img of imageLines) {
      expect(
        DIGEST_RE.test(img),
        `image "${img}" does not match image@sha256:<64-hex-chars> form`
      ).toBe(true);
    }
  });

  it("no :latest tag remains in any image: reference", () => {
    const imageLines = extractImageLines(content);
    for (const img of imageLines) {
      expect(
        img,
        `image "${img}" contains :latest`
      ).not.toMatch(/:latest/);
    }
  });
});

describe("Dockerfile", () => {
  const dockerfileContent = readFileSync(DOCKERFILE_PATH, "utf-8");

  it("does not define image-level HEALTHCHECK", () => {
    expect(dockerfileContent).not.toContain("HEALTHCHECK");
  });

  // --- TKT-043@0.1.0: digest-pinning assertions ---

  it("every FROM line pins the base image to a digest", () => {
    const fromLines = dockerfileContent
      .split("\n")
      .filter((l) => /^FROM\s+/i.test(l.trim()));
    expect(fromLines.length, "no FROM lines found").toBeGreaterThan(0);
    for (const line of fromLines) {
      const match = line.match(/^FROM\s+(\S+)/i);
      expect(match, `cannot parse FROM line: ${line}`).toBeDefined();
      const imageRef = match![1];
      // Allow AS alias after the image ref
      const baseImage = imageRef;
      expect(
        /^.+@sha256:[a-f0-9]{64}$/.test(baseImage),
        `FROM image "${baseImage}" is not pinned to a digest`
      ).toBe(true);
    }
  });
});


describe("docker-compose.yml — caddy service (ADR-020@0.1.1)", () => {
  const content = readCompose();

  function extractCaddySection(): string {
    const caddyStart = content.indexOf("  caddy:");
    if (caddyStart < 0) return "";
    // The caddy service ends at the next top-level key (a line starting with
    // a non-space character) or at EOF.
    const afterCaddy = content.substring(caddyStart);
    const nextTopLevel = afterCaddy.search(/\n[a-z]/);
    const caddySection = nextTopLevel > 0
      ? afterCaddy.substring(0, nextTopLevel)
      : afterCaddy;
    return caddySection;
  }

  it("caddy service exists", () => {
    expect(content).toContain("  caddy:");
  });

  it("caddy uses a digest-pinned image", () => {
    expect(content).toMatch(/image:\s*caddy@sha256:[a-f0-9]{64}/);
  });

  it("caddy exposes ports 80 and 443", () => {
    expect(content).toMatch(/-\s*"80:80"/);
    expect(content).toMatch(/-\s*"443:443"/);
  });

  it("caddy mounts Caddyfile read-only", () => {
    expect(content).toContain("./Caddyfile:/etc/caddy/Caddyfile:ro");
  });

  it("caddy uses caddy_data named volume for /data", () => {
    expect(content).toContain("caddy_data:/data");
  });

  it("caddy uses caddy_config named volume for /config", () => {
    expect(content).toContain("caddy_config:/config");
  });

  it("caddy_data and caddy_config are declared as top-level named volumes", () => {
    expect(content).toMatch(/^  caddy_data:\s*$/m);
    expect(content).toMatch(/^  caddy_config:\s*$/m);
  });

  it("caddy sets KBJU_PUBLIC_DOMAIN from env", () => {
    expect(content).toContain("KBJU_PUBLIC_DOMAIN: ${KBJU_PUBLIC_DOMAIN}");
  });

  it("caddy depends on openclaw-gateway", () => {
    const section = extractCaddySection();
    expect(section).toContain("depends_on");
    expect(section).toContain("openclaw-gateway");
  });

  it("caddy has a healthcheck using curl to /health", () => {
    const section = extractCaddySection();
    expect(section).toContain("healthcheck");
    expect(section).toContain("curl");
    expect(section).toContain("http://localhost/health");
  });

  it("caddy has restart: unless-stopped", () => {
    const section = extractCaddySection();
    expect(section).toContain("restart: unless-stopped");
  });

  it("caddy is on the internal network", () => {
    const section = extractCaddySection();
    expect(section).toContain("- internal");
  });

  it("caddy does not use host networking", () => {
    expect(content).not.toMatch(/network_mode:\s*host/);
  });

  it("no host bind mount for production data — Caddyfile is the only host-path bind and it is read-only", () => {
    const section = extractCaddySection();
    const volumeLines = section
      .split("\n")
      .filter((l) => l.trim().startsWith("- ") && l.includes(":"));
    const hostBindMounts = volumeLines.filter((l) => {
      const match = l.trim().match(/-\s+(.+):/);
      if (!match) return false;
      const src = match[1].trim();
      return src.startsWith("/") || src.startsWith("./") || src.startsWith("~");
    });
    expect(hostBindMounts.length).toBe(1);
    expect(hostBindMounts[0]).toContain(":ro");
  });
});

describe("Caddyfile (ADR-020@0.1.1)", () => {
  const caddyfilePath = resolve(ROOT, "Caddyfile");
  const caddyContent = readFileSync(caddyfilePath, "utf-8");

  it("exists and is non-empty", () => {
    expect(caddyContent.length).toBeGreaterThan(0);
  });

  it("references {\$KBJU_PUBLIC_DOMAIN}", () => {
    expect(caddyContent).toContain("{$KBJU_PUBLIC_DOMAIN}");
  });

  it("reverse-proxies /telegram to openclaw-gateway", () => {
    expect(caddyContent).toMatch(/reverse_proxy\s+\/telegram\s+openclaw-gateway/);
  });

  it("reverse-proxies /telegram/* to openclaw-gateway", () => {
    expect(caddyContent).toMatch(/reverse_proxy\s+\/telegram\/\*\s+openclaw-gateway/);
  });

  it("/health endpoint returns kbju-caddy-ok 200", () => {
    expect(caddyContent).toContain('respond "kbju-caddy-ok" 200');
  });
});

describe("docker-compose.cf-tunnel.yml (ADR-020@0.1.1 §Override path)", () => {
  const cfContent = readFileSync(CF_TUNNEL_PATH, "utf-8");

  it("exists and is non-empty", () => {
    expect(cfContent.length).toBeGreaterThan(0);
  });

  it("caddy service has profiles: [\"disabled\"]", () => {
    expect(cfContent).toContain("caddy:");
    expect(cfContent).toMatch(/profiles:\s*\["disabled"\]/);
  });

  it("cloudflared service exists", () => {
    expect(cfContent).toContain("cloudflared:");
  });

  it("cloudflared uses a digest-pinned image", () => {
    expect(cfContent).toMatch(/image:\s*cloudflare\/cloudflared@sha256:[a-f0-9]{64}/);
  });

  it("cloudflared command references CLOUDFLARED_TUNNEL_TOKEN", () => {
    expect(cfContent).toContain("CLOUDFLARED_TUNNEL_TOKEN");
  });

  it("cloudflared has restart: unless-stopped", () => {
    expect(cfContent).toContain("restart: unless-stopped");
  });

  it("cloudflared is on the internal network", () => {
    expect(cfContent).toContain("- internal");
  });

  // --- TKT-043@0.1.0: digest-pinning assertions ---

  it("every image: reference uses the image@sha256:<digest> form (no bare tags)", () => {
    const imageLines = extractImageLines(cfContent);
    // Only cloudflared has an image line in this overlay
    expect(imageLines.length, "no image: lines found").toBeGreaterThan(0);
    for (const img of imageLines) {
      expect(
        DIGEST_RE.test(img),
        `image "${img}" does not match image@sha256:<64-hex-chars> form`
      ).toBe(true);
    }
  });

  it("no :latest tag remains in any image: reference", () => {
    const imageLines = extractImageLines(cfContent);
    for (const img of imageLines) {
      expect(
        img,
        `image "${img}" contains :latest`
      ).not.toMatch(/:latest/);
    }
  });
});
