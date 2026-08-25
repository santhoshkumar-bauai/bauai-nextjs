import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAiEnvCache } from "../config/env.ts";
import { resetAzureTokenProviderForTests } from "../config/azure.ts";
import { getAgentChatModel, getChatModel, setAgentModelForTests } from "./model.ts";

/**
 * `vitest.setup.mts` loads `.env.local`, so a developer's real credentials are
 * in `process.env` during unit tests. Every key the factory reads has to be
 * cleared here, or these tests pass locally off a dotfile and fail in CI.
 */
const KEYS = [
  "AI_MODEL_ROLES",
  "AI_DORA_FILL_MODEL",
  "AI_ROLE_REASONING",
  "AI_ROLE_MAX_OUTPUT_TOKENS",
  "AI_AGENT_REASONING",
  "AI_AGENT_MAX_OUTPUT_TOKENS",
  "AI_REPORT_REASONING",
  "AI_REPORT_MAX_OUTPUT_TOKENS",
  "AI_AZURE_DEPLOYMENTS",
  "AI_AZURE_RESPONSES",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT",
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
  setAgentModelForTests(null);
  // A stub provider keeps the factory off the network; @azure/identity is
  // never constructed, so these stay pure unit tests.
  resetAzureTokenProviderForTests(async () => "stub-token");
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAiEnvCache();
  setAgentModelForTests(null);
  resetAzureTokenProviderForTests(null);
});

/** The fields the factory sets that we care about asserting on. */
function fieldsOf(model: unknown) {
  return model as {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    reasoning?: { effort?: string };
    useResponsesApi?: boolean;
    promptCacheKey?: string;
    thinkingConfig?: { thinkingLevel?: string; thinkingBudget?: number };
  };
}

function azureEnv(roles: Record<string, string>, extra: Record<string, string> = {}) {
  process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com/";
  process.env.AZURE_OPENAI_DEPLOYMENT = "luna-dev";
  process.env.AI_MODEL_ROLES = JSON.stringify(roles);
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
  resetAiEnvCache();
}

describe("getAgentChatModel", () => {
  it("defaults every generation role to azure luna", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com/";
    process.env.AZURE_OPENAI_DEPLOYMENT = "luna-dev";
    resetAiEnvCache();
    const model = await getAgentChatModel();
    expect(model.constructor.name).toBe("ChatOpenAI");
    expect(fieldsOf(model).model).toBe("gpt-5.6-luna");
  });

  it("keeps embeddings on gemini after the cutover", async () => {
    // luna-dev is a chat deployment, and moving this role means re-embedding
    // the whole corpus and rebuilding both Atlas vector indexes.
    const { resolveRole } = await import("../gateway/config.ts");
    expect(resolveRole("embedding")).toEqual({
      provider: "gemini",
      model: "gemini-embedding-001",
    });
  });

  it("moves a single role back to gemini via its shortcut", async () => {
    // The rollback path: one env var, no code change.
    process.env.GEMINI_API_KEY = "test-key";
    process.env.AI_DORA_FILL_MODEL = "gemini:gemini-3.7-flash";
    resetAiEnvCache();
    const model = await getChatModel({ role: "dora_fill" });
    expect(model.constructor.name).toBe("ChatGoogleGenerativeAI");
    expect(fieldsOf(model).model).toBe("gemini-3.7-flash");
  });

  it("omits sampling parameters rejected by Gemini 3.6 and newer", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.AI_DORA_FILL_MODEL = "gemini:gemini-3.7-flash";
    resetAiEnvCache();

    const model = await getChatModel({ role: "dora_fill", temperature: 0 });

    expect(model.constructor.name).toBe("ChatGoogleGenerativeAI");
    expect((model as { model?: string }).model).toBe("gemini-3.7-flash");
    expect((model as { temperature?: number }).temperature).toBeUndefined();
  });

  it("routes to openai when configured, with a clear missing-key error", async () => {
    process.env.AI_MODEL_ROLES = JSON.stringify({ agent: "openai:gpt-test" });
    await expect(getAgentChatModel()).rejects.toThrow(
      /OPENAI_API_KEY is not configured.*provider "openai"/,
    );

    process.env.OPENAI_API_KEY = "sk-test";
    resetAiEnvCache();
    const model = await getAgentChatModel();
    expect(model.constructor.name).toBe("ChatOpenAI");
  });

  it("routes to anthropic when configured, with a clear missing-key error", async () => {
    process.env.AI_MODEL_ROLES = JSON.stringify({ agent: "anthropic:claude-test" });
    await expect(getAgentChatModel()).rejects.toThrow(
      /ANTHROPIC_API_KEY is not configured.*provider "anthropic"/,
    );

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    resetAiEnvCache();
    const model = await getAgentChatModel();
    expect(model.constructor.name).toBe("ChatAnthropic");
  });

  it("rejects unknown providers", async () => {
    process.env.AI_MODEL_ROLES = JSON.stringify({ agent: "mistral:some-model" });
    await expect(getAgentChatModel()).rejects.toThrow(
      /Unknown agent provider "mistral"[\s\S]*azure/,
    );
  });

  it("honors the test override", async () => {
    const fake = { invoke: async () => "fake" } as never;
    setAgentModelForTests(fake);
    expect(await getAgentChatModel()).toBe(fake);
  });
});

describe("reasoning effort is clamped per provider", () => {
  it("folds the two top rungs into Gemini's HIGH thinking level", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.AI_MODEL_ROLES = JSON.stringify({ agent: "gemini:gemini-3.5-flash" });
    process.env.AI_ROLE_REASONING = JSON.stringify({ agent: "xhigh" });
    resetAiEnvCache();

    // Gemini's thinkingLevel has only LOW|MEDIUM|HIGH. Passing "XHIGH"
    // through would be an INVALID_ARGUMENT on a deployment that never asked
    // for the wider ladder.
    expect(fieldsOf(await getAgentChatModel()).thinkingConfig?.thinkingLevel).toBe("HIGH");
  });

  it('maps "none" to minimal only on gpt-5.0, and to none on later models', async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.AI_ROLE_REASONING = JSON.stringify({ agent: "none" });

    process.env.AI_MODEL_ROLES = JSON.stringify({ agent: "openai:gpt-5" });
    resetAiEnvCache();
    expect(fieldsOf(await getAgentChatModel()).reasoning?.effort).toBe("minimal");

    // The regression this guards: a separator class including "." made
    // "gpt-5.6-luna" match the gpt-5.0 branch and send `minimal`, which the
    // model rejects outright.
    process.env.AI_MODEL_ROLES = JSON.stringify({ agent: "openai:gpt-5.6-luna" });
    resetAiEnvCache();
    expect(fieldsOf(await getAgentChatModel()).reasoning?.effort).toBe("none");
  });

  it("sends reasoning via `reasoning.effort`, not the constructor-ignored spelling", async () => {
    // Regression test. `reasoningEffort` is a CALL option only, so the old
    // `{ reasoningEffort }` constructor field meant this provider silently
    // never sent reasoning_effort at all.
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.AI_MODEL_ROLES = JSON.stringify({ agent: "openai:gpt-5.6-luna" });
    process.env.AI_ROLE_REASONING = JSON.stringify({ agent: "high" });
    resetAiEnvCache();

    const model = await getAgentChatModel();
    expect(fieldsOf(model).reasoning).toEqual({ effort: "high" });
    expect(model).not.toHaveProperty("reasoningEffort");
  });
});

describe("azure provider", () => {
  it("builds a ChatOpenAI carrying the model id, not the deployment name", async () => {
    azureEnv({ agent: "azure:gpt-5.6-luna" });
    const model = await getAgentChatModel();
    const fields = fieldsOf(model);

    // Plain ChatOpenAI: this resource serves only /openai/v1, and
    // AzureChatOpenAI hard-codes a /openai/deployments base URL that 404s.
    expect(model.constructor.name).toBe("ChatOpenAI");
    // The model id has to be the gpt-5* string or LangChain sends max_tokens,
    // which is a hard 400 here. The deployment is swapped in by the transport.
    expect(fields.model).toBe("gpt-5.6-luna");
    // gpt-5.x accepts only its default temperature; anything else is a 400.
    expect(fields.temperature).toBeUndefined();
    expect(fields.useResponsesApi).toBe(true);
    expect(fields.promptCacheKey).toBe("bauai:agent");
  });

  it("applies the per-role effort and budget table", async () => {
    azureEnv({
      agent: "azure:gpt-5.6-luna",
      report: "azure:gpt-5.6-luna",
      dora_fast: "azure:gpt-5.6-luna",
    });

    // dora_fast streams into a document, so it does no thinking at all;
    // report is a background job and gets the top rung.
    expect(fieldsOf(await getChatModel({ role: "dora_fast" })).reasoning?.effort).toBe("none");
    expect(fieldsOf(await getChatModel({ role: "report" })).reasoning?.effort).toBe("xhigh");
    expect(fieldsOf(await getChatModel({ role: "report" })).maxTokens).toBe(65_536);
    expect(fieldsOf(await getChatModel({ role: "agent" })).reasoning?.effort).toBe("medium");
  });

  it("lets AI_ROLE_REASONING and the call site override the table", async () => {
    azureEnv({ agent: "azure:gpt-5.6-luna" }, {
      AI_ROLE_REASONING: JSON.stringify({ agent: "low" }),
    });
    expect(fieldsOf(await getAgentChatModel()).reasoning?.effort).toBe("low");
    expect(
      fieldsOf(await getChatModel({ role: "agent", reasoningEffort: "xhigh" })).reasoning?.effort,
    ).toBe("xhigh");
  });

  it("resolves the deployment from the map, then the single-deployment fallback", async () => {
    azureEnv({ agent: "azure:gpt-5.6-luna" }, {
      AI_AZURE_DEPLOYMENTS: JSON.stringify({ "gpt-5.6-luna": "luna-prod" }),
    });
    const { resolveAzureDeployment } = await import("../gateway/config.ts");
    expect(resolveAzureDeployment("gpt-5.6-luna")).toBe("luna-prod");
    // Anything unmapped falls back, so one deployment needs no config at all.
    expect(resolveAzureDeployment("gpt-5.6-terra")).toBe("luna-dev");
  });

  it("names both fixes when no deployment can be resolved", async () => {
    process.env.AI_MODEL_ROLES = JSON.stringify({ agent: "azure:gpt-5.6-luna" });
    process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com/";
    resetAiEnvCache();
    await expect(getAgentChatModel()).rejects.toThrow(
      /No Azure deployment for model "gpt-5\.6-luna"[\s\S]*AZURE_OPENAI_DEPLOYMENT[\s\S]*AI_AZURE_DEPLOYMENTS/,
    );
  });

  it("reports a missing endpoint against the role that needed it", async () => {
    process.env.AI_MODEL_ROLES = JSON.stringify({ agent: "azure:gpt-5.6-luna" });
    process.env.AZURE_OPENAI_DEPLOYMENT = "luna-dev";
    resetAiEnvCache();
    await expect(getAgentChatModel()).rejects.toThrow(
      /AZURE_OPENAI_ENDPOINT is not configured[\s\S]*"agent" role[\s\S]*"azure"/,
    );
  });

  it("reuses one token provider across calls", async () => {
    // getChatModel runs on every turn and every planner call; a fresh
    // DefaultAzureCredential per call would re-authenticate against Entra
    // each time.
    resetAzureTokenProviderForTests(null);
    let constructed = 0;
    const { getAzureTokenProvider, resetAzureTokenProviderForTests: reset } = await import(
      "../config/azure.ts"
    );
    reset(async () => {
      constructed += 1;
      return "stub-token";
    });
    const first = await getAzureTokenProvider();
    const second = await getAzureTokenProvider();
    expect(first).toBe(second);
    expect(constructed).toBe(0);
  });
});
