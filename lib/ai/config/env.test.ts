import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiEnv, resetAiEnvCache } from "./env.ts";

const AI_ENV_KEYS = [
  "EMBEDDING_MODEL",
  "EMBEDDING_VERSION",
  "EMBEDDING_DIMENSIONS",
  "EMBEDDING_BATCH_SIZE",
  "EMBEDDING_RPM",
  "AI_MODEL_ROLES",
  "AI_REDIS_PREFIX",
  "AI_WORKER_CONCURRENCY",
  "AI_USE_RANK_FUSION",
  "AI_RERANKER",
  "CHUNKER_VERSION",
  "CHUNK_TARGET_TOKENS",
  "CHUNK_MAX_TOKENS",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of AI_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetAiEnvCache();
});

afterEach(() => {
  for (const key of AI_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAiEnvCache();
});

describe("aiEnv", () => {
  it("provides complete defaults with no env set", () => {
    const env = aiEnv();
    expect(env.embeddingModel).toBe("gemini-embedding-001");
    expect(env.embeddingDimensions).toBe(1536);
    expect(env.modelRoles.embedding).toBe("gemini:gemini-embedding-001");
    expect(env.useRankFusion).toBe(false);
    expect(env.reranker).toBe("noop");
  });

  it("parses numeric overrides", () => {
    process.env.EMBEDDING_DIMENSIONS = "768";
    process.env.EMBEDDING_BATCH_SIZE = "32";
    const env = aiEnv();
    expect(env.embeddingDimensions).toBe(768);
    expect(env.embeddingBatchSize).toBe(32);
  });

  it('treats AI_USE_RANK_FUSION="false" as false', () => {
    process.env.AI_USE_RANK_FUSION = "false";
    expect(aiEnv().useRankFusion).toBe(false);
  });

  it('treats AI_USE_RANK_FUSION="true" as true', () => {
    process.env.AI_USE_RANK_FUSION = "true";
    expect(aiEnv().useRankFusion).toBe(true);
  });

  it("parses AI_MODEL_ROLES JSON and rejects malformed refs", () => {
    process.env.AI_MODEL_ROLES = JSON.stringify({
      embedding: "openai:text-embedding-3-large",
    });
    expect(aiEnv().modelRoles.embedding).toBe("openai:text-embedding-3-large");

    resetAiEnvCache();
    process.env.AI_MODEL_ROLES = JSON.stringify({ embedding: "not-a-ref" });
    expect(() => aiEnv()).toThrow();
  });

  it("rejects batch sizes above the Gemini API cap", () => {
    process.env.EMBEDDING_BATCH_SIZE = "200";
    expect(() => aiEnv()).toThrow();
  });
});
