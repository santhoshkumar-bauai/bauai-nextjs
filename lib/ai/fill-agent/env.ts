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
   * held server-side in Mongo so the model cannot reset it. Sized so the
   * agent can keep looping until the layout converges on long forms; it is
   * a runaway backstop, not a working ceiling. */
  fillBudget: number;
  /** Repair rounds allowed between validates (anti-oscillation, re-armed by
   * every fill_and_validate). */
  repairRounds: number;
  /** Hard per-turn SSE timeout for fill turns. A 25-50 page form's planning
   * call plus several repair rounds legitimately outlives the 300s chat
   * default. */
  turnTimeoutMs: number;
  /** Score at which the fill is accepted and uploaded (Python: 0.95). */
  targetScore: number;
  maxUploadBytes: number;
  maxPages: number;
  /** Source-page renders available to the one whole-document planning call.
   * Sol's long context is used deliberately here. Repair calls ignore this
   * budget and remain crop-local. */
  maxPlanImages: number;
  /** Hard per-attempt deadline for one planner sub-call (plan/critique/
   * repair). A quota-starved deployment 429s with 60s Retry-After headers,
   * and the SDK's internal retries would otherwise eat the entire 300s turn
   * budget and surface as an empty "aborted" message. Failing fast turns
   * that into a readable tool error the agent can report. */
  plannerCallTimeoutMs: number;
  /** Whole-document planner payload caps. Repair payloads remain local. */
  geometryCharCap: number;
  nativeFieldsCharCap: number;
  repairPayloadCharCap: number;
  /** Adaptive workflow limits. */
  batchSize: number;
  regionRepairAttempts: number;
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
    fillBudget: intFromEnv("AI_FILL_AGENT_FILL_BUDGET", 13),
    repairRounds: intFromEnv("AI_FILL_AGENT_REPAIR_ROUNDS", 3),
    turnTimeoutMs: intFromEnv("AI_FILL_AGENT_TURN_TIMEOUT_MS", 300_000),
    targetScore: floatFromEnv("AI_FILL_AGENT_TARGET_SCORE", 0.95),
    maxUploadBytes: intFromEnv("FILL_AGENT_MAX_UPLOAD_BYTES", 20 * 1024 * 1024),
    maxPages: intFromEnv("FILL_AGENT_MAX_PAGES", 50),
    maxPlanImages: Math.min(
      intFromEnv("FILL_AGENT_MAX_PAGES", 50),
      intFromEnv("AI_FILL_AGENT_MAX_PLAN_IMAGES", intFromEnv("FILL_AGENT_MAX_PAGES", 50)),
    ),
    plannerCallTimeoutMs: intFromEnv("AI_FILL_AGENT_PLANNER_TIMEOUT_MS", 300_000),
    geometryCharCap: intFromEnv("AI_FILL_AGENT_GEOMETRY_CHAR_CAP", 700_000),
    nativeFieldsCharCap: intFromEnv("AI_FILL_AGENT_NATIVE_FIELDS_CHAR_CAP", 120_000),
    repairPayloadCharCap: intFromEnv("AI_FILL_AGENT_REPAIR_PAYLOAD_CHAR_CAP", 80_000),
    batchSize: 4,
    regionRepairAttempts: 3,
  };
  return cached;
}

/** Test hook: drop the cache so env overrides apply. */
export function resetFillAgentEnvForTests(): void {
  cached = null;
}

/**
 * Whether the ONLYOFFICE editor panel's PDF chat runs the fill agent instead
 * of read-only Dora. On by default; set FILL_AGENT_EDITOR_ENABLED=false to
 * fall back to the previous behavior without a deploy.
 */
export function fillAgentEditorEnabled(): boolean {
  return process.env.FILL_AGENT_EDITOR_ENABLED !== "false";
}
