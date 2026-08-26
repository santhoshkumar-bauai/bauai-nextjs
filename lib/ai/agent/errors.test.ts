import { describe, expect, it } from "vitest";

import { ContentFilterError, RateLimitError, StructuredOutputError } from "../gateway/types.ts";
import { classifyAiError, isRetryableFailure, redactProviderDetail } from "./errors.ts";

/** The shape the OpenAI SDK throws (openai/core/error). */
function apiError(status: number, code: string, message = "boom") {
  return Object.assign(new Error(message), {
    status,
    code,
    type: "invalid_request_error",
    error: { code, type: "invalid_request_error", message },
  });
}

describe("classifyAiError", () => {
  it("reads our typed errors first", () => {
    expect(classifyAiError(new RateLimitError("slow down", 1_000))).toBe("rate_limited");
    expect(classifyAiError(new ContentFilterError("blocked", "completion"))).toBe(
      "content_filtered",
    );
    expect(classifyAiError(new StructuredOutputError("failed schema validation"))).toBe(
      "invalid_output",
    );
  });

  it("separates a truncated structured response from a malformed one", () => {
    // Probe P14: an exhausted budget returns HTTP 200 with empty content, so
    // the adapter reports truncation. Calling that "invalid output" sends the
    // reader to the schema instead of to the token budget.
    expect(
      classifyAiError(new StructuredOutputError("truncated — raise AI_ROLE_MAX_OUTPUT_TOKENS")),
    ).toBe("too_long");
  });

  it("classifies OpenAI/Azure API errors by status", () => {
    expect(classifyAiError(apiError(429, "rate_limit_exceeded"))).toBe("rate_limited");
    expect(classifyAiError(apiError(401, "unauthorized"))).toBe("auth_failed");
    expect(classifyAiError(apiError(404, "DeploymentNotFound"))).toBe("model_unavailable");
    expect(classifyAiError(apiError(500, "server_error"))).toBe("provider_rejected");
  });

  it("splits 400s by their machine-readable code", () => {
    expect(classifyAiError(apiError(400, "content_filter"))).toBe("content_filtered");
    expect(classifyAiError(apiError(400, "context_length_exceeded"))).toBe("too_long");
    // The real one from this deployment: temperature 0.2 on a reasoning model.
    expect(classifyAiError(apiError(400, "unsupported_value"))).toBe("provider_rejected");
  });

  it("finds the code in Azure's nested innererror", () => {
    const error = Object.assign(new Error("blocked"), {
      status: 400,
      error: { innererror: { code: "ResponsibleAIPolicyViolation" } },
    });
    expect(classifyAiError(error)).toBe("content_filtered");
  });

  it("names a runaway graph without importing langgraph", () => {
    const error = Object.assign(new Error("Recursion limit of 25 reached"), {
      name: "GraphRecursionError",
    });
    expect(classifyAiError(error)).toBe("loop_exhausted");
  });

  it("still understands Gemini's vocabulary", () => {
    // Gemini remains the embedding provider, so its prose has to keep
    // classifying — it just no longer shadows a structured answer.
    expect(classifyAiError(new Error("429 RESOURCE_EXHAUSTED: quota exceeded"))).toBe(
      "rate_limited",
    );
    expect(classifyAiError(new Error("400 INVALID_ARGUMENT: bad response schema"))).toBe(
      "provider_rejected",
    );
    expect(classifyAiError(new Error("PROHIBITED_CONTENT"))).toBe("content_filtered");
  });

  it("prefers a status over prose that disagrees with it", () => {
    // A 429 whose message happens to mention a schema is still a rate limit.
    expect(classifyAiError(apiError(429, "rate_limit_exceeded", "schema quota"))).toBe(
      "rate_limited",
    );
  });

  it("recognises aborts and transport failures", () => {
    expect(classifyAiError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("aborted");
    expect(classifyAiError(new Error("aborted"))).toBe("aborted");
    expect(classifyAiError(new Error("fetch failed"))).toBe("network_failed");
    expect(classifyAiError(new Error("ECONNRESET"))).toBe("network_failed");
  });

  it("falls back to `failed` rather than guessing", () => {
    expect(classifyAiError(new Error("something odd"))).toBe("failed");
    expect(classifyAiError(null)).toBe("failed");
    expect(classifyAiError(undefined)).toBe("failed");
  });
});

describe("isRetryableFailure", () => {
  it("retries only what a retry could fix", () => {
    expect(isRetryableFailure("rate_limited")).toBe(true);
    expect(isRetryableFailure("network_failed")).toBe(true);
    // Retrying a blocked prompt or a bad schema just spends money twice.
    expect(isRetryableFailure("content_filtered")).toBe(false);
    expect(isRetryableFailure("provider_rejected")).toBe(false);
  });
});

describe("redactProviderDetail", () => {
  it("strips credentials of every provider shape", () => {
    const detail = redactProviderDetail(
      new Error(
        "call to https://aif-bauai-dev-gwc.openai.azure.com/openai/v1 failed; " +
          "key AIzaSyABCDEFGHIJKLMNOP, sk-abcdefghijklmnop, " +
          "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij",
      ),
    );
    expect(detail).not.toContain("openai.azure.com");
    expect(detail).not.toContain("AIzaSy");
    expect(detail).not.toContain("sk-abcdef");
    expect(detail).not.toContain("eyJhbGciOi");
    expect(detail).toContain("[provider-url]");
    expect(detail).toContain("[redacted-token]");
  });

  it("returns null for non-errors", () => {
    expect(redactProviderDetail("just a string")).toBeNull();
  });
});
