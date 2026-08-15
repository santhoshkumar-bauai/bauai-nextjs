import type { z } from "zod";

/**
 * Provider-agnostic model access (roadmap: "central model gateway
 * abstraction — model provider must remain swappable"). Call sites know only
 * a role; `AI_MODEL_ROLES` maps roles to "provider:model" so swapping
 * providers is a config change, never a code change.
 */

export type ModelRole =
  | "embedding"
  | "extraction"
  | "reasoning"
  | "agent"
  /** Long-form tender report — the most demanding synthesis in the product. */
  | "report"
  /** AI tender matching: judges the company against 200 candidate tenders. */
  | "match"
  /** Dora, the document assistant: brief generation + editor-side chat. */
  | "dora"
  /** Otto, the onboarding guide: profiling, planning and step-by-step guidance. */
  | "otto";

/** Mirrors the retrieval asymmetry of embedding models: documents and
 * queries are embedded with different task hints. */
export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface EmbedRequest {
  texts: string[];
  taskType: EmbedTaskType;
}

export interface EmbedResult {
  /** One vector per input text, in order. L2-normalized. */
  vectors: number[][];
  /** Identity for persistence (§17.1) — callers never hardcode these. */
  model: string;
  version: string;
  dimensions: number;
}

export interface GenerateStructuredRequest<T> {
  role: Exclude<ModelRole, "embedding">;
  prompt: string;
  /** JSON schema sent to the provider's structured-output mode. */
  schema: Record<string, unknown>;
  /** Zod schema the parsed response must satisfy — the real contract. */
  zod: z.ZodType<T>;
  temperature?: number;
}

export interface GenerateStructuredResult<T> {
  value: T;
  provider: string;
  model: string;
}

export interface ModelGateway {
  embed(request: EmbedRequest): Promise<EmbedResult>;
  generateStructured<T>(
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>>;
}

/** Thrown on provider 429s so queue workers can delay-retry (§10.4). */
export class RateLimitError extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown when a provider response fails schema validation after retries. */
export class StructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}
