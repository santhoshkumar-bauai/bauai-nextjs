import { AIMessage } from "@langchain/core/messages";
import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tier routing of the three planner sub-calls: which role each call pins,
 * temperature 0 everywhere, escalation promoting critique to the plan tier,
 * and the structured planner_call log line (the only place these calls'
 * token spend is visible — they bypass turn metrics by design).
 */

interface LogMock {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: () => LogMock;
}

const { logMock } = vi.hoisted(() => {
  const logMock: LogMock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logMock,
  };
  return { logMock };
});

vi.mock("../../ingestion/observability/logger.ts", () => ({ logger: logMock }));
vi.mock("../agent/model.ts", () => ({ getChatModel: vi.fn() }));
vi.mock("../dora/fill/grounding.ts", () => ({
  buildFillGrounding: vi.fn(async () => ({ profileLines: [], corpusLines: [] })),
}));

const model = await import("../agent/model.ts");
const { proposeFieldmapWithModel, critiqueFillWithModel, repairFieldmapWithModel } =
  await import("./planner.ts");

import type { FillAgentRunContext } from "./context.ts";

function fakeModel(json: unknown) {
  return {
    invoke: vi.fn(
      async () =>
        new AIMessage({
          content: JSON.stringify(json),
          usage_metadata: { input_tokens: 111, output_tokens: 22, total_tokens: 133 },
        }),
    ),
  };
}

function buildCtx(): FillAgentRunContext {
  const ctx = {
    tenantId: new ObjectId("64a000000000000000000001"),
    locale: "en" as const,
    session: {
      pdf: { pageCount: 1 },
      nativeFields: [],
      values: {},
      fieldmap: [],
      issues: [{ severity: "warning", code: "W", field_id: "a", page: 1, detail: "d" }],
      fillIterations: 1,
    },
    sandbox: {
      downloadFile: vi.fn(async (_ws: string, name: string) => {
        if (name === "geometry.json") return Buffer.from(JSON.stringify({ pages: [] }));
        throw new Error("no such file"); // page renders degrade to geometry-only
      }),
      runCrops: vi.fn(async () => ({ pairs: [] })),
    },
    ensureSandbox: vi.fn(async () => "ws1"),
  } as unknown as FillAgentRunContext;
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planner tier routing", () => {
  it("plan runs on fill_agent_plan with temperature 0", async () => {
    vi.mocked(model.getChatModel).mockResolvedValue(fakeModel({ fields: [] }) as never);
    await proposeFieldmapWithModel(buildCtx());
    expect(model.getChatModel).toHaveBeenCalledWith({
      role: "fill_agent_plan",
      temperature: 0,
    });
  });

  it("critique runs on fill_agent_critique by default", async () => {
    vi.mocked(model.getChatModel).mockResolvedValue(fakeModel({ issues: [] }) as never);
    await critiqueFillWithModel(buildCtx());
    expect(model.getChatModel).toHaveBeenCalledWith({
      role: "fill_agent_critique",
      temperature: 0,
    });
  });

  it("critique is promoted to the plan tier on escalation", async () => {
    vi.mocked(model.getChatModel).mockResolvedValue(fakeModel({ issues: [] }) as never);
    await critiqueFillWithModel(buildCtx(), { escalate: true });
    expect(model.getChatModel).toHaveBeenCalledWith({
      role: "fill_agent_plan",
      temperature: 0,
    });
  });

  it("repair runs on fill_agent_repair", async () => {
    vi.mocked(model.getChatModel).mockResolvedValue(
      fakeModel({ update: [], add: [], remove: [] }) as never,
    );
    await repairFieldmapWithModel(buildCtx());
    expect(model.getChatModel).toHaveBeenCalledWith({
      role: "fill_agent_repair",
      temperature: 0,
    });
  });

  it("every call emits a planner_call log line with its token usage", async () => {
    vi.mocked(model.getChatModel).mockResolvedValue(
      fakeModel({ update: [], add: [], remove: [] }) as never,
    );
    await repairFieldmapWithModel(buildCtx());
    expect(logMock.info).toHaveBeenCalledWith(
      "planner_call",
      expect.objectContaining({
        role: "fill_agent_repair",
        inputTokens: 111,
        outputTokens: 22,
        totalTokens: 133,
        retry: false,
      }),
    );
  });

  it("the escalated critique is marked in the log line", async () => {
    vi.mocked(model.getChatModel).mockResolvedValue(fakeModel({ issues: [] }) as never);
    await critiqueFillWithModel(buildCtx(), { escalate: true });
    expect(logMock.info).toHaveBeenCalledWith(
      "planner_call",
      expect.objectContaining({ role: "fill_agent_plan", escalated: true }),
    );
  });
});
