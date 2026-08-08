import { z } from "zod";

import { aiEnv } from "../config/env.ts";
import { getGateway } from "../gateway/index.ts";
import type { RetrievedChunk } from "./types.ts";

/**
 * Reranker slot (§17.3). The pilot default is a no-op passthrough — the real
 * cross-encoder (bge-reranker-v2-m3) arrives with the Python worker. An
 * optional LLM-scored implementation exists behind `AI_RERANKER=llm` for
 * quality experiments; it is not the default because it adds a generation
 * call per query.
 */

export interface Reranker {
  rerank(query: string, chunks: RetrievedChunk[], k: number): Promise<RetrievedChunk[]>;
}

class NoopReranker implements Reranker {
  async rerank(
    _query: string,
    chunks: RetrievedChunk[],
    k: number,
  ): Promise<RetrievedChunk[]> {
    return chunks.slice(0, k);
  }
}

const llmVerdictSchema = z.object({
  // Index list, best first, subset of the offered indexes.
  ranking: z.array(z.number().int().min(0)),
});

class LlmReranker implements Reranker {
  async rerank(
    query: string,
    chunks: RetrievedChunk[],
    k: number,
  ): Promise<RetrievedChunk[]> {
    if (chunks.length <= k) return chunks;
    const listing = chunks
      .map((chunk, index) => `[${index}] ${chunk.text.slice(0, 500)}`)
      .join("\n\n");
    try {
      const result = await getGateway().generateStructured({
        role: "extraction",
        prompt: [
          `Query: ${query}`,
          "",
          "Rank the following passages by how directly they answer the query.",
          `Return the indexes of the best ${k} passages, best first.`,
          "",
          listing,
        ].join("\n"),
        schema: {
          type: "object",
          properties: {
            ranking: {
              type: "array",
              items: { type: "integer", minimum: 0, maximum: chunks.length - 1 },
              maxItems: k,
            },
          },
          required: ["ranking"],
          additionalProperties: false,
        },
        zod: llmVerdictSchema,
      });
      const seen = new Set<number>();
      const ordered = result.value.ranking
        .filter((index) => index < chunks.length && !seen.has(index) && seen.add(index))
        .map((index) => chunks[index]);
      // Model may return fewer than k — fill from the fused order.
      for (const chunk of chunks) {
        if (ordered.length >= k) break;
        if (!ordered.includes(chunk)) ordered.push(chunk);
      }
      return ordered.slice(0, k);
    } catch {
      // Reranking is an optimization; never fail retrieval over it.
      return chunks.slice(0, k);
    }
  }
}

export function getReranker(): Reranker {
  return aiEnv().reranker === "llm" ? new LlmReranker() : new NoopReranker();
}
