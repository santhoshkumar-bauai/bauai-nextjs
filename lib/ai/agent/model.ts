import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { aiEnv, requireGeminiApiKey } from "../config/env.ts";
import { resolveRole } from "../gateway/config.ts";

/**
 * Chat-model factory for the agent role. Unlike the deterministic pipelines
 * (which stay on the raw-fetch gateway), the agent uses LangChain's native
 * model classes — tool calling, token streaming and LangGraph integration
 * come from the library. All three provider bindings are installed; which
 * one runs is purely `AI_MODEL_ROLES.agent` ("provider:model").
 */

let testOverride: BaseChatModel | null = null;

/** Test hook: inject a fake model; pass null to restore the real factory. */
export function setAgentModelForTests(model: BaseChatModel | null): void {
  testOverride = model;
}

function requireKey(name: string, provider: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not configured, but the "agent" role resolves to provider "${provider}". ` +
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

/** Anthropic extended-thinking budgets; must stay below maxTokens. */
const ANTHROPIC_THINKING_BUDGET: Record<"low" | "medium" | "high", number> = {
  low: 2_048,
  medium: 6_144,
  high: 12_288,
};

export async function getAgentChatModel(
  options: AgentModelOptions = {},
): Promise<BaseChatModel> {
  if (testOverride) return testOverride;

  const env = aiEnv();
  const ref = resolveRole("agent");
  const maxOutputTokens = options.maxOutputTokens ?? env.agentMaxOutputTokens;
  const temperature = options.temperature ?? 0.2;
  // Thinking-model support: reasoning content parts are already handled on
  // the way out (textFromContent); this maps the requested effort onto each
  // provider's own knob. Unset = provider default (dynamic thinking).
  const effort: ReasoningEffort | undefined = env.agentReasoningEffort;

  switch (ref.provider) {
    case "gemini": {
      const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
      return new ChatGoogleGenerativeAI({
        model: ref.model,
        apiKey: requireGeminiApiKey(),
        temperature,
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
        apiKey: requireKey("OPENAI_API_KEY", "openai"),
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
        apiKey: requireKey("ANTHROPIC_API_KEY", "anthropic"),
        // Extended thinking rejects custom temperatures — only set one when
        // thinking is off. max_tokens must exceed the thinking budget.
        ...(budget ? {} : { temperature }),
        maxTokens: budget ? budget + maxOutputTokens : maxOutputTokens,
        ...(budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
      });
    }
    default:
      throw new Error(
        `Unknown agent provider "${ref.provider}". Known: gemini, openai, anthropic.`,
      );
  }
}
