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
