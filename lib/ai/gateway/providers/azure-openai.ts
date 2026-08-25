import type { OpenAI as OpenAIClient } from "openai";

import { azureClientOptions } from "../../config/azure.ts";
import { roleMaxOutputTokens, roleReasoningEffort } from "../../config/env.ts";
import { resolveAzureDeployment } from "../config.ts";
import { adaptJsonSchema } from "../json-schema.ts";
import {
  ContentFilterError,
  RateLimitError,
  StructuredOutputError,
  type EmbedResult,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
} from "../types.ts";

/**
 * Azure OpenAI adapter for the deterministic lane.
 *
 * Unlike the Gemini adapter this uses the `openai` SDK rather than raw fetch.
 * That REST surface is trivial and stateless; Azure's is not — Entra tokens
 * expire and must be refreshed, and error payloads nest their real cause. Hand
 * rolling token refresh is the part not worth owning.
 *
 * The retry ladder stays ours, mirroring `gemini.ts`: `maxRetries: 0` on the
 * client, backoff here, so both lanes fail and retry the same way and
 * `RateLimitError` still carries `retryAfterMs` to the BullMQ workers.
 */

const MAX_ATTEMPTS = 3;

/** Only the surface we use, so tests can inject a plain object. */
export interface AzureChatClient {
  chat: {
    completions: {
      create: OpenAIClient["chat"]["completions"]["create"];
    };
  };
}

export interface AzureOpenAIProviderOptions {
  /** Test seam; defaults to a real client built from the Azure env. */
  client?: AzureChatClient;
}

interface ApiError {
  status?: number;
  code?: string;
  message?: string;
  headers?: Headers | Record<string, string>;
  error?: { code?: string; message?: string; innererror?: { code?: string } };
}

function headerValue(headers: ApiError["headers"], name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  return (headers as Record<string, string>)[name] ?? null;
}

/**
 * Azure sends `retry-after` in SECONDS, and `retry-after-ms` on some SKUs.
 * Exported so the unit conversion can be tested without sleeping through a
 * real backoff ladder.
 */
export function retryAfterMs(headers: ApiError["headers"]): number | null {
  const ms = headerValue(headers, "retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const seconds = headerValue(headers, "retry-after");
  if (seconds && Number.isFinite(Number(seconds))) return Number(seconds) * 1_000;
  return null;
}

function backoff(attempt: number, retryAfter: number | null = null): Promise<void> {
  const base = retryAfter ?? 1_000 * 2 ** (attempt - 1);
  const jittered = base + Math.random() * 500;
  return new Promise((resolve) => setTimeout(resolve, jittered));
}

function errorCode(error: ApiError): string {
  return error.code ?? error.error?.code ?? error.error?.innererror?.code ?? "";
}

/**
 * A JSON-schema name Azure accepts: `^[a-zA-Z0-9_-]+$`. Derived from the role,
 * never from user data.
 */
function schemaName(role: string): string {
  return `bauai_${role}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export class AzureOpenAIProvider {
  readonly name = "azure";
  private readonly injected: AzureChatClient | null;
  private client: AzureChatClient | null = null;

  constructor(options: AzureOpenAIProviderOptions = {}) {
    this.injected = options.client ?? null;
  }

  private async getClient(deployment: string): Promise<AzureChatClient> {
    if (this.injected) return this.injected;
    if (this.client) return this.client;
    const { OpenAI } = await import("openai");
    const configuration = await azureClientOptions(deployment, "extraction");
    // Retries live in this class, not in the SDK, so the two ladders cannot
    // compound into a 9-attempt storm against a rate-limited deployment.
    this.client = new OpenAI({ ...configuration, maxRetries: 0 }) as AzureChatClient;
    return this.client;
  }

  async embed(): Promise<EmbedResult> {
    throw new Error(
      'The "azure" provider has no embed(): luna-dev is a chat deployment. Keep ' +
        "AI_MODEL_ROLES.embedding on gemini:gemini-embedding-001 — changing the embedding " +
        "model requires re-embedding every stored vector and rebuilding the Atlas vector " +
        "indexes (vx_tender_search_documents, vx_chunks), then re-running npm run ai:eval " +
        "against the committed retrieval baseline.",
    );
  }

  async generateStructured<T>(
    model: string,
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    const deployment = resolveAzureDeployment(model);
    const client = await this.getClient(deployment);
    const effort = roleReasoningEffort(request.role);

    const body = {
      // The transport swaps this for the deployment name on the way out; see
      // config/azure.ts. Sending the model id keeps the identity honest here
      // and in the result below.
      model,
      messages: [{ role: "user" as const, content: request.prompt }],
      // `max_completion_tokens`, never `max_tokens`: the latter is a hard 400
      // on a reasoning model. Shared with the thinking, hence the role budget.
      max_completion_tokens: roleMaxOutputTokens(request.role),
      ...(effort ? { reasoning_effort: effort } : {}),
      response_format: {
        type: "json_schema" as const,
        json_schema: {
          name: schemaName(request.role),
          strict: true,
          schema: adaptJsonSchema(request.schema, "openai-strict"),
        },
      },
      // `request.temperature` is accepted by the interface and deliberately
      // IGNORED: gpt-5.x rejects any value but its default. Callers pass 0 to
      // mean "be deterministic", which a reasoning model already is.
    };

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const completion = await client.chat.completions.create(body as never);
        return this.parse(completion as never, model, request);
      } catch (error) {
        const api = error as ApiError;

        if (error instanceof ContentFilterError || error instanceof StructuredOutputError) {
          throw error;
        }

        if (api.status === 429) {
          const retryAfter = retryAfterMs(api.headers);
          if (attempt === MAX_ATTEMPTS) {
            throw new RateLimitError(api.message ?? "Azure OpenAI rate limited", retryAfter);
          }
          await backoff(attempt, retryAfter);
          continue;
        }

        if (api.status === 400 && /content_filter|responsible_?ai/i.test(errorCode(api))) {
          throw new ContentFilterError(
            api.message ?? "Azure content filter blocked the prompt",
            "prompt",
          );
        }

        if (api.status === 401 || api.status === 403) {
          throw new Error(
            `Azure OpenAI rejected the credential (${api.status}). The service principal ` +
              `needs the "Cognitive Services OpenAI User" role on the resource.`,
          );
        }

        if ((api.status === undefined || api.status >= 500) && attempt < MAX_ATTEMPTS) {
          lastError = error instanceof Error ? error : new Error(String(error));
          await backoff(attempt);
          continue;
        }

        throw error;
      }
    }
    throw lastError ?? new Error("Azure OpenAI request failed");
  }

  private parse<T>(
    completion: {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string | null };
      }>;
    },
    model: string,
    request: GenerateStructuredRequest<T>,
  ): GenerateStructuredResult<T> {
    const choice = completion.choices?.[0];
    const finish = choice?.finish_reason;

    // Both of these arrive as HTTP 200 with empty content, so they are
    // invisible to any status check and would otherwise surface as "returned
    // non-JSON output" — which sends the reader to the schema instead of to
    // the filter or the token budget.
    if (finish === "content_filter") {
      throw new ContentFilterError(
        `Azure content filter blocked the completion for role "${request.role}"`,
        "completion",
      );
    }
    if (finish === "length") {
      throw new StructuredOutputError(
        `Azure returned a truncated response for role "${request.role}" — the model spent its ` +
          `budget before finishing. Raise AI_ROLE_MAX_OUTPUT_TOKENS for that role.`,
      );
    }

    const text = choice?.message?.content ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StructuredOutputError(
        `Azure returned non-JSON output for model ${model} (finish_reason=${finish ?? "none"})`,
      );
    }

    const result = request.zod.safeParse(parsed);
    if (!result.success) {
      throw new StructuredOutputError(
        `Azure output failed schema validation: ${result.error.message}`,
      );
    }
    return { value: result.data, provider: this.name, model };
  }
}
