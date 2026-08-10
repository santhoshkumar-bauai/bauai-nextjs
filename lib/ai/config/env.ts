import { z } from "zod";

/**
 * AI subsystem configuration. Unlike `lib/ingestion/config/env.ts` (which is
 * eager and throws at import), this module validates lazily on first access so
 * that importing AI code from the Next.js app never crashes a build or a route
 * that does not touch the AI stack. Secrets (GEMINI_API_KEY) are asserted only
 * by the code paths that call the provider.
 */

const ModelRoleRef = z
  .string()
  .regex(/^[a-z0-9-]+:[A-Za-z0-9._-]+$/, 'expected "provider:model"');

/** `z.coerce.boolean()` maps "false" → true; env flags need real parsing. */
const boolFromEnv = (fallback: "true" | "false" = "false") =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback)
    .transform((v) => v === "true" || v === "1");

const BoolFromEnv = boolFromEnv();

const AiEnvSchema = z.object({
  /** Embedding model identity — stamped onto every stored vector (§17.1). */
  embeddingModel: z.string().default("gemini-embedding-001"),
  embeddingVersion: z.string().default("2026-08"),
  /** MRL truncation target; vectors are L2-normalized after truncation. */
  embeddingDimensions: z.coerce.number().int().positive().default(1536),
  /** Gemini batchEmbedContents caps at 100 texts per call. */
  embeddingBatchSize: z.coerce.number().int().min(1).max(100).default(64),
  /** Requests per minute across all embedding calls (BullMQ limiter). */
  embeddingRpm: z.coerce.number().int().positive().default(100),

  /**
   * Role → "provider:model" map. Roles are the only thing call sites know;
   * providers/models swap here without touching callers.
   */
  modelRoles: z.record(z.string(), ModelRoleRef),

  /** Hash-tagged so all BullMQ keys land on one Redis Cluster slot. */
  redisPrefix: z.string().default("{bauai:ai}"),
  workerConcurrency: z.coerce.number().int().positive().default(4),

  useRankFusion: BoolFromEnv,
  reranker: z.enum(["noop", "llm"]).default("noop"),

  chunkerVersion: z.string().default("v1"),
  chunkTargetTokens: z.coerce.number().int().positive().default(500),
  chunkMaxTokens: z.coerce.number().int().positive().default(1200),

  classifierVersion: z.string().default("v1"),

  /**
   * Tool-loop iterations per chat turn before the forced-finalize path. Raised
   * with the expanded registry: a coverage check followed by a report section
   * and a document search is now a normal, correct three-call turn, and the old
   * cap of 6 forced a finalize mid-investigation on top of that.
   */
  agentMaxIterations: z.coerce.number().int().positive().default(8),
  /** Global (non-tender) chats need longer find→drill-in tool chains. */
  agentGlobalMaxIterations: z.coerce.number().int().positive().default(10),
  /**
   * Generous because thinking models spend reasoning tokens from the SAME
   * budget — 2048 starved gemini-3.5-flash into empty answers on complex
   * multi-tool turns.
   */
  agentMaxOutputTokens: z.coerce.number().int().positive().default(8192),
  /** Conversation messages kept in model context (UI history is unlimited). */
  agentHistoryMaxMessages: z.coerce.number().int().positive().default(30),
  /**
   * Reasoning effort for thinking-capable agent models, mapped per provider
   * (Gemini thinkingConfig, OpenAI reasoningEffort, Anthropic thinking
   * budget). Unset = provider default.
   */
  agentReasoningEffort: z.enum(["none", "low", "medium", "high"]).optional(),

  /**
   * The full tender report is a single very long synthesis over every artifact
   * the system holds, so it gets its own budget rather than the agent's: a
   * large output allowance and, by default, maximum reasoning effort.
   */
  reportMaxOutputTokens: z.coerce.number().int().positive().default(32_768),
  reportReasoningEffort: z
    .enum(["none", "low", "medium", "high"])
    .default("high"),
  /** Tender document excerpts fed to the report prompt. */
  reportMaxTenderChunks: z.coerce.number().int().positive().default(40),
  /** Company document excerpts fed to the report prompt. */
  reportMaxCompanyChunks: z.coerce.number().int().positive().default(16),

  /**
   * AI tender matching. The company is embedded as several facet vectors,
   * each retrieves against the notice vector index, the lists are fused with
   * the deterministic CPV/geo/time ranking, and the head of the result is
   * judged by an LLM. Everything here bounds cost or recall.
   */
  matchEnabled: boolFromEnv("true"),
  /** Rows served per company — also the judging depth. */
  matchRankCap: z.coerce.number().int().positive().default(200),
  /** Distinct tenders kept after fusion, before scoring. */
  matchPoolCap: z.coerce.number().int().positive().default(400),
  /** $vectorSearch `limit` per facet. */
  matchCandidatesPerFacet: z.coerce.number().int().positive().default(250),
  /** $vectorSearch `numCandidates`; generous because deadline/isVisible are
   * post-filters and would otherwise starve the pool. */
  matchNumCandidates: z.coerce.number().int().positive().default(4000),
  matchMaxFacets: z.coerce.number().int().positive().default(24),
  matchJudgeBatch: z.coerce.number().int().positive().default(10),
  matchJudgeConcurrency: z.coerce.number().int().positive().default(3),
  /** A finished run older than this is refreshed by the sweep. */
  matchStaleHours: z.coerce.number().int().positive().default(6),
  /** Phase-4 BM25 arm over tender_search_documents.text. */
  matchLexical: BoolFromEnv,
  /**
   * Fusion arm weights, exposed as env so a ranking regression can be rolled
   * back without a deploy: `AI_MATCH_W_TEXT_ARM=0 AI_MATCH_W_RULE_ARM=1.2`
   * restores the pre-text-arm ordering exactly.
   */
  matchRuleArmWeight: z.coerce.number().min(0).default(0.6),
  matchTextArmWeight: z.coerce.number().min(0).default(0.9),
  matchPipelineVersion: z.string().default("v2"),
  matchProfileVersion: z.string().default("v1"),

  /** Context cap for the retrieval-targeted extraction path. */
  extractionMaxChunks: z.coerce.number().int().positive().default(16),
  /** Context cap for the full-document extraction path. */
  extractionMaxDocChars: z.coerce.number().int().positive().default(150_000),
  extractionRpm: z.coerce.number().int().positive().default(30),
  extractionConcurrency: z.coerce.number().int().positive().default(2),
});

export type AiEnv = z.infer<typeof AiEnvSchema>;

function parseModelRoles(raw: string | undefined) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error(
      `AI_MODEL_ROLES must be JSON like {"embedding":"gemini:gemini-embedding-001"}, received: ${raw}`,
    );
  }
}

/** Honors the pre-existing GEMINI_MODEL env for generation roles so the
 * gateway migration is behavior-identical for already-deployed setups. */
function defaultModelRoles(): Record<string, string> {
  const generation = `gemini:${process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"}`;
  const agent = "gemini:gemini-3.5-flash";
  return {
    embedding: `gemini:${process.env.EMBEDDING_MODEL || "gemini-embedding-001"}`,
    extraction: generation,
    reasoning: generation,
    // The agent needs stronger multi-step tool reasoning than the pipeline
    // roles; deliberately NOT derived from GEMINI_MODEL.
    agent,
    /**
     * The report deserves the best model available. Point it at one explicitly
     * via AI_MODEL_ROLES.report (or the AI_REPORT_MODEL shortcut) — it falls
     * back to the agent model only so an unconfigured deployment still works.
     */
    report: process.env.AI_REPORT_MODEL || agent,
    /**
     * AI matching judges 200 tenders against the whole company profile — the
     * product's discovery surface, so it gets its own top-tier role rather
     * than sharing `reasoning` with the pipeline. Falls back through the
     * report model so an unconfigured deployment still works.
     */
    match: process.env.AI_MATCH_MODEL || process.env.AI_REPORT_MODEL || agent,
  };
}

let cached: AiEnv | null = null;

export function aiEnv(): AiEnv {
  if (cached) return cached;
  cached = AiEnvSchema.parse({
    embeddingModel: process.env.EMBEDDING_MODEL,
    embeddingVersion: process.env.EMBEDDING_VERSION,
    embeddingDimensions: process.env.EMBEDDING_DIMENSIONS,
    embeddingBatchSize: process.env.EMBEDDING_BATCH_SIZE,
    embeddingRpm: process.env.EMBEDDING_RPM,
    modelRoles: {
      ...defaultModelRoles(),
      ...parseModelRoles(process.env.AI_MODEL_ROLES),
    },
    redisPrefix: process.env.AI_REDIS_PREFIX,
    workerConcurrency: process.env.AI_WORKER_CONCURRENCY,
    useRankFusion: process.env.AI_USE_RANK_FUSION,
    reranker: process.env.AI_RERANKER,
    chunkerVersion: process.env.CHUNKER_VERSION,
    chunkTargetTokens: process.env.CHUNK_TARGET_TOKENS,
    chunkMaxTokens: process.env.CHUNK_MAX_TOKENS,
    classifierVersion: process.env.CLASSIFIER_VERSION,
    agentMaxIterations: process.env.AI_AGENT_MAX_ITERATIONS,
    agentGlobalMaxIterations: process.env.AI_AGENT_GLOBAL_MAX_ITERATIONS,
    agentMaxOutputTokens: process.env.AI_AGENT_MAX_OUTPUT_TOKENS,
    agentHistoryMaxMessages: process.env.AI_AGENT_HISTORY_MAX_MESSAGES,
    agentReasoningEffort: process.env.AI_AGENT_REASONING,
    reportMaxOutputTokens: process.env.AI_REPORT_MAX_OUTPUT_TOKENS,
    reportReasoningEffort: process.env.AI_REPORT_REASONING,
    reportMaxTenderChunks: process.env.AI_REPORT_MAX_TENDER_CHUNKS,
    reportMaxCompanyChunks: process.env.AI_REPORT_MAX_COMPANY_CHUNKS,
    matchEnabled: process.env.AI_MATCH_ENABLED,
    matchRankCap: process.env.AI_MATCH_RANK_CAP,
    matchPoolCap: process.env.AI_MATCH_POOL_CAP,
    matchCandidatesPerFacet: process.env.AI_MATCH_CANDIDATES_PER_FACET,
    matchNumCandidates: process.env.AI_MATCH_NUM_CANDIDATES,
    matchMaxFacets: process.env.AI_MATCH_MAX_FACETS,
    matchJudgeBatch: process.env.AI_MATCH_JUDGE_BATCH,
    matchJudgeConcurrency: process.env.AI_MATCH_JUDGE_CONCURRENCY,
    matchStaleHours: process.env.AI_MATCH_STALE_HOURS,
    matchLexical: process.env.AI_MATCH_LEXICAL,
    matchRuleArmWeight: process.env.AI_MATCH_W_RULE_ARM,
    matchTextArmWeight: process.env.AI_MATCH_W_TEXT_ARM,
    matchPipelineVersion: process.env.MATCH_PIPELINE_VERSION,
    matchProfileVersion: process.env.COMPANY_PROFILE_VERSION,
    extractionMaxChunks: process.env.AI_EXTRACTION_MAX_CHUNKS,
    extractionMaxDocChars: process.env.AI_EXTRACTION_MAX_DOC_CHARS,
    extractionRpm: process.env.AI_EXTRACTION_RPM,
    extractionConcurrency: process.env.AI_EXTRACTION_CONCURRENCY,
  });
  return cached;
}

/** Test hook: drop the cache so env overrides take effect. */
export function resetAiEnvCache(): void {
  cached = null;
}

export function requireGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured. Add it to .env.local.");
  }
  return key;
}
