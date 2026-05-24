import http from "node:http";
import { REQUIRED_CONFIG_NAMES } from "../shared/config.js";
import type { MetricsRegistry } from "../observability/metricsEndpoint.js";

const METRICS_HOST = process.env.METRICS_HOST ?? "127.0.0.1";
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9464);

export interface HealthCheckResult {
  readonly status: "ok" | "unhealthy";
  readonly timestamp: string;
  readonly uptimeSeconds: number;
}

let serverStartTime: number | null = null;

let _metricsRegistry: MetricsRegistry | null = null;

/** Wire the shared metrics registry so /metrics renders real data. */
export function setMetricsRegistry(registry: MetricsRegistry): void {
  _metricsRegistry = registry;
}

export function healthCheck(): boolean {
  for (const name of REQUIRED_CONFIG_NAMES) {
    const value = process.env[name];
    if (!value || value.trim() === "") {
      return false;
    }
  }
  return true;
}

export function getHealthStatus(): HealthCheckResult {
  const healthy = healthCheck();
  return {
    status: healthy ? "ok" : "unhealthy",
    timestamp: new Date().toISOString(),
    uptimeSeconds: serverStartTime !== null
      ? Math.floor((Date.now() - serverStartTime) / 1000)
      : 0,
  };
}

export function startMetricsServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === "/metrics" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(_metricsRegistry ? _metricsRegistry.render() : "# KBJU Coach metrics endpoint\nkbju_health_check_status 1\n");
    } else if (req.url === "/healthz" && req.method === "GET") {
      const status = getHealthStatus();
      const code = status.status === "ok" ? 200 : 503;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    } else {
      res.writeHead(404);
      res.end("Not Found\n");
    }
  });

  if (
    METRICS_HOST === "0.0.0.0" ||
    METRICS_HOST === "::" ||
    METRICS_HOST === "[::]" ||
    METRICS_HOST === "::ffff:0.0.0.0"
  ) {
    console.error(
      "Metrics server must bind to loopback or Docker-internal host; wildcard addresses (0.0.0.0, ::, [::]) forbidden per ARCH-001@0.4.0 §8.2/§11 C10"
    );
    process.exit(1);
  }

  server.listen(METRICS_PORT, METRICS_HOST, () => {
    serverStartTime = Date.now();
    console.log(`Metrics server listening on ${METRICS_HOST}:${METRICS_PORT}`);
  });
}
