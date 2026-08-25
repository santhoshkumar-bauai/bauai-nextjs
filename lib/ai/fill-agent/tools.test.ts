import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./store.ts", () => ({ updateFillSession: vi.fn() }));
vi.mock("./planner.ts", () => ({
  proposeFieldmapWithModel: vi.fn(),
  critiqueFillWithModel: vi.fn(),
  repairFieldmapWithModel: vi.fn(),
}));
vi.mock("../../storage/s3.ts", () => ({
  buildObjectKey: vi.fn(() => "companies/x/fill-agent-poc/key.pdf"),
  putObjectBuffer: vi.fn(async () => {}),
}));

const store = await import("./store.ts");
const planner = await import("./planner.ts");
const s3 = await import("../../storage/s3.ts");
const { buildFillAgentTools } = await import("./tools.ts");

import type { FillAgentRunContext } from "./context.ts";
import type { FillAgentSessionDocument } from "./store.ts";
import type { FillIssue } from "./fieldmap.ts";

function baseSession(): FillAgentSessionDocument {
  return {
    _id: new ObjectId("64a000000000000000000010"),
    tenantId: new ObjectId("64a000000000000000000001"),
    createdBy: "user-1",
    documentId: null,
    status: "in_progress",
    source: {
      s3Key: "companies/x/fill-agent-poc/src.pdf",
      fileName: "form.pdf",
      sha256: "abc",
      sizeBytes: 1000,
    },
    pdf: {
      documentClass: "digital",
      pageCount: 1,
      manifestHash: "hash",
      acroFieldCount: 0,
    },
    sandboxSessionId: "ws1",
    fieldmap: [
      {
        id: "company_name",
        page: 1,
        kind: "text",
        box: [100, 100, 300, 120],
        value: "Muster Bau GmbH",
        label: "Firmenname",
      },
    ],
    values: {},
    openQuestions: [],
    nativeFields: [],
    fillIterations: 0,
    maxFillIterations: 5,
    targetScore: 0.95,
    score: null,
    issues: [],
    critiqued: false,
    output: null,
    threadId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeSandbox(validate: { issues: FillIssue[]; score: number; summary: string }) {
  return {
    uploadFile: vi.fn(async () => ({ name: "fieldmap.json", sizeBytes: 1, sha256: "s" })),
    runPrepare: vi.fn(async () => ({
      fieldCount: 1,
      styleGroups: 0,
      preparedFile: "fieldmap.prepared.json",
    })),
    runFill: vi.fn(async () => ({ outputFile: "filled.pdf", pageImages: [] })),
    runValidate: vi.fn(async () => validate),
    downloadFile: vi.fn(async () => Buffer.from("%PDF-1.7 fake")),
    listFiles: vi.fn(async () => []),
    exec: vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      stdout: "ok",
      stderr: "",
      durationMs: 5,
      newFiles: [],
    })),
    runCrops: vi.fn(async () => ({ pairs: [] })),
    runAnalyze: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    health: vi.fn(),
  };
}

function buildCtx(
  session: FillAgentSessionDocument,
  sandbox: ReturnType<typeof fakeSandbox>,
): FillAgentRunContext {
  const ctx = {
    tenantId: session.tenantId,
    userId: "user-1",
    locale: "en" as const,
    companyContext: { company: { _id: new ObjectId("64a0000000000000000000aa") } },
    tender: null,
    tenderCache: new Map(),
    session,
    sandbox,
    analyzeResult: null,
    ensureSandbox: vi.fn(async () => "ws1"),
    reloadSession: vi.fn(async () => ctx.session),
  } as unknown as FillAgentRunContext;
  return ctx;
}

function toolByName(ctx: FillAgentRunContext, name: string) {
  const found = buildFillAgentTools(ctx).find((tool) => tool.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  // updateFillSession mock: merge into the ctx session like the real store.
  vi.mocked(store.updateFillSession).mockImplementation(
    async (_tenantId, _sessionId, set) =>
      Object.assign(currentSession, set) as FillAgentSessionDocument,
  );
});

let currentSession: FillAgentSessionDocument;

describe("fill_and_validate gating", () => {
  it("refuses when the per-session fill budget is exhausted (escalate)", async () => {
    currentSession = { ...baseSession(), fillIterations: 5 };
    const sandbox = fakeSandbox({ issues: [], score: 1, summary: "No issues." });
    const result = JSON.parse(
      (await toolByName(buildCtx(currentSession, sandbox), "fill_and_validate").invoke(
        {},
      )) as string,
    );
    expect(result.escalate).toBe(true);
    expect(result.reason).toBe("fill_budget_exhausted");
    expect(sandbox.runFill).not.toHaveBeenCalled();
  });

  it("refuses while required values are still open", async () => {
    currentSession = {
      ...baseSession(),
      openQuestions: [
        { fieldId: "req", label: "Umsatz", reason: "missing_required" as const },
      ],
    };
    const sandbox = fakeSandbox({ issues: [], score: 1, summary: "No issues." });
    const result = JSON.parse(
      (await toolByName(buildCtx(currentSession, sandbox), "fill_and_validate").invoke(
        {},
      )) as string,
    );
    expect(result.refused).toBe(true);
    expect(result.reason).toBe("open_required_questions");
    expect(sandbox.runFill).not.toHaveBeenCalled();
  });

  it("stores the SANDBOX's score verbatim and ships the PDF on target", async () => {
    currentSession = baseSession();
    const sandbox = fakeSandbox({ issues: [], score: 0.97, summary: "No issues." });
    const result = JSON.parse(
      (await toolByName(buildCtx(currentSession, sandbox), "fill_and_validate").invoke(
        {},
      )) as string,
    );
    expect(result.score).toBe(0.97);
    expect(result.done).toBe(true);
    expect(sandbox.runPrepare).toHaveBeenCalled(); // prepare ALWAYS re-runs
    expect(vi.mocked(s3.putObjectBuffer)).toHaveBeenCalledTimes(1);
    expect(currentSession.score).toBe(0.97);
    expect(currentSession.status).toBe("filled");
    expect(currentSession.fillIterations).toBe(1);
    expect(currentSession.output?.s3Key).toBe("companies/x/fill-agent-poc/key.pdf");
  });

  it("below target: no upload, budget consumed, repair hinted", async () => {
    currentSession = baseSession();
    const sandbox = fakeSandbox({
      issues: [
        { severity: "error", code: "OVERFLOW_X", field_id: "company_name", page: 1, detail: "d" },
      ],
      score: 0,
      summary: "[ERROR] OVERFLOW_X",
    });
    const result = JSON.parse(
      (await toolByName(buildCtx(currentSession, sandbox), "fill_and_validate").invoke(
        {},
      )) as string,
    );
    expect(result.done).toBeUndefined();
    expect(result.errors).toBe(1);
    expect(vi.mocked(s3.putObjectBuffer)).not.toHaveBeenCalled();
    expect(currentSession.fillIterations).toBe(1);
  });
});

describe("critique_fill gating (server-enforced, not prompt-enforced)", () => {
  it("refuses before any validate ran", async () => {
    currentSession = baseSession();
    const ctx = buildCtx(currentSession, fakeSandbox({ issues: [], score: 1, summary: "" }));
    const result = JSON.parse(
      (await toolByName(ctx, "critique_fill").invoke({})) as string,
    );
    expect(result.reason).toBe("critique_requires_validate");
    expect(planner.critiqueFillWithModel).not.toHaveBeenCalled();
  });

  it("refuses while deterministic errors remain", async () => {
    currentSession = {
      ...baseSession(),
      score: 0,
      issues: [{ severity: "error", code: "X", field_id: null, page: null, detail: "d" }],
    };
    const ctx = buildCtx(currentSession, fakeSandbox({ issues: [], score: 1, summary: "" }));
    const result = JSON.parse(
      (await toolByName(ctx, "critique_fill").invoke({})) as string,
    );
    expect(result.reason).toBe("critique_requires_clean_validate");
  });

  it("runs once per session, merges ADD-ONLY, and re-scores in trusted code", async () => {
    currentSession = {
      ...baseSession(),
      score: 1,
      issues: [{ severity: "warning", code: "HEAVY_SHRINK", field_id: "a", page: 1, detail: "d" }],
    };
    vi.mocked(planner.critiqueFillWithModel).mockResolvedValue([
      { severity: "warning", code: "VISUAL", field_id: "b", page: 1, detail: "cramped" },
    ]);
    const ctx = buildCtx(currentSession, fakeSandbox({ issues: [], score: 1, summary: "" }));
    const result = JSON.parse(
      (await toolByName(ctx, "critique_fill").invoke({})) as string,
    );
    // prior warning kept + new one added; 2 warnings → 0.96 by the ported policy
    expect(currentSession.issues).toHaveLength(2);
    expect(result.score).toBe(0.96);
    expect(currentSession.critiqued).toBe(true);

    const again = JSON.parse(
      (await toolByName(ctx, "critique_fill").invoke({})) as string,
    );
    expect(again.reason).toBe("critique_already_done");
    expect(planner.critiqueFillWithModel).toHaveBeenCalledTimes(1);
  });
});

describe("repair_fieldmap", () => {
  it("refuses with no recorded issues", async () => {
    currentSession = baseSession();
    const ctx = buildCtx(currentSession, fakeSandbox({ issues: [], score: 1, summary: "" }));
    const result = JSON.parse(
      (await toolByName(ctx, "repair_fieldmap").invoke({})) as string,
    );
    expect(result.reason).toBe("nothing_to_repair");
    expect(planner.repairFieldmapWithModel).not.toHaveBeenCalled();
  });

  it("merges the model's PATCH in trusted code and re-applies the ratchet", async () => {
    currentSession = {
      ...baseSession(),
      issues: [{ severity: "error", code: "OVERFLOW_X", field_id: "company_name", page: 1, detail: "d" }],
    };
    vi.mocked(planner.repairFieldmapWithModel).mockResolvedValue({
      update: [{ id: "company_name", font_size: 8 }],
      add: [
        {
          id: "iban_field",
          page: 1,
          kind: "text",
          box: [1, 2, 30, 12],
          label: "IBAN",
          value: "DE00 SNEAKY", // model-invented sensitive value → must be blanked
        },
      ],
      remove: [],
    });
    const ctx = buildCtx(currentSession, fakeSandbox({ issues: [], score: 1, summary: "" }));
    const result = JSON.parse(
      (await toolByName(ctx, "repair_fieldmap").invoke({})) as string,
    );
    expect(result.updated).toBe(1);
    const byId = new Map(currentSession.fieldmap.map((f) => [f.id, f]));
    expect(byId.get("company_name")?.font_size).toBe(8);
    expect(byId.get("iban_field")?.sensitive).toBe(true);
    expect(byId.get("iban_field")?.value).toBe("");
  });
});

describe("run_python", () => {
  it("labels output as observation-only", async () => {
    currentSession = baseSession();
    const sandbox = fakeSandbox({ issues: [], score: 1, summary: "" });
    const ctx = buildCtx(currentSession, sandbox);
    const result = JSON.parse(
      (await toolByName(ctx, "run_python").invoke({ code: "print('hi')" })) as string,
    );
    expect(sandbox.exec).toHaveBeenCalledWith("ws1", "print('hi')", undefined);
    expect(result.note).toMatch(/observation only/i);
  });
});
