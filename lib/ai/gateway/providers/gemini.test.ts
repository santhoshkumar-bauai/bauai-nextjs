import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { resetAiEnvCache } from "../../config/env.ts";
import { RateLimitError, StructuredOutputError } from "../types.ts";
import { GeminiProvider, l2Normalize } from "./gemini.ts";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function embeddingBody(count: number, dims: number) {
  return {
    embeddings: Array.from({ length: count }, () => ({
      values: Array.from({ length: dims }, (_, i) => (i === 0 ? 3 : 4) / 5),
    })),
  };
}

const DIMS = 8;

beforeEach(() => {
  vi.useRealTimers();
  process.env.GEMINI_API_KEY = "test-key";
  process.env.EMBEDDING_DIMENSIONS = String(DIMS);
  process.env.EMBEDDING_BATCH_SIZE = "2";
  resetAiEnvCache();
});

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.EMBEDDING_BATCH_SIZE;
  resetAiEnvCache();
});

describe("l2Normalize", () => {
  it("produces unit-length vectors", () => {
    const normalized = l2Normalize([3, 4]);
    expect(normalized[0]).toBeCloseTo(0.6);
    expect(normalized[1]).toBeCloseTo(0.8);
  });

  it("leaves the zero vector alone", () => {
    expect(l2Normalize([0, 0])).toEqual([0, 0]);
  });
});

describe("GeminiProvider.embed", () => {
  it("splits inputs into batches and returns normalized vectors in order", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        requests: unknown[];
      };
      calls.push({ url: String(url), body });
      return jsonResponse(200, embeddingBody(body.requests.length, DIMS));
    }) as unknown as typeof fetch;

    const provider = new GeminiProvider({ fetchImpl });
    const result = await provider.embed("gemini-embedding-001", {
      texts: ["a", "b", "c"],
      taskType: "RETRIEVAL_DOCUMENT",
    });

    // Batch size 2 → two calls (2 + 1).
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain(":batchEmbedContents");
    expect(result.vectors).toHaveLength(3);
    expect(result.dimensions).toBe(DIMS);
    for (const vector of result.vectors) {
      const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    }
  });

  it("sends the task type and output dimensionality", async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        requests: Array<Record<string, unknown>>;
      };
      captured = body.requests[0];
      return jsonResponse(200, embeddingBody(body.requests.length, DIMS));
    }) as unknown as typeof fetch;

    await new GeminiProvider({ fetchImpl }).embed("gemini-embedding-001", {
      texts: ["query"],
      taskType: "RETRIEVAL_QUERY",
    });

    expect(captured).toMatchObject({
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: DIMS,
    });
  });

  it("retries a 500 then succeeds", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      attempt += 1;
      if (attempt === 1) return jsonResponse(500, { error: { message: "boom" } });
      const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
      return jsonResponse(200, embeddingBody(body.requests.length, DIMS));
    }) as unknown as typeof fetch;

    const result = await new GeminiProvider({ fetchImpl }).embed(
      "gemini-embedding-001",
      { texts: ["a"], taskType: "RETRIEVAL_DOCUMENT" },
    );
    expect(attempt).toBe(2);
    expect(result.vectors).toHaveLength(1);
  });

  it("throws RateLimitError after exhausting retries on 429", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { error: { message: "quota" } }, { "retry-after": "0" }),
    ) as unknown as typeof fetch;

    await expect(
      new GeminiProvider({ fetchImpl }).embed("gemini-embedding-001", {
        texts: ["a"],
        taskType: "RETRIEVAL_DOCUMENT",
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
  }, 15_000);

  it("rejects a vector of the wrong dimensionality", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, embeddingBody(1, DIMS + 1)),
    ) as unknown as typeof fetch;

    await expect(
      new GeminiProvider({ fetchImpl }).embed("gemini-embedding-001", {
        texts: ["a"],
        taskType: "RETRIEVAL_DOCUMENT",
      }),
    ).rejects.toThrow(/dim/);
  });
});

describe("GeminiProvider.generateStructured", () => {
  const zodSchema = z.object({ answer: z.string() });
  const jsonSchema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  };

  function generationResponse(text: string) {
    return {
      candidates: [{ content: { parts: [{ text }] } }],
    };
  }

  it("parses and validates a structured response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, generationResponse('{"answer":"ja"}')),
    ) as unknown as typeof fetch;

    const result = await new GeminiProvider({ fetchImpl }).generateStructured(
      "gemini-2.5-flash-lite",
      { role: "extraction", prompt: "p", schema: jsonSchema, zod: zodSchema },
    );
    expect(result.value.answer).toBe("ja");
    expect(result.provider).toBe("gemini");
  });

  it("throws StructuredOutputError on non-JSON output", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, generationResponse("not json")),
    ) as unknown as typeof fetch;

    await expect(
      new GeminiProvider({ fetchImpl }).generateStructured("m", {
        role: "extraction",
        prompt: "p",
        schema: jsonSchema,
        zod: zodSchema,
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it("throws StructuredOutputError when the zod contract is violated", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, generationResponse('{"wrong":"shape"}')),
    ) as unknown as typeof fetch;

    await expect(
      new GeminiProvider({ fetchImpl }).generateStructured("m", {
        role: "extraction",
        prompt: "p",
        schema: jsonSchema,
        zod: zodSchema,
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it("sends temperature zero by default", async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(200, generationResponse('{"answer":"x"}'));
    }) as unknown as typeof fetch;

    await new GeminiProvider({ fetchImpl }).generateStructured("m", {
      role: "extraction",
      prompt: "p",
      schema: jsonSchema,
      zod: zodSchema,
    });

    const config = (captured as Record<string, unknown> | null)
      ?.generationConfig as Record<string, unknown> | undefined;
    expect(config?.temperature).toBe(0);
  });
});
