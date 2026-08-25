/**
 * Fill-agent POC configuration. Kept separate from lib/ai/config/env.ts on
 * purpose — the POC namespace owns its own knobs, and promotion later means
 * folding these into AiEnvSchema, not untangling them.
 */

export interface FillAgentEnv {
  /** Base URL of the fill-sandbox sidecar (docker/fill-sandbox). */
  sandboxUrl: string;
  /** Shared bearer token; must match the sidecar's FILL_SANDBOX_TOKEN. */
  sandboxToken: string;
  /** Tool-loop iterations per chat turn (model calls, not fill rounds). */
  maxIterations: number;
  /** fill_and_validate rounds per SESSION — the Python POC's max_iterations,
   * held server-side in Mongo so the model cannot reset it. */
  fillBudget: number;
  /** Score at which the fill is accepted and uploaded (Python: 0.95). */
  targetScore: number;
  maxUploadBytes: number;
  maxPages: number;
}

let cached: FillAgentEnv | null = null;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function floatFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

export function fillAgentEnv(): FillAgentEnv {
  cached ??= {
    sandboxUrl: process.env.FILL_SANDBOX_URL || "http://127.0.0.1:8971",
    sandboxToken: process.env.FILL_SANDBOX_TOKEN || "dev-fill-sandbox-token",
    maxIterations: intFromEnv("AI_FILL_AGENT_MAX_ITERATIONS", 12),
    fillBudget: intFromEnv("AI_FILL_AGENT_FILL_BUDGET", 5),
    targetScore: floatFromEnv("AI_FILL_AGENT_TARGET_SCORE", 0.95),
    maxUploadBytes: intFromEnv("FILL_AGENT_MAX_UPLOAD_BYTES", 20 * 1024 * 1024),
    maxPages: intFromEnv("FILL_AGENT_MAX_PAGES", 15),
  };
  return cached;
}

/** Test hook: drop the cache so env overrides apply. */
export function resetFillAgentEnvForTests(): void {
  cached = null;
}
