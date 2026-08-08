import { aiEnv, requireGeminiApiKey } from "../../config/env.ts";
import {
  RateLimitError,
  StructuredOutputError,
  type EmbedRequest,
  type EmbedResult,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
} from "../types.ts";

/**
 * Gemini adapter over the raw REST API — deliberately no SDK, matching the
 * pre-existing integration style (`app/api/cpv-map/route.ts`). Two endpoints:
 * `:batchEmbedContents` for embeddings, `:generateContent` for structured
 * generation.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_ATTEMPTS = 3;

interface GeminiErrorBody {
  error?: { message?: string; status?: string };
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      // Network failure — retry with backoff.
      lastError = error instanceof Error ? error : new Error(String(error));
      await backoff(attempt);
      continue;
    }

    if (response.ok) return response;

    const body = (await response
      .json()
      .catch(() => ({}))) as GeminiErrorBody;
    const message = body.error?.message || `Gemini HTTP ${response.status}`;

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : null;
      if (attempt === MAX_ATTEMPTS) {
        throw new RateLimitError(message, retryAfterMs);
      }
      await backoff(attempt, retryAfterMs);
      continue;
    }

    if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
      lastError = new Error(message);
      await backoff(attempt);
      continue;
    }

    throw new Error(message);
  }
  throw lastError ?? new Error("Gemini request failed");
}

function backoff(attempt: number, retryAfterMs: number | null = null): Promise<void> {
  const base = retryAfterMs ?? 1000 * 2 ** (attempt - 1);
  const jittered = base + Math.random() * 500;
  return new Promise((resolve) => setTimeout(resolve, jittered));
}

/** Truncated MRL vectors are no longer unit-length; cosine math expects
 * normalized vectors, so normalize whenever we truncate (Gemini docs). */
export function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const v of vector) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0 || !Number.isFinite(norm)) return vector;
  return vector.map((v) => v / norm);
}

export interface GeminiProviderOptions {
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class GeminiProvider {
  readonly name = "gemini";
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(model: string, request: EmbedRequest): Promise<EmbedResult> {
    const env = aiEnv();
    const apiKey = requireGeminiApiKey();
    const dimensions = env.embeddingDimensions;
    const vectors: number[][] = [];

    for (let i = 0; i < request.texts.length; i += env.embeddingBatchSize) {
      const batch = request.texts.slice(i, i + env.embeddingBatchSize);
      const response = await fetchWithRetry(
        `${BASE}/${encodeURIComponent(model)}:batchEmbedContents`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            requests: batch.map((text) => ({
              model: `models/${model}`,
              content: { parts: [{ text }] },
              taskType: request.taskType,
              outputDimensionality: dimensions,
            })),
          }),
        },
        this.fetchImpl,
      );

      const data = (await response.json()) as {
        embeddings?: Array<{ values?: number[] }>;
      };
      const batchVectors = data.embeddings?.map((e) => e.values ?? []) ?? [];
      if (batchVectors.length !== batch.length) {
        throw new Error(
          `Gemini returned ${batchVectors.length} embeddings for ${batch.length} inputs`,
        );
      }
      for (const vector of batchVectors) {
        if (vector.length !== dimensions) {
          throw new Error(
            `Gemini returned ${vector.length}-dim vector, expected ${dimensions}`,
          );
        }
        vectors.push(l2Normalize(vector));
      }
    }

    return {
      vectors,
      model,
      version: env.embeddingVersion,
      dimensions,
    };
  }

  async generateStructured<T>(
    model: string,
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    const apiKey = requireGeminiApiKey();
    const response = await fetchWithRetry(
      `${BASE}/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
          generationConfig: {
            temperature: request.temperature ?? 0,
            responseMimeType: "application/json",
            responseJsonSchema: request.schema,
          },
        }),
        cache: "no-store",
      },
      this.fetchImpl,
    );

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("") || "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StructuredOutputError(
        `Gemini returned non-JSON output for model ${model}`,
      );
    }

    const result = request.zod.safeParse(parsed);
    if (!result.success) {
      throw new StructuredOutputError(
        `Gemini output failed schema validation: ${result.error.message}`,
      );
    }

    return { value: result.data, provider: this.name, model };
  }
}
