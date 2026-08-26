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
  "AI_AZURE_DEPLOYMENTS",
  "AZURE_OPENAI_MODEL",
  "AZURE_OPENAI_MODEL_SOL",
  "AZURE_OPENAI_MODEL_TERRA",
  "AZURE_OPENAI_MODEL_LUNA",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_DEPLOYMENT_LUNA",
  "AZURE_OPENAI_DEPLOYMENT_SOL",
  "AZURE_OPENAI_DEPLOYMENT_TERRA",
  "AI_FILL_AGENT_MODEL",
  "AI_FILL_AGENT_ADAPTIVE_MODEL",
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

  it("AZURE_OPENAI_DEPLOYMENT_<TIER> vars both map deployments and activate tiers", () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_LUNA = "luna-dev";
    process.env.AZURE_OPENAI_DEPLOYMENT_SOL = "sol-dev";
    process.env.AZURE_OPENAI_DEPLOYMENT_TERRA = "terra-dev";
    const env = aiEnv();
    // The adaptive PDF workflow uses Sol/high for every reasoning role.
    // Terra remains mapped for non-fill consumers and explicit overrides.
    expect(env.modelRoles.fill_agent_plan).toBe("azure:gpt-5.6-sol");
    expect(env.modelRoles.fill_agent_critique).toBe("azure:gpt-5.6-sol");
    expect(env.modelRoles.fill_agent_repair).toBe("azure:gpt-5.6-sol");
    expect(env.modelRoles.fill_agent).toBe("azure:gpt-5.6-sol");
    expect(env.azureDeployments).toMatchObject({
      "gpt-5.6-luna": "luna-dev",
      "gpt-5.6-sol": "sol-dev",
      "gpt-5.6-terra": "terra-dev",
    });
  });

  it("AZURE_OPENAI_MODEL_<TIER> overrides a tier's model id", () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_SOL = "sol-dev";
    process.env.AZURE_OPENAI_MODEL_SOL = "gpt-6.0-sol";
    const env = aiEnv();
    expect(env.modelRoles.fill_agent_plan).toBe("azure:gpt-6.0-sol");
    expect(env.azureDeployments["gpt-6.0-sol"]).toBe("sol-dev");
  });

  it("explicit AI_AZURE_DEPLOYMENTS entries win over the tier shorthand", () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_SOL = "sol-dev";
    process.env.AI_AZURE_DEPLOYMENTS = JSON.stringify({ "gpt-5.6-sol": "sol-canary" });
    expect(aiEnv().azureDeployments["gpt-5.6-sol"]).toBe("sol-canary");
  });

  it("per-tier effort and output budgets match the routing table", () => {
    expect(roleReasoningEffort("fill_agent_plan")).toBe("high");
    expect(roleReasoningEffort("fill_agent_critique")).toBe("high");
    expect(roleReasoningEffort("fill_agent_repair")).toBe("high");
    expect(roleMaxOutputTokens("fill_agent_plan")).toBe(32_768);
    expect(roleMaxOutputTokens("fill_agent_critique")).toBe(8_192);
    expect(roleMaxOutputTokens("fill_agent_repair")).toBe(8_192);
  });
});
