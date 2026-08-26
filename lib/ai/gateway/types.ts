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
  /** Dora's streaming edit tier: latency-first single-point document edits. */
  | "dora_fast"
  /** Dora's high-precision document field discovery and grounding role. */
  | "dora_fill"
  /**
   * The same job for PDFs, where the model reads the file itself rather than a
   * structural snapshot. Split from dora_fill because vision-grade scan
   * analysis has different needs from OOXML node analysis, and because a
   * regression in one must not be forced on the other.
   */
  | "dora_pdf_fill"
  /** GAEB bill-of-quantities pricing: position classification + unit-price
   * suggestion batches. Split like the other fill roles so chat model changes
   * cannot alter priced offers. */
  | "dora_gaeb_fill"
  /** Search-grounded product price lookups for GAEB pricing evidence. */
  | "dora_gaeb_web"
  /** Otto, the onboarding guide: profiling, planning and step-by-step guidance. */
  | "otto"
  /**
   * Iris, the generative-UI agent (POC). Every turn is a routing decision —
   * which of fifteen view tools to call, with which ids — and the answer is
   * two sentences beside the rendered block. Latency is what the surface is
   * judged on, so it gets its own role rather than inheriting the chat
   * agent's depth-first settings.
   */
  | "iris"
  /** Chat-based PDF form-filling agent (POC). Pinned like the other fill
   * roles — a chat model change must not silently alter a filled form — and
   * vision-capable: it reads rendered pages and 400dpi inspection crops. */
  | "fill_agent"
  /** Fill-agent planning (node_plan): maps a whole template into a fieldmap.
   * The hardest reasoning in the loop and it runs once per template — the
   * sol tier. Falls back to `fill_agent` until a sol deployment exists. */
  | "fill_agent_plan"
  /** Fill-agent visual critique (node_critique): a narrow checklist over
   * rendered pages and 400dpi crops — needs vision, not depth. The terra
   * tier; falls back to `fill_agent`. On the final iteration before
   * escalation the critique is promoted to the plan tier instead. */
  | "fill_agent_critique"
  /** Fill-agent repair (node_repair): structured issues in, small JSON patch
   * out. The luna tier; falls back to `fill_agent`. */
  | "fill_agent_repair";

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

/**
 * Thrown when a provider safety filter blocked the prompt or the completion.
 *
 * Its own class because it is the one failure here that is neither our bug nor
 * the user's, and it needs its own message: "the AI service is busy" is wrong
 * and "failed" is useless. Azure content filtering has no Gemini analogue in
 * this codebase, and probe P12 confirmed it blocks ordinary German
 * procurement text — a Leistungsverzeichnis covering Sprengarbeiten,
 * correctional facilities and medical waste is routine construction work here.
 *
 * The dangerous shape is the completion-side one: HTTP **200** with
 * `finish_reason: "content_filter"` and empty content, invisible to any status
 * check. Adapters must detect it explicitly and throw this.
 */
export class ContentFilterError extends Error {
  /** "prompt" | "completion" — which side tripped, when the provider says. */
  readonly stage: "prompt" | "completion" | "unknown";
  constructor(message: string, stage: "prompt" | "completion" | "unknown" = "unknown") {
    super(message);
    this.name = "ContentFilterError";
    this.stage = stage;
  }
}
