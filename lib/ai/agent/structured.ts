import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Runnable } from "@langchain/core/runnables";

import { resolveRole } from "../gateway/config.ts";
import { adaptJsonSchema, dialectForProvider } from "../gateway/json-schema.ts";
import type { ModelRole } from "../gateway/types.ts";

/**
 * `withStructuredOutput`, with the schema translated for whichever provider
 * the role actually resolves to.
 *
 * Call sites keep writing one honest schema; this is the single boundary where
 * it becomes a provider's dialect. See `gateway/json-schema.ts` for what each
 * dialect needs and why.
 */

export interface ProviderStructuredOptions {
  /** Tool/schema name sent to the provider. */
  name: string;
  /** Decides the dialect — the same role the model was built from. */
  role: ModelRole;
  /**
   * Force the function-calling path on Gemini.
   *
   * Two planners rely on this and it is deliberately Gemini-only. On OpenAI
   * and Azure, `jsonSchema` is the guaranteed-conformance path and already the
   * library default, and a forced function `tool_choice` cannot coexist with a
   * server-side tool such as web search — which is a capability we are
   * migrating toward, not away from.
   */
  forceFunctionCalling?: boolean;
}

export function withProviderStructuredOutput<T extends Record<string, unknown>>(
  model: BaseChatModel,
  schema: Record<string, unknown>,
  options: ProviderStructuredOptions,
): Runnable<Parameters<BaseChatModel["invoke"]>[0], T> {
  const { provider } = resolveRole(options.role);
  const dialect = dialectForProvider(provider);
  const adapted = adaptJsonSchema(schema, dialect);

  return model.withStructuredOutput<T>(adapted as never, {
    name: options.name,
    ...(provider === "gemini" && options.forceFunctionCalling
      ? { method: "functionCalling" as const }
      : {}),
  }) as Runnable<Parameters<BaseChatModel["invoke"]>[0], T>;
}
