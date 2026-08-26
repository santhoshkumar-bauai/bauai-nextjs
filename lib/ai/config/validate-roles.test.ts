import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAiEnvCache } from "./env.ts";
import {
  assertFillAgentRolesResolvable,
  resetFillAgentRoleValidationForTests,
} from "./validate-roles.ts";

const KEYS = [
  "AI_MODEL_ROLES",
  "AI_AZURE_DEPLOYMENTS",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_MODEL",
  "AI_FILL_AGENT_MODEL",
  "AI_FILL_AGENT_PLAN_MODEL",
  "AI_FILL_AGENT_CRITIQUE_MODEL",
  "AI_FILL_AGENT_REPAIR_MODEL",
  "AI_FILL_AGENT_FORCE_TIER",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetAiEnvCache();
  resetFillAgentRoleValidationForTests();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAiEnvCache();
  resetFillAgentRoleValidationForTests();
  vi.restoreAllMocks();
});

function azureBase() {
  process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com/";
  process.env.AZURE_OPENAI_DEPLOYMENT = "luna-dev";
  resetAiEnvCache();
}

describe("assertFillAgentRolesResolvable", () => {
  it("warns and returns when no AI provider is configured at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertFillAgentRolesResolvable()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no AI provider configured"));
  });

  it("passes on the single-deployment default setup", () => {
    azureBase();
    expect(() => assertFillAgentRolesResolvable()).not.toThrow();
  });

  it("rejects a non-default azure model with no explicit deployment mapping", () => {
    azureBase();
    process.env.AI_FILL_AGENT_PLAN_MODEL = "azure:gpt-5.6-sol";
    resetAiEnvCache();
    // Without this check the AZURE_OPENAI_DEPLOYMENT fallback would silently
    // route sol-labelled traffic to the luna deployment.
    expect(() => assertFillAgentRolesResolvable()).toThrow(
      /fill_agent_plan[\s\S]*AI_AZURE_DEPLOYMENTS/,
    );
  });

  it("accepts a non-default azure model once its deployment is mapped", () => {
    azureBase();
    process.env.AI_FILL_AGENT_PLAN_MODEL = "azure:gpt-5.6-sol";
    process.env.AI_AZURE_DEPLOYMENTS = JSON.stringify({ "gpt-5.6-sol": "sol-dev" });
    resetAiEnvCache();
    expect(() => assertFillAgentRolesResolvable()).not.toThrow();
  });

  it("aggregates every broken role into one error", () => {
    azureBase();
    process.env.AI_FILL_AGENT_PLAN_MODEL = "azure:gpt-5.6-sol";
    process.env.AI_FILL_AGENT_CRITIQUE_MODEL = "azure:gpt-5.6-terra";
    resetAiEnvCache();
    expect(() => assertFillAgentRolesResolvable()).toThrow(
      /fill_agent_plan[\s\S]*fill_agent_critique/,
    );
  });

  it("rejects a non-azure role whose provider key is missing", () => {
    azureBase();
    process.env.AI_FILL_AGENT_REPAIR_MODEL = "gemini:gemini-3.7-pro";
    resetAiEnvCache();
    expect(() => assertFillAgentRolesResolvable()).toThrow(/fill_agent_repair[\s\S]*gemini/);
  });

  it("caches a successful verdict", () => {
    azureBase();
    assertFillAgentRolesResolvable();
    // Break the env afterwards — the cached verdict stands (per-boot check).
    process.env.AI_FILL_AGENT_PLAN_MODEL = "azure:gpt-5.6-sol";
    resetAiEnvCache();
    expect(() => assertFillAgentRolesResolvable()).not.toThrow();
  });
});
