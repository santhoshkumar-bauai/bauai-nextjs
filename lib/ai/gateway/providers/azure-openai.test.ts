import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { resetAiEnvCache } from "../../config/env.ts";
import { ContentFilterError, RateLimitError, StructuredOutputError } from "../types.ts";
import { AzureOpenAIProvider, retryAfterMs, type AzureChatClient } from "./azure-openai.ts";

/** Drill-anywhere view of the JSON schema the provider puts on the wire. */
interface SchemaView {
  [key: string]: SchemaView;
}

const KEYS = [
  "AI_MODEL_ROLES",
  "AI_ROLE_REASONING",
  "AI_ROLE_MAX_OUTPUT_TOKENS",
  "AI_AZURE_DEPLOYMENTS",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com/";
  process.env.AZURE_OPENAI_DEPLOYMENT = "luna-dev";
  process.env.AI_MODEL_ROLES = JSON.stringify({ extraction: "azure:gpt-5.6-luna" });
  resetAiEnvCache();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAiEnvCache();
});

const schema = z.object({ label: z.string() });
const request = {
  role: "extraction" as const,
  prompt: "classify this",
  schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
  zod: schema,
  temperature: 0,
};

/** A client whose `create` replays a scripted queue of results or throws. */
function fakeClient(responses: unknown[]) {
  const calls: unknown[] = [];
  const client: AzureChatClient = {
    chat: {
      completions: {
        create: (async (body: unknown) => {
          calls.push(body);
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return next;
        }) as never,
      },
    },
  };
  return { client, calls };
}

const ok = (content: string, finish = "stop") => ({
  choices: [{ finish_reason: finish, message: { content } }],
});

function apiError(status: number, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
}

describe("AzureOpenAIProvider.generateStructured", () => {
  it("parses and zod-validates a good response", async () => {
    const { client } = fakeClient([ok('{"label":"works"}')]);
    const result = await new AzureOpenAIProvider({ client }).generateStructured(
      "gpt-5.6-luna",
      request,
    );
    expect(result).toEqual({ value: { label: "works" }, provider: "azure", model: "gpt-5.6-luna" });
  });

  it("sends max_completion_tokens, a strict schema, and NO temperature", async () => {
    const { client, calls } = fakeClient([ok('{"label":"x"}')]);
    await new AzureOpenAIProvider({ client }).generateStructured("gpt-5.6-luna", request);

    const body = calls[0] as unknown as SchemaView;
    // max_tokens is a hard 400 on this model family.
    expect(body).toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("max_tokens");
    // gpt-5.x accepts only its default temperature, so the caller's 0 is
    // deliberately dropped rather than forwarded.
    expect(body).not.toHaveProperty("temperature");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    // The schema name must match Azure's ^[a-zA-Z0-9_-]+$.
    expect(body.response_format.json_schema.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(body.reasoning_effort).toBe("low");
    // The model id goes on the body; the transport swaps in the deployment.
    expect(body.model).toBe("gpt-5.6-luna");
  });

  it("adapts the schema to strict mode before sending it", async () => {
    const { client, calls } = fakeClient([ok('{"a":"x","b":null}')]);
    await new AzureOpenAIProvider({ client }).generateStructured("gpt-5.6-luna", {
      ...request,
      schema: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: ["a"],
      },
      zod: z.object({ a: z.string(), b: z.string().nullable() }),
    });
    const sent = (
      calls[0] as unknown as {
        response_format: { json_schema: { schema: SchemaView } };
      }
    ).response_format.json_schema.schema;
    expect(sent.required).toEqual(["a", "b"]);
    expect(sent.properties.b.type).toEqual(["string", "null"]);
  });

  it("retries a 429, then gives up with a RateLimitError the workers can use", async () => {
    // `retry-after-ms: 1` keeps the real backoff ladder in play without making
    // the suite sleep through it.
    const limited = () => apiError(429, { headers: new Headers({ "retry-after-ms": "1" }) });

    const { client } = fakeClient([limited(), ok('{"label":"second try"}')]);
    await expect(
      new AzureOpenAIProvider({ client }).generateStructured("gpt-5.6-luna", request),
    ).resolves.toMatchObject({ value: { label: "second try" } });

    const { client: always, calls } = fakeClient([limited(), limited(), limited()]);
    const error = await new AzureOpenAIProvider({ client: always })
      .generateStructured("gpt-5.6-luna", request)
      .catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    // Three attempts, matching the Gemini adapter's ladder.
    expect(calls).toHaveLength(3);
    // The BullMQ workers delay-retry on this value.
    expect((error as RateLimitError).retryAfterMs).toBe(1);
  });

  it("retries a 5xx then succeeds", async () => {
    const { client } = fakeClient([apiError(503), ok('{"label":"recovered"}')]);
    await expect(
      new AzureOpenAIProvider({ client }).generateStructured("gpt-5.6-luna", request),
    ).resolves.toMatchObject({ value: { label: "recovered" } });
  });

  it("throws ContentFilterError on a prompt-side 400", async () => {
    const { client } = fakeClient([apiError(400, { code: "content_filter" })]);
    await expect(
      new AzureOpenAIProvider({ client }).generateStructured("gpt-5.6-luna", request),
    ).rejects.toBeInstanceOf(ContentFilterError);
  });

  it("throws ContentFilterError on a completion-side HTTP 200", async () => {
    // The dangerous shape: 200 with finish_reason content_filter and empty
    // content. Probe P12 saw exactly this on ordinary German procurement text.
    const { client } = fakeClient([ok("", "content_filter")]);
    const error = await new AzureOpenAIProvider({ client })
      .generateStructured("gpt-5.6-luna", request)
      .catch((e) => e);
    expect(error).toBeInstanceOf(ContentFilterError);
    expect((error as ContentFilterError).stage).toBe("completion");
  });

  it("reports a truncated response as truncation, not as bad JSON", async () => {
    // Also an HTTP 200 with empty content (probe P14). Calling this "non-JSON
    // output" sends the reader to the schema instead of the token budget.
    const { client } = fakeClient([ok("", "length")]);
    const error = await new AzureOpenAIProvider({ client })
      .generateStructured("gpt-5.6-luna", request)
      .catch((e) => e);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect((error as Error).message).toMatch(/truncated[\s\S]*AI_ROLE_MAX_OUTPUT_TOKENS/);
  });

  it("throws StructuredOutputError on non-JSON and on schema mismatch", async () => {
    const { client: bad } = fakeClient([ok("not json at all")]);
    await expect(
      new AzureOpenAIProvider({ client: bad }).generateStructured("gpt-5.6-luna", request),
    ).rejects.toBeInstanceOf(StructuredOutputError);

    const { client: wrong } = fakeClient([ok('{"label":42}')]);
    await expect(
      new AzureOpenAIProvider({ client: wrong }).generateStructured("gpt-5.6-luna", request),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it("names the required Entra role on a 403", async () => {
    const { client } = fakeClient([apiError(403)]);
    await expect(
      new AzureOpenAIProvider({ client }).generateStructured("gpt-5.6-luna", request),
    ).rejects.toThrow(/Cognitive Services OpenAI User/);
  });
});

describe("AzureOpenAIProvider.embed", () => {
  it("refuses, and explains what moving embeddings would actually cost", async () => {
    // This message is the guardrail between a one-line AI_MODEL_ROLES edit and
    // a silent corpus rebuild.
    await expect(new AzureOpenAIProvider().embed()).rejects.toThrow(
      /re-embedding every stored vector[\s\S]*Atlas vector/,
    );
  });
});

describe("retryAfterMs", () => {
  it("converts seconds to milliseconds and prefers the millisecond header", () => {
    // `retry-after` is in SECONDS; treating it as ms would retry ~1000x too
    // eagerly against a deployment that just told us to back off.
    expect(retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2_000);
    expect(retryAfterMs(new Headers({ "retry-after-ms": "750" }))).toBe(750);
    expect(
      retryAfterMs(new Headers({ "retry-after": "2", "retry-after-ms": "750" })),
    ).toBe(750);
  });

  it("falls back to the exponential ladder when the header is absent or junk", () => {
    expect(retryAfterMs(undefined)).toBeNull();
    expect(retryAfterMs(new Headers())).toBeNull();
    expect(retryAfterMs(new Headers({ "retry-after": "soon" }))).toBeNull();
  });

  it("accepts a plain header record as well as a Headers instance", () => {
    expect(retryAfterMs({ "retry-after": "3" })).toBe(3_000);
  });
});
