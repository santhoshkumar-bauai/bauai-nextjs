import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAiEnvCache } from "../config/env.ts";
import { getAgentChatModel, getChatModel, setAgentModelForTests } from "./model.ts";

const KEYS = [
  "AI_MODEL_ROLES",
  "AI_DORA_FILL_MODEL",
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
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAiEnvCache();
  setAgentModelForTests(null);
});

describe("getAgentChatModel", () => {
  it("defaults the agent role to gemini-3.5-flash", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const model = await getAgentChatModel();
    expect(model.constructor.name).toBe("ChatGoogleGenerativeAI");
    expect((model as { model?: string }).model).toContain("gemini-3.5-flash");
    expect((model as { temperature?: number }).temperature).toBe(0.2);
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
    await expect(getAgentChatModel()).rejects.toThrow(/Unknown agent provider "mistral"/);
  });

  it("honors the test override", async () => {
    const fake = { invoke: async () => "fake" } as never;
    setAgentModelForTests(fake);
    expect(await getAgentChatModel()).toBe(fake);
  });
});
