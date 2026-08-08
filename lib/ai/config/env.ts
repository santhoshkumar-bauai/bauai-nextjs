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
const BoolFromEnv = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

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
  return {
    embedding: `gemini:${process.env.EMBEDDING_MODEL || "gemini-embedding-001"}`,
    extraction: generation,
    reasoning: generation,
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
