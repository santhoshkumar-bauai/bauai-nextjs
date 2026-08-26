import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aiEnv,
  resetAiEnvCache,
  roleMaxOutputTokens,
  roleReasoningEffort,
} from "./env.ts";

/**
 * Tier-routing resolution for the fill-agent roles. These are the dry-run
 * acceptance checks in test form: with no new env vars every tier resolves
 * exactly where `fill_agent` resolves today, shortcuts pin one role,
 * AI_MODEL_ROLES beats shortcuts, and the force-tier hammer beats everything.
 */

const KEYS = [
  "AI_MODEL_ROLES",
  "AI_ROLE_REASONING",
  "AI_ROLE_MAX_OUTPUT_TOKENS",
  "AZURE_OPENAI_MODEL",
  "AI_FILL_AGENT_MODEL",
  "AI_FILL_AGENT_PLAN_MODEL",
  "AI_FILL_AGENT_CRITIQUE_MODEL",
  "AI_FILL_AGENT_REPAIR_MODEL",
  "AI_FILL_AGENT_FORCE_TIER",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetAiEnvCache();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAiEnvCache();
});

describe("fill-agent tier resolution", () => {
  it("with no env vars, every tier falls back to the fill_agent resolution", () => {
    const roles = aiEnv().modelRoles;
    expect(roles.fill_agent).toBe("azure:gpt-5.6-luna");
    expect(roles.fill_agent_plan).toBe("azure:gpt-5.6-luna");
    expect(roles.fill_agent_critique).toBe("azure:gpt-5.6-luna");
    expect(roles.fill_agent_repair).toBe("azure:gpt-5.6-luna");
  });

  it("AI_FILL_AGENT_MODEL moves every tier together", () => {
    process.env.AI_FILL_AGENT_MODEL = "gemini:gemini-3.7-pro";
    const roles = aiEnv().modelRoles;
    expect(roles.fill_agent).toBe("gemini:gemini-3.7-pro");
    expect(roles.fill_agent_plan).toBe("gemini:gemini-3.7-pro");
    expect(roles.fill_agent_critique).toBe("gemini:gemini-3.7-pro");
    expect(roles.fill_agent_repair).toBe("gemini:gemini-3.7-pro");
  });

  it("a per-tier shortcut pins only its own role", () => {
    process.env.AI_FILL_AGENT_PLAN_MODEL = "azure:gpt-5.6-sol";
    const roles = aiEnv().modelRoles;
    expect(roles.fill_agent_plan).toBe("azure:gpt-5.6-sol");
    expect(roles.fill_agent_critique).toBe("azure:gpt-5.6-luna");
    expect(roles.fill_agent_repair).toBe("azure:gpt-5.6-luna");
    expect(roles.fill_agent).toBe("azure:gpt-5.6-luna");
  });

  it("AI_MODEL_ROLES beats the shortcuts", () => {
    process.env.AI_FILL_AGENT_PLAN_MODEL = "azure:gpt-5.6-sol";
    process.env.AI_MODEL_ROLES = JSON.stringify({
      fill_agent_plan: "azure:gpt-5.6-terra",
    });
    expect(aiEnv().modelRoles.fill_agent_plan).toBe("azure:gpt-5.6-terra");
  });

  it("force-tier pins ALL four fill roles (orchestrator included) to the anchor", () => {
    process.env.AI_FILL_AGENT_PLAN_MODEL = "azure:gpt-5.6-sol";
    process.env.AI_FILL_AGENT_FORCE_TIER = "sol";
    const roles = aiEnv().modelRoles;
    // the anchor is the MERGED plan value, so the pin composes with the chain
    expect(roles.fill_agent).toBe("azure:gpt-5.6-sol");
    expect(roles.fill_agent_plan).toBe("azure:gpt-5.6-sol");
    expect(roles.fill_agent_critique).toBe("azure:gpt-5.6-sol");
    expect(roles.fill_agent_repair).toBe("azure:gpt-5.6-sol");
    // non-fill roles are untouched
    expect(roles.agent).toBe("azure:gpt-5.6-luna");
  });

  it("force-tier wins over per-role AI_MODEL_ROLES entries (it is the big hammer)", () => {
    process.env.AI_MODEL_ROLES = JSON.stringify({
      fill_agent_critique: "azure:gpt-5.6-terra",
    });
    process.env.AI_FILL_AGENT_FORCE_TIER = "luna";
    expect(aiEnv().modelRoles.fill_agent_critique).toBe("azure:gpt-5.6-luna");
  });

  it("an invalid force-tier value fails loudly at first aiEnv()", () => {
    process.env.AI_FILL_AGENT_FORCE_TIER = "mercury";
    expect(() => aiEnv()).toThrow(/AI_FILL_AGENT_FORCE_TIER/);
  });

  it("per-tier effort and output budgets match the routing table", () => {
    expect(roleReasoningEffort("fill_agent_plan")).toBe("high");
    expect(roleReasoningEffort("fill_agent_critique")).toBe("medium");
    expect(roleReasoningEffort("fill_agent_repair")).toBe("low");
    expect(roleMaxOutputTokens("fill_agent_plan")).toBe(16_384);
    expect(roleMaxOutputTokens("fill_agent_critique")).toBe(8_192);
    expect(roleMaxOutputTokens("fill_agent_repair")).toBe(8_192);
  });
});
