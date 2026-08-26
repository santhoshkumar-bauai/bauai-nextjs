import { ContentFilterError, RateLimitError, StructuredOutputError } from "../gateway/types.ts";

/**
 * Provider-neutral failure classification.
 *
 * The classifier this replaces read `error.message` with regexes shaped around
 * Gemini's wording (`invalid.?argument`, `RESOURCE_EXHAUSTED`). Azure phrases
 * the same conditions completely differently, so those patterns quietly
 * degraded every real failure to "something went wrong" — which is the one
 * answer that helps nobody.
 *
 * The order below is the whole design: typed errors first, then structured
 * HTTP fields, and provider prose only as a last resort. Text matching is
 * kept, not deleted — Gemini still serves embeddings and will be in the tree
 * for a long time — but it can no longer shadow a definite answer.
 */
export type AiFailureCode =
  /** Provider 429. Retryable, and the user should be told to wait. */
  | "rate_limited"
  /** A safety filter blocked the prompt or the completion. NOT our bug. */
  | "content_filtered"
  /** Context or output budget exceeded. */
  | "too_long"
  /** The provider refused the request: bad schema, unsupported parameter. */
  | "provider_rejected"
  /** Credentials missing, expired, or lacking a role assignment. */
  | "auth_failed"
  /** Transport never reached the provider. */
  | "network_failed"
  /** No such model or deployment. */
  | "model_unavailable"
  /** The graph hit its recursion limit — a runaway tool loop. */
  | "loop_exhausted"
  /** The model answered, but not in the shape the schema demanded. */
  | "invalid_output"
  | "timeout"
  | "aborted"
  | "failed";

interface HttpLikeError {
  status?: number;
  code?: string;
  type?: string;
  error?: { code?: string; type?: string; innererror?: { code?: string } };
  message?: string;
  name?: string;
}

/** OpenAI/Azure put the machine-readable code in several places. */
function providerCode(error: HttpLikeError): string {
  return (
    error.code ??
    error.error?.code ??
    error.error?.innererror?.code ??
    error.error?.type ??
    error.type ??
    ""
  );
}

function fromStatus(status: number, code: string): AiFailureCode {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "model_unavailable";
  if (status === 408 || status === 504) return "timeout";
  if (status === 400) {
    if (/content_filter|responsible_?ai/i.test(code)) return "content_filtered";
    if (/context_length|string_above_max_length|too_long|max_tokens/i.test(code)) {
      return "too_long";
    }
    return "provider_rejected";
  }
  if (status >= 500) return "provider_rejected";
  return "failed";
}

export function classifyAiError(error: unknown): AiFailureCode {
  if (!error) return "failed";

  // 1. Our own typed errors. These carry the most information and are the
  //    only ones that can describe an HTTP 200 that nonetheless failed.
  if (error instanceof RateLimitError) return "rate_limited";
  if (error instanceof ContentFilterError) return "content_filtered";
  if (error instanceof StructuredOutputError) {
    return /truncat|max_output|finish_reason="?length/i.test(error.message)
      ? "too_long"
      : "invalid_output";
  }

  const candidate = error as HttpLikeError;
  const name = candidate.name ?? "";
  const message = candidate.message ?? String(error);

  // 2. Errors identified by class name, so this module need not import
  //    @langchain/langgraph or three provider SDKs just to name them.
  if (name === "GraphRecursionError") return "loop_exhausted";
  if (name === "ZodError") return "invalid_output";
  if (name === "AbortError" || name === "ModelAbortError" || message === "aborted") {
    return "aborted";
  }
  if (name === "RateLimitError") return "rate_limited";
  if (name === "TimeoutError") return "timeout";

  // 3. Structured HTTP. One branch covers the OpenAI SDK's APIError and the
  //    Anthropic and Google bindings, all of which expose `status`.
  if (typeof candidate.status === "number") {
    return fromStatus(candidate.status, providerCode(candidate));
  }

  // 4. Transport-level failures never reach an HTTP status.
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)) {
    return "network_failed";
  }
  if (/abort/i.test(message)) return "aborted";
  if (/timed? ?out/i.test(message)) return "timeout";

  // 5. Provider prose, last. Gemini's vocabulary lives here; it is still the
  //    embedding provider, so this stays useful for a long time yet.
  if (/RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message)) return "rate_limited";
  if (/content.?filter|safety|blocked|PROHIBITED_CONTENT/i.test(message)) {
    return "content_filtered";
  }
  if (/context.?length|too.?long|token.?limit/i.test(message)) return "too_long";
  if (/api.?key|unauthori[sz]ed|forbidden|credential|\b401\b|\b403\b/i.test(message)) {
    return "auth_failed";
  }
  if (/not found|unavailable|deployment.*exist|\b404\b/i.test(message)) {
    return "model_unavailable";
  }
  if (/INVALID_ARGUMENT|schema|response.?format|unsupported|\b400\b/i.test(message)) {
    return "provider_rejected";
  }

  return "failed";
}

/** Codes worth retrying; the rest will fail again the same way. */
export function isRetryableFailure(code: AiFailureCode): boolean {
  return code === "rate_limited" || code === "network_failed" || code === "timeout";
}

/**
 * Provider text, safe to persist next to a failure.
 *
 * Strips anything that could carry a credential. Entra bearer tokens and the
 * resource hostname are as sensitive as the Gemini key this originally
 * guarded, and both appear in Azure error payloads.
 */
export function redactProviderDetail(error: unknown, maxLength = 1_000): string | null {
  if (!(error instanceof Error)) return null;
  return error.message
    .replace(/https?:\/\/\S+/gi, "[provider-url]")
    .replace(/AIza[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[redacted-key]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-token]")
    .slice(0, maxLength)
    .trim();
}
