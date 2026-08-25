import { aiEnv } from "../config/env.ts";
import type { ModelRole } from "./types.ts";

export interface ModelRef {
  provider: string;
  model: string;
}

/** "gemini:gemini-embedding-001" → { provider, model }. Validated by env. */
export function resolveRole(role: ModelRole): ModelRef {
  const raw = aiEnv().modelRoles[role];
  if (!raw) {
    throw new Error(
      `No model configured for role "${role}". Set AI_MODEL_ROLES.`,
    );
  }
  const separator = raw.indexOf(":");
  return {
    provider: raw.slice(0, separator),
    model: raw.slice(separator + 1),
  };
}

/**
 * Azure model id → deployment name.
 *
 * Roles name the MODEL (`azure:gpt-5.6-luna`), never the deployment. Two
 * reasons: the model id is what LangChain's capability detection keys off
 * (`isReasoningModel`), and it is the identity stamped on every cached
 * extraction and report — renaming a deployment must not invalidate stored
 * artifacts.
 *
 * With a single deployment, `AZURE_OPENAI_DEPLOYMENT` covers everything and
 * `AI_AZURE_DEPLOYMENTS` can stay unset.
 */
export function resolveAzureDeployment(model: string): string {
  const mapped = aiEnv().azureDeployments[model] ?? process.env.AZURE_OPENAI_DEPLOYMENT;
  if (!mapped) {
    throw new Error(
      `No Azure deployment for model "${model}". Set AZURE_OPENAI_DEPLOYMENT, or map it ` +
        `in AI_AZURE_DEPLOYMENTS, e.g. {"${model}":"luna-dev"}.`,
    );
  }
  return mapped;
}

/** Whether the credentials for one provider are present. */
function providerConfigured(provider: string): boolean {
  switch (provider) {
    case "gemini":
      return Boolean(process.env.GEMINI_API_KEY);
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
    case "anthropic":
      return Boolean(process.env.ANTHROPIC_API_KEY);
    case "azure":
      // Entra, not a key: DefaultAzureCredential resolves the service principal
      // locally and managed identity when deployed, so the endpoint is the only
      // thing we can usefully check up front.
      return Boolean(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_DEPLOYMENT);
    default:
      return false;
  }
}

const GENERATION_PROVIDERS = ["gemini", "openai", "anthropic", "azure"];

/**
 * Is ANY generation provider configured?
 *
 * The cheap guard for surfaces that route through several roles at once and
 * would otherwise 500 on a missing credential. Prefer `aiRoleConfigured` where
 * the route calls one known role — "some provider exists" is not "the provider
 * you are about to call exists".
 */
export function aiProviderConfigured(): boolean {
  return GENERATION_PROVIDERS.some(providerConfigured);
}

/** Is the credential for the provider THIS role resolves to present? */
export function aiRoleConfigured(role: ModelRole): boolean {
  try {
    return providerConfigured(resolveRole(role).provider);
  } catch {
    // An unconfigured or malformed role is "not available", not a crash: these
    // helpers exist to produce a clean 503, never to become the failure.
    return false;
  }
}
