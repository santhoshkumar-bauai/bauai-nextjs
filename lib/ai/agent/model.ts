import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ReasoningEffort as OpenAIReasoningEffort } from "openai/resources/shared";

import {
  aiEnv,
  requireGeminiApiKey,
  roleMaxOutputTokens,
  roleReasoningEffort,
  type ReasoningEffort,
} from "../config/env.ts";
import { azureClientOptions } from "../config/azure.ts";
import { resolveAzureDeployment, resolveRole } from "../gateway/config.ts";
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

export type { ReasoningEffort };

function geminiUsesFixedSampling(model: string): boolean {
  const match = model.replace(/^models\//, "").match(/^gemini-3\.(\d+)(?:-|$)/);
  return match !== null && Number(match[1]) >= 6;
}

/**
 * The product effort ladder has six rungs; no provider accepts all six. Each
 * mapper below clamps into its own vocabulary, so raising a role to `xhigh`
 * can never 400 a deployment that has never heard of it.
 */

/** Gemini's thinkingLevel stops at HIGH — the two top rungs fold into it. */
function geminiThinkingLevel(effort: Exclude<ReasoningEffort, "none">): "LOW" | "MEDIUM" | "HIGH" {
  if (effort === "low") return "LOW";
  if (effort === "medium") return "MEDIUM";
  return "HIGH";
}

/**
 * OpenAI-family effort, per model generation.
 *
 * Only gpt-5.0 spells "no thinking" as `minimal`; gpt-5.1 and later spell it
 * `none` and reject `minimal` outright:
 *
 *   "Unsupported value: 'minimal' is not supported with the
 *    'gpt-5.6-luna-2026-07-09' model. Supported values are: 'none', 'low',
 *    'medium', 'high', 'xhigh', and 'max'."
 *
 * Note the separator class excludes `.` deliberately — `[-._]` would make
 * "gpt-5.6-luna" match the gpt-5.0 branch and send `minimal`, which is exactly
 * the 400 above.
 *
 * `max` is passed through: the Responses API accepts it (see the message
 * above) and that is the surface we run on. The chat/completions escape hatch
 * has a shorter ladder, but it cannot combine tools with any effort at all, so
 * it is already a degraded mode.
 */
function openAiEffort(model: string, effort: ReasoningEffort): OpenAIReasoningEffort {
  const isGpt5Zero = /^gpt-5(\.0)?([-_]|$)/.test(model);
  if (effort === "none") return isGpt5Zero ? "minimal" : "none";
  if (effort === "max" && isGpt5Zero) return "high";
  return effort;
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
const ANTHROPIC_THINKING_BUDGET: Record<Exclude<ReasoningEffort, "none">, number> = {
  low: 2_048,
  medium: 6_144,
  high: 12_288,
  xhigh: 24_576,
  max: 32_768,
};

/** The chat model for one role — "agent" unless told otherwise. */
export async function getChatModel(
  options: ChatModelOptions = {},
): Promise<BaseChatModel> {
  if (testOverride) return testOverride;

  const env = aiEnv();
  const role = options.role ?? "agent";
  const ref = resolveRole(role);
  // Per-role budget and effort, overridable at the call site. On a reasoning
  // model this budget is SHARED with the thinking, so the role table sizes it
  // for both — see defaultRoleMaxOutputTokens().
  const maxOutputTokens = options.maxOutputTokens ?? roleMaxOutputTokens(role);
  const temperature = options.temperature ?? 0.2;
  // Thinking-model support: reasoning content parts are already handled on
  // the way out (textFromContent); this maps the requested effort onto each
  // provider's own knob. Unset = provider default (dynamic thinking).
  const effort: ReasoningEffort | undefined =
    options.reasoningEffort ?? roleReasoningEffort(role);

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
            ? { thinkingConfig: { thinkingLevel: geminiThinkingLevel(effort) } }
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
        // `reasoning: { effort }`, NOT `reasoningEffort`. The latter is a CALL
        // option only (`chat_models/base.d.ts:118`); the constructor stores
        // just `this.reasoning` (`base.js:249`), so the old spelling here was
        // silently dropped and this branch never sent reasoning_effort at all.
        // Never set `reasoning.summary` unintentionally — it is treated as a
        // Responses-only kwarg and would force that API (`index.js:573`).
        ...(effort ? { reasoning: { effort: openAiEffort(ref.model, effort) } } : {}),
      });
    }
    case "azure": {
      const { ChatOpenAI } = await import("@langchain/openai");
      const deployment = resolveAzureDeployment(ref.model);
      const configuration = await azureClientOptions(deployment, role);

      // Plain ChatOpenAI, not AzureChatOpenAI: this resource serves only the
      // OpenAI-compatible /openai/v1 surface, and AzureChatOpenAI hard-codes a
      // /openai/deployments/... base URL that 404s here. See config/azure.ts.
      return new ChatOpenAI({
        // The real model id, never the deployment — it drives isReasoningModel
        // (hence max_completion_tokens, which is mandatory here) and is what
        // gets stamped on cached artifacts. azureClientOptions swaps in the
        // deployment name on the way out.
        model: ref.model,
        apiKey: "entra",
        configuration,
        // gpt-5.x accepts only its default temperature of 1 and 400s on
        // anything else, so we never send one. Same shape as the Gemini 3.6+
        // fixed-sampling quirk above: leaving it undefined keeps it off the
        // wire entirely.
        maxTokens: maxOutputTokens,
        ...(effort ? { reasoning: { effort: openAiEffort(ref.model, effort) } } : {}),
        // Not a preference: /v1/chat/completions rejects function tools
        // combined with any reasoning_effort above "none", and every agent
        // here is a tool loop. Responses is the only surface that gives us
        // both. AI_AZURE_RESPONSES=false is an escape hatch that costs
        // reasoning on every tool-calling role.
        useResponsesApi: env.azureUseResponsesApi,
        // Long stable system prompts with short varying tails is exactly the
        // caching shape; probe P11 measured 8526 of 8529 tokens served warm.
        promptCacheKey: `bauai:${role}`,
      });
    }
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      const budget =
        effort && effort !== "none" ? ANTHROPIC_THINKING_BUDGET[effort] : null;
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
        `Unknown ${role} provider "${ref.provider}". Known: gemini, openai, anthropic, azure.`,
      );
  }
}

/** The chat agent's model. Thin alias kept for the many existing call sites. */
export async function getAgentChatModel(
  options: AgentModelOptions = {},
): Promise<BaseChatModel> {
  return getChatModel({ ...options, role: "agent" });
}
