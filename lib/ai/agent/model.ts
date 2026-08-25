import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { aiEnv, requireGeminiApiKey } from "../config/env.ts";
import { resolveRole } from "../gateway/config.ts";
import type { ModelRole } from "../gateway/types.ts";

/**
 * Chat-model factory for the conversational roles. Unlike the deterministic
 * pipelines (which stay on the raw-fetch gateway), these use LangChain's
 * native model classes — tool calling, token streaming and LangGraph
 * integration come from the library. All three provider bindings are
 * installed; which one runs is purely `AI_MODEL_ROLES.<role>`
 * ("provider:model"), so the report can sit on a stronger model than the chat
 * agent without a code change.
 */

let testOverride: BaseChatModel | null = null;

/** Test hook: inject a fake model; pass null to restore the real factory. */
export function setAgentModelForTests(model: BaseChatModel | null): void {
  testOverride = model;
}

function requireKey(name: string, provider: string, role: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not configured, but the "${role}" role resolves to provider "${provider}". ` +
        `Set the key or change AI_MODEL_ROLES.`,
    );
  }
  return value;
}

export interface AgentModelOptions {
  maxOutputTokens?: number;
  temperature?: number;
}

type ReasoningEffort = "none" | "low" | "medium" | "high";

function geminiUsesFixedSampling(model: string): boolean {
  const match = model.replace(/^models\//, "").match(/^gemini-3\.(\d+)(?:-|$)/);
  return match !== null && Number(match[1]) >= 6;
}

export interface ChatModelOptions extends AgentModelOptions {
  /** Defaults to "agent". */
  role?: Extract<
    ModelRole,
    | "agent"
    | "report"
    | "dora"
    | "dora_fast"
    | "dora_fill"
    | "dora_pdf_fill"
    | "dora_gaeb_fill"
    | "dora_gaeb_web"
    | "otto"
    | "fill_agent"
  >;
  /** Overrides the env-configured effort for this role. */
  reasoningEffort?: ReasoningEffort;
}

/** Anthropic extended-thinking budgets; must stay below maxTokens. */
const ANTHROPIC_THINKING_BUDGET: Record<"low" | "medium" | "high", number> = {
  low: 2_048,
  medium: 6_144,
  high: 12_288,
};

/** The chat model for one role — "agent" unless told otherwise. */
export async function getChatModel(
  options: ChatModelOptions = {},
): Promise<BaseChatModel> {
  if (testOverride) return testOverride;

  const env = aiEnv();
  const role = options.role ?? "agent";
  const ref = resolveRole(role);
  const maxOutputTokens =
    options.maxOutputTokens ??
    (role === "report" ? env.reportMaxOutputTokens : env.agentMaxOutputTokens);
  const temperature = options.temperature ?? 0.2;
  // Thinking-model support: reasoning content parts are already handled on
  // the way out (textFromContent); this maps the requested effort onto each
  // provider's own knob. Unset = provider default (dynamic thinking).
  const effort: ReasoningEffort | undefined =
    options.reasoningEffort ??
    (role === "report" ? env.reportReasoningEffort : env.agentReasoningEffort);

  switch (ref.provider) {
    case "gemini": {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
      return new ChatGoogleGenerativeAI({
        model: ref.model,
        apiKey: requireGeminiApiKey(),
        // Gemini 3.6+ rejects the legacy temperature/top-p/top-k knobs with
        // INVALID_ARGUMENT. Leaving the value undefined keeps it out of the
        // serialized generationConfig and uses the model's fixed sampling.
        ...(geminiUsesFixedSampling(ref.model) ? {} : { temperature }),
        maxOutputTokens,
        ...(effort === "none"
          ? { thinkingConfig: { thinkingBudget: 0 } }
          : effort
            ? {
                thinkingConfig: {
                  thinkingLevel: effort.toUpperCase() as "LOW" | "MEDIUM" | "HIGH",
                },
              }
            : {}),
      });
    }
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai");
      return new ChatOpenAI({
        model: ref.model,
        apiKey: requireKey("OPENAI_API_KEY", "openai", role),
        temperature,
        maxTokens: maxOutputTokens,
        ...(effort ? { reasoningEffort: effort === "none" ? "minimal" : effort } : {}),
      });
    }
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      const budget = effort && effort !== "none" ? ANTHROPIC_THINKING_BUDGET[effort] : null;
      return new ChatAnthropic({
        model: ref.model,
        apiKey: requireKey("ANTHROPIC_API_KEY", "anthropic", role),
        // Extended thinking rejects custom temperatures — only set one when
        // thinking is off. max_tokens must exceed the thinking budget.
        ...(budget ? {} : { temperature }),
        maxTokens: budget ? budget + maxOutputTokens : maxOutputTokens,
        ...(budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
      });
    }
    default:
      throw new Error(
        `Unknown ${role} provider "${ref.provider}". Known: gemini, openai, anthropic.`,
      );
  }
}

/** The chat agent's model. Thin alias kept for the many existing call sites. */
export async function getAgentChatModel(
  options: AgentModelOptions = {},
): Promise<BaseChatModel> {
  return getChatModel({ ...options, role: "agent" });
}
