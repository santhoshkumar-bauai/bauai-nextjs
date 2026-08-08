import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitationCollector } from "./citations.ts";
import type { AgentRunContext } from "./context.ts";

vi.mock("../retrieval/hybrid.ts", () => ({
  hybridRetrieveChunks: vi.fn(),
  hybridRetrieveCompanyChunks: vi.fn(),
}));
vi.mock("../extraction/store.ts", () => ({ getExtractions: vi.fn() }));
vi.mock("../overview/service.ts", () => ({ getTenderOverview: vi.fn() }));
vi.mock("../fit/service.ts", () => ({ getFitState: vi.fn() }));

const retrieval = await import("../retrieval/hybrid.ts");
const { buildDoraTools } = await import("./tools.ts");

function fakeCtx(): AgentRunContext {
  return {
    tenantId: new ObjectId(),
    tenderId: new ObjectId(),
    userId: "user-1",
    locale: "de",
    companyContext: {} as never,
    citations: new CitationCollector(),
    tenderDetail: {
      title: "Testausschreibung",
      status: "OPEN",
      buyer: null,
      procedureType: "open",
      contractNature: "works",
      cpvCodes: ["45000000"],
      regions: ["DE11"],
      countries: ["DE"],
      estimatedValue: null,
      publicationDate: null,
      submissionDeadline: null,
      lots: [],
      documents: [],
      sourceLinks: [],
      description: "x".repeat(5000),
      id: "t",
      businessCategory: "TENDER",
      language: "de",
    } as never,
  };
}

function toolByName(ctx: AgentRunContext, name: string) {
  const found = buildDoraTools(ctx).find((tool) => tool.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  vi.mocked(retrieval.hybridRetrieveChunks).mockReset();
  vi.mocked(retrieval.hybridRetrieveCompanyChunks).mockReset();
});

describe("buildDoraTools", () => {
  it("registers exactly the six v1 tools", () => {
    const names = buildDoraTools(fakeCtx()).map((tool) => tool.name);
    expect(names.sort()).toEqual([
      "get_company_fit",
      "get_extractions",
      "get_tender_notice",
      "get_tender_overview",
      "search_company_documents",
      "search_tender_documents",
    ]);
  });

  it("get_tender_notice caps the description and wraps it as document data", async () => {
    const result = JSON.parse(
      (await toolByName(fakeCtx(), "get_tender_notice").invoke({})) as string,
    );
    expect(result.description.startsWith("<document>")).toBe(true);
    expect(result.description.length).toBeLessThan(2100 + 30);
  });

  it("search_tender_documents forces the context tenderId and null tenant", async () => {
    const ctx = fakeCtx();
    vi.mocked(retrieval.hybridRetrieveChunks).mockResolvedValue([]);
    await toolByName(ctx, "search_tender_documents").invoke({
      query: "Angebotsfrist",
      k: 5,
    });
    const call = vi.mocked(retrieval.hybridRetrieveChunks).mock.calls[0][0];
    expect(call.filters.tenderId).toBe(ctx.tenderId);
    expect(call.filters.tenantId).toBeNull();
    expect(call.k).toBe(5);
  });

  it("search_company_documents forces the context tenantId", async () => {
    const ctx = fakeCtx();
    vi.mocked(retrieval.hybridRetrieveCompanyChunks).mockResolvedValue([]);
    await toolByName(ctx, "search_company_documents").invoke({
      query: "Haftpflicht",
      k: 3,
    });
    const call = vi.mocked(retrieval.hybridRetrieveCompanyChunks).mock.calls[0][0];
    expect(call.filters.tenantId).toBe(ctx.tenantId);
  });

  it("rejects invalid inputs via zod", async () => {
    const searchTool = toolByName(fakeCtx(), "search_tender_documents");
    await expect(searchTool.invoke({ query: "ab", k: 5 })).rejects.toThrow();
    await expect(
      searchTool.invoke({ query: "valid query", k: 50 }),
    ).rejects.toThrow();
  });

  it("caps chunk text and registers citations", async () => {
    const ctx = fakeCtx();
    vi.mocked(retrieval.hybridRetrieveChunks).mockResolvedValue([
      {
        chunkId: new ObjectId(),
        tenderId: ctx.tenderId,
        documentRecordId: "proc:x#1",
        fileSha256: "f".repeat(64),
        fileName: "AGB.pdf",
        sectionPath: [],
        text: "y".repeat(4000),
        legalRefs: [],
        anchor: { page: null, paragraph: null, bbox: null, charStart: 0, charEnd: 10 },
        scores: { fused: 1 },
        rank: 0,
      } as never,
    ]);
    const result = JSON.parse(
      (await toolByName(ctx, "search_tender_documents").invoke({
        query: "Vertragsstrafen",
        k: 8,
      })) as string,
    );
    expect(result[0].text.length).toBeLessThanOrEqual(1500 + 30);
    expect(ctx.citations.list()).toHaveLength(1);
    expect(result[0].citationKey).toBe("c1");
  });
});

describe("CitationCollector", () => {
  it("dedupes identical chunk/quote pairs and caps quotes", () => {
    const collector = new CitationCollector();
    const first = collector.add({ quote: "z".repeat(1000), fileName: "a.pdf", chunkId: "c" });
    const second = collector.add({ quote: "z".repeat(1000), fileName: "a.pdf", chunkId: "c" });
    expect(second.key).toBe(first.key);
    expect(first.quote.length).toBeLessThanOrEqual(401);
    expect(collector.list()).toHaveLength(1);
  });
});
