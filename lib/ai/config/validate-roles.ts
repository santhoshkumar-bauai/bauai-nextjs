import { FILL_AGENT_ROLES, aiEnv } from "./env.ts";
import {
  aiProviderConfigured,
  aiRoleConfigured,
  resolveAzureDeployment,
  resolveRole,
} from "../gateway/config.ts";
import type { ModelRole } from "../gateway/types.ts";

/**
 * Fail-loudly startup validation for the fill-agent's tiered roles.
 *
 * Runs from `instrumentation.ts` at server start, with a safety-net call in
 * `buildFillAgentGraph` for workers and scripts that never ran instrumentation.
 * The point is to fail at boot with a message naming the broken role and the
 * fix — not on the first request, hours later, inside a user's fill session.
 *
 * The one trap this exists to reject: `resolveAzureDeployment` falls back to
 * `AZURE_OPENAI_DEPLOYMENT` for ANY unmapped model, so a sol/terra model id
 * without an `AI_AZURE_DEPLOYMENTS` entry would silently run on the luna
 * deployment while stamping artifacts with the sol/terra model identity. A
 * non-default azure model therefore REQUIRES an explicit deployment mapping.
 */

let validated = false;

/** Test hook: forget the cached verdict. */
export function resetFillAgentRoleValidationForTests(): void {
  validated = false;
}

function azureIssue(role: ModelRole, model: string): string | null {
  if (!process.env.AZURE_OPENAI_ENDPOINT) {
    return `role "${role}" resolves to azure:${model} but AZURE_OPENAI_ENDPOINT is not set`;
  }
  const defaultModel = process.env.AZURE_OPENAI_MODEL || "gpt-5.6-luna";
  const explicit = aiEnv().azureDeployments[model];
  if (model !== defaultModel && !explicit) {
    return (
      `role "${role}" resolves to azure:${model}, which has no entry in AI_AZURE_DEPLOYMENTS — ` +
      `the AZURE_OPENAI_DEPLOYMENT fallback would silently route it to the default deployment ` +
      `under the wrong model identity. Map it explicitly, e.g. AI_AZURE_DEPLOYMENTS={"${model}":"<deployment>"}.`
    );
  }
  try {
    resolveAzureDeployment(model);
  } catch (error) {
    return `role "${role}" (azure:${model}): ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/**
 * Assert every fill-agent role resolves to a servable provider+model.
 * Aggregates ALL failures into one error. When no AI provider is configured
 * at all, warns and returns — the AI env is deliberately lazy so AI-less
 * builds and deployments keep booting (see lib/ai/config/env.ts header).
 */
export function assertFillAgentRolesResolvable(): void {
  if (validated) return;

  if (!aiProviderConfigured()) {
    console.warn(
      "[ai.fillagent] no AI provider configured — skipping fill-agent role validation " +
        "(the fill agent will be unavailable until one is).",
    );
    return;
  }

  const problems: string[] = [];
  for (const role of FILL_AGENT_ROLES) {
    try {
      const ref = resolveRole(role);
      if (ref.provider === "azure") {
        const issue = azureIssue(role, ref.model);
        if (issue) problems.push(issue);
      } else if (!aiRoleConfigured(role)) {
        problems.push(
          `role "${role}" resolves to provider "${ref.provider}" but its API key is not configured`,
        );
      }
    } catch (error) {
      problems.push(
        `role "${role}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Fill-agent model routing is misconfigured:\n- ${problems.join("\n- ")}`,
    );
  }
  validated = true;
}
