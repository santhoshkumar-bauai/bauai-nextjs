import { createServer, type Server } from "node:http";

import { ingestionEnv } from "../config/env.ts";
import { logger } from "./logger.ts";

const log = logger.child("metrics");

type Labels = Record<string, string>;

interface Sample {
  help: string;
  type: "counter" | "gauge" | "histogram";
  values: Map<string, { labels: Labels; value: number; buckets?: number[]; count?: number; sum?: number }>;
}

const registry = new Map<string, Sample>();

/** Histogram buckets in milliseconds, sized for the section 15.1 latency SLOs. */
const latencyBuckets = [50, 250, 1_000, 5_000, 30_000, 120_000, 300_000, 900_000];

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

function slot(name: string, help: string, type: Sample["type"], labels: Labels) {
  let sample = registry.get(name);
  if (!sample) {
    sample = { help, type, values: new Map() };
    registry.set(name, sample);
  }
  const id = key(labels);
  let entry = sample.values.get(id);
  if (!entry) {
    entry = { labels, value: 0 };
    if (type === "histogram") {
      entry.buckets = new Array(latencyBuckets.length).fill(0);
      entry.count = 0;
      entry.sum = 0;
    }
    sample.values.set(id, entry);
  }
  return entry;
}

export const metrics = {
  increment(name: string, labels: Labels = {}, by = 1, help = name): void {
    slot(name, help, "counter", labels).value += by;
  },

  gauge(name: string, value: number, labels: Labels = {}, help = name): void {
    slot(name, help, "gauge", labels).value = value;
  },

  observe(name: string, milliseconds: number, labels: Labels = {}, help = name): void {
    const entry = slot(name, help, "histogram", labels);
    entry.count = (entry.count ?? 0) + 1;
    entry.sum = (entry.sum ?? 0) + milliseconds;
    for (let i = 0; i < latencyBuckets.length; i += 1) {
      if (milliseconds <= latencyBuckets[i]) entry.buckets![i] += 1;
    }
  },

  /** Prometheus text exposition of everything recorded so far. */
  render(): string {
    const lines: string[] = [];
    for (const [name, sample] of registry) {
      lines.push(`# HELP ${name} ${sample.help}`);
      lines.push(`# TYPE ${name} ${sample.type}`);
      for (const entry of sample.values.values()) {
        const labelText = Object.entries(entry.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(",");
        const suffix = labelText ? `{${labelText}}` : "";
        if (sample.type === "histogram") {
          let cumulative = 0;
          for (let i = 0; i < latencyBuckets.length; i += 1) {
            cumulative = entry.buckets![i];
            const sep = labelText ? "," : "";
            lines.push(`${name}_bucket{${labelText}${sep}le="${latencyBuckets[i]}"} ${cumulative}`);
          }
          const sep = labelText ? "," : "";
          lines.push(`${name}_bucket{${labelText}${sep}le="+Inf"} ${entry.count}`);
          lines.push(`${name}_sum${suffix} ${entry.sum}`);
          lines.push(`${name}_count${suffix} ${entry.count}`);
        } else {
          lines.push(`${name}${suffix} ${entry.value}`);
        }
      }
    }
    return `${lines.join("\n")}\n`;
  },
};

/**
 * Every worker exposes `/metrics` and `/healthz` so Docker health checks and a
 * scraper can see per-source watermarks, queue age, and dead-letter depth (§15.2).
 */
export function startMetricsServer(port: number, isHealthy: () => boolean): Server {
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      const healthy = isHealthy();
      response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: healthy ? "ok" : "unhealthy" }));
      return;
    }
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(metrics.render());
      return;
    }
    response.writeHead(404).end();
  });

  server.listen(port, () => log.info("metrics server listening", { port }));
  server.on("error", (error) => log.error("metrics server error", { error: String(error) }));
  return server;
}

export const metricsPort = Number.parseInt(
  process.env.INGESTION_METRICS_PORT ?? "9464",
  10,
);

export const shadowMode = ingestionEnv.shadowMode;
