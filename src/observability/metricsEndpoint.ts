import http from "node:http";
import {
  PROMETHEUS_METRIC_NAMES,
  ALLOWED_METRIC_LABELS,
  FORBIDDEN_METRIC_LABELS,
  type PrometheusMetricName,
} from "./kpiEvents.js";

import { createModalityInstrumentedRegistry } from "./modalityMisclassificationRate.js";

export type MetricType = "counter" | "gauge" | "histogram" | "histogram_sum" | "histogram_count" | "histogram_bucket";

export interface MetricSample {
  name: string;
  type: MetricType;
  help: string;
  value: number;
  labels: Record<string, string>;
  histogramBaseName?: string;
}

export interface MetricsRegistry {
  increment(name: PrometheusMetricName, labels?: Record<string, string>, delta?: number): void;
  set(name: PrometheusMetricName, labels: Record<string, string>, value: number): void;
  observe(name: PrometheusMetricName, labels: Record<string, string>, valueMs: number): void;
  getSamples(): MetricSample[];
  render(): string;
}

function validateLabels(labels: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    const isAllowed = (ALLOWED_METRIC_LABELS as readonly string[]).includes(key);
    const isForbidden = (FORBIDDEN_METRIC_LABELS as readonly string[]).some(
      (f) => key === f || key.toLowerCase().includes(f)
    );
    if (!isAllowed || isForbidden) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function sanitizeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const pairs = entries.map(
    ([k, v]) => `${k}="${sanitizeLabelValue(v)}"`
  );
  return `{${pairs.join(",")}}`;
}

export function createMetricsRegistry(): MetricsRegistry {
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();
  const histograms = new Map<string, number[]>();

  function key(name: string, labels: Record<string, string>): string {
    const safeLabels = validateLabels(labels);
    const sorted = Object.fromEntries(
      Object.entries(safeLabels).sort(([a], [b]) => a.localeCompare(b))
    );
    const labelStr = formatLabels(sorted);
    return `${name}${labelStr}`;
  }

  return {
    increment(name, labels = {}, delta = 1) {
      const k = key(name, labels);
      counters.set(k, (counters.get(k) ?? 0) + delta);
    },

    set(name, labels, value) {
      const k = key(name, labels);
      gauges.set(k, value);
    },

    observe(name, labels, valueMs) {
      const k = key(name, labels);
      const bucket = histograms.get(k) ?? [];
      bucket.push(valueMs);
      histograms.set(k, bucket);
    },

    getSamples() {
      const samples: MetricSample[] = [];

      for (const [k, v] of counters) {
        const { name, labels } = parseKey(k);
        samples.push({ name, type: "counter", help: "", value: v, labels });
      }

      for (const [k, v] of gauges) {
        const { name, labels } = parseKey(k);
        samples.push({ name, type: "gauge", help: "", value: v, labels });
      }

      for (const [k, observations] of histograms) {
        const { name, labels } = parseKey(k);
        const sum = observations.reduce((a, b) => a + b, 0);
        const count = observations.length;
        const safeLabels = validateLabels(labels);

        samples.push({
          name: `${name}_sum`,
          type: "histogram_sum",
          help: "",
          value: sum,
          labels: safeLabels,
          histogramBaseName: name as string,
        });

        samples.push({
          name: `${name}_count`,
          type: "histogram_count",
          help: "",
          value: count,
          labels: safeLabels,
          histogramBaseName: name as string,
        });

        const bounds = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, +Infinity];
        for (const le of bounds) {
          const bucketCount = observations.filter((v) => v <= le).length;
          const leStr = Number.isFinite(le) ? String(le) : "+Inf";
          samples.push({
            name: `${name}_bucket`,
            type: "histogram_bucket",
            help: "",
            value: bucketCount,
            labels: { ...safeLabels, le: leStr },
            histogramBaseName: name as string,
          });
        }
      }

      return samples;
    },

    render() {
      const lines: string[] = [];
      const seenType = new Set<string>();

      const samples = this.getSamples();

      for (const sample of samples) {
        if (sample.type === "histogram_sum" || sample.type === "histogram_count" || sample.type === "histogram_bucket") {
          const baseName = sample.histogramBaseName!;
          if (!seenType.has(baseName)) {
            seenType.add(baseName);
            lines.push(`# HELP ${baseName} ${baseName}`);
            lines.push(`# TYPE ${baseName} histogram`);
          }
        } else {
          const name = sample.name as string;
          if (!seenType.has(name)) {
            seenType.add(name);
            lines.push(`# HELP ${name} ${name}`);
            lines.push(`# TYPE ${name} ${sample.type}`);
          }
        }

        const labelStr = formatLabels(validateLabels(sample.labels));
        lines.push(`${sample.name}${labelStr} ${sample.value}`);
      }

      return lines.join("\n") + "\n";
    },
  };
}

function parseKey(k: string): { name: PrometheusMetricName; labels: Record<string, string> } {
  const braceIdx = k.indexOf("{");
  if (braceIdx === -1) {
    return { name: k as PrometheusMetricName, labels: {} };
  }
  const name = k.substring(0, braceIdx) as PrometheusMetricName;
  const labelsStr = k.substring(braceIdx + 1, k.length - 1);
  const labels: Record<string, string> = {};
  if (labelsStr) {
    for (const pair of labelsStr.split(",")) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) continue;
      const lKey = pair.substring(0, eqIdx).trim();
      const lVal = pair.substring(eqIdx + 2, pair.length - 1);
      labels[lKey] = lVal;
    }
  }
  return { name, labels };
}

export interface MetricsServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  registry: MetricsRegistry;
  address(): string;
}

export function createMetricsServer(
  host: string,
  port: number
): MetricsServer {
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]" || host === "::ffff:0.0.0.0") {
    throw new Error(
      "Metrics server must bind to an explicit loopback or internal host; wildcard addresses (0.0.0.0, ::, [::], ::ffff:0.0.0.0) are forbidden per ARCH-001@0.3.0 §8.2"
    );
  }

  const inner = createMetricsRegistry();
  const { registry } = createModalityInstrumentedRegistry(inner);
  let server: http.Server | null = null;

  return {
    registry,

    async start() {
      server = http.createServer((req, res) => {
        if (req.url === "/metrics" && req.method === "GET") {
          const body = registry.render();
          res.writeHead(200, {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          });
          res.end(body);
        } else {
          res.writeHead(404);
          res.end("Not Found\n");
        }
      });

      await new Promise<void>((resolve, reject) => {
        if (!server) {
          reject(new Error("Server not initialized"));
          return;
        }
        server.once("error", reject);
        server.listen(port, host, () => {
          server?.removeListener("error", reject);
          resolve();
        });
      });
    },

    async stop() {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    },

    address() {
      if (!server) return "";
      const addr = server.address();
      if (typeof addr === "string") return addr;
      if (addr) return `${addr.address}:${addr.port}`;
      return "";
    },
  };
}

export function renderMetricsToText(registry: MetricsRegistry): string {
  return registry.render();
}
