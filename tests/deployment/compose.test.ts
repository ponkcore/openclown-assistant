import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const COMPOSE_PATH = resolve(ROOT, "docker-compose.yml");

function readCompose(): string {
  return readFileSync(COMPOSE_PATH, "utf-8");
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
      // Exclude read-only config file bind mounts (e.g. Caddyfile:ro per ADR-020.1.0)
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
});

describe("Dockerfile", () => {
  const dockerfilePath = resolve(ROOT, "Dockerfile");
  const dockerfileContent = readFileSync(dockerfilePath, "utf-8");

  it("does not define image-level HEALTHCHECK", () => {
    expect(dockerfileContent).not.toContain("HEALTHCHECK");
  });
});


describe("docker-compose.yml — caddy service (ADR-020@0.1.0)", () => {
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

  it("caddy uses caddy:2-alpine image", () => {
    expect(content).toMatch(/image:\s*caddy:2-alpine/);
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

describe("Caddyfile (ADR-020@0.1.0)", () => {
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

describe("docker-compose.cf-tunnel.yml (ADR-020@0.1.0 §Override path)", () => {
  const cfTunnelPath = resolve(ROOT, "docker-compose.cf-tunnel.yml");
  const cfContent = readFileSync(cfTunnelPath, "utf-8");

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

  it("cloudflared uses the cloudflare/cloudflared image", () => {
    expect(cfContent).toMatch(/image:\s*cloudflare\/cloudflared/);
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
});
