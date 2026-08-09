import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitationCollector } from "./citations.ts";
import type { AgentRunContext, AgentTenderScope } from "./context.ts";

vi.mock("../retrieval/hybrid.ts", () => ({
  hybridRetrieveChunks: vi.fn(),
  hybridRetrieveCompanyChunks: vi.fn(),
  searchNotices: vi.fn(),
}));
vi.mock("../extraction/store.ts", () => ({ getExtractions: vi.fn() }));
vi.mock("../overview/service.ts", () => ({ getTenderOverview: vi.fn() }));
vi.mock("../fit/service.ts", () => ({
  getFitState: vi.fn(),
  companyProfileInput: vi.fn(() => ({})),
}));
vi.mock("../fit/company-context.ts", () => ({
  buildFullCompanyContext: vi.fn(() => "COMPANY BRIEF"),
}));
vi.mock("../company/doc-embedder.ts", () => ({
  getCompanyFilesCollection: vi.fn(),
  getCompanyDocEmbedStatuses: vi.fn(),
}));
vi.mock("../extraction/source-text.ts", () => ({ loadFileText: vi.fn() }));
vi.mock("../../tenders/document-files.ts", () => ({
  listFetchedTenderFiles: vi.fn(),
  findTenderFileByName: vi.fn(),
}));
vi.mock("./context.ts", () => ({ getVisibleTender: vi.fn() }));

const retrieval = await import("../retrieval/hybrid.ts");
const contextModule = await import("./context.ts");
const docEmbedder = await import("../company/doc-embedder.ts");
const { buildClaraTools } = await import("./tools.ts");

function tenderScope(): AgentTenderScope {
  return {
    tenderId: new ObjectId(),
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

function fakeCtx(tender: AgentTenderScope | null = tenderScope()): AgentRunContext {
  return {
    tenantId: new ObjectId(),
    userId: "user-1",
    locale: "de",
    companyContext: { company: {} } as never,
    citations: new CitationCollector(),
    tender,
    tenderCache: new Map(),
  };
}

function toolByName(ctx: AgentRunContext, name: string) {
  const found = buildClaraTools(ctx).find((tool) => tool.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  vi.mocked(retrieval.hybridRetrieveChunks).mockReset();
  vi.mocked(retrieval.hybridRetrieveCompanyChunks).mockReset();
  vi.mocked(retrieval.searchNotices).mockReset();
  vi.mocked(contextModule.getVisibleTender).mockReset();
});

describe("buildClaraTools — tender mode", () => {
  it("registers the tender registry (no find_tenders, no tenderId inputs)", () => {
    const names = buildClaraTools(fakeCtx()).map((tool) => tool.name);
    expect(names.sort()).toEqual([
      "get_company_fit",
      "get_company_profile",
      "get_extractions",
      "get_tender_notice",
      "get_tender_overview",
      "list_company_documents",
      "list_tender_files",
      "read_tender_document",
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
    expect(call.filters.tenderId).toBe(ctx.tender!.tenderId);
    expect(call.filters.tenantId).toBeNull();
    expect(call.k).toBe(5);
    // Scope is closed over — never resolved from tool input in tender mode.
    expect(contextModule.getVisibleTender).not.toHaveBeenCalled();
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
        tenderId: ctx.tender!.tenderId,
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

  it("read_tender_document caps text, wraps it and registers a citation", async () => {
    const ctx = fakeCtx();
    const docFiles = await import("../../tenders/document-files.ts");
    const sourceText = await import("../extraction/source-text.ts");
    vi.mocked(docFiles.findTenderFileByName).mockResolvedValue({
      fileName: "LV.pdf",
      mimeType: "application/pdf",
      textStatus: "DONE",
      textChars: 50_000,
    } as never);
    vi.mocked(sourceText.loadFileText).mockResolvedValue("z".repeat(50_000));

    const result = JSON.parse(
      (await toolByName(ctx, "read_tender_document").invoke({
        fileName: "LV.pdf",
      })) as string,
    );
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("<document>")).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(20_000 + 30);
    expect(ctx.citations.list()).toHaveLength(1);
  });

  it("get_company_profile wraps the brief as document data", async () => {
    const result = JSON.parse(
      (await toolByName(fakeCtx(), "get_company_profile").invoke({})) as string,
    );
    expect(result.profile).toBe("<document>COMPANY BRIEF</document>");
  });

  it("list_company_documents queries only the context tenant and reports status", async () => {
    const ctx = fakeCtx();
    const fileId = new ObjectId();
    const find = vi.fn(() => ({
      sort: () => ({
        limit: () => ({
          toArray: async () => [
            {
              _id: fileId,
              companyId: ctx.tenantId,
              category: "insurance",
              fileName: "police.pdf",
              contentType: "application/pdf",
              s3Key: "k",
              size: 1234,
              createdAt: new Date("2026-01-01"),
            },
          ],
        }),
      }),
    }));
    vi.mocked(docEmbedder.getCompanyFilesCollection).mockResolvedValue({
      find,
    } as never);
    vi.mocked(docEmbedder.getCompanyDocEmbedStatuses).mockResolvedValue(
      new Map([[String(fileId), "indexed"]]),
    );

    const result = JSON.parse(
      (await toolByName(ctx, "list_company_documents").invoke({})) as string,
    );
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: ctx.tenantId }),
    );
    expect(result[0].embeddingStatus).toBe("indexed");
    expect(result[0].fileName).toBe("police.pdf");
  });
});

describe("buildClaraTools — global mode", () => {
  it("registers find_tenders and tenderId-taking tender tools", () => {
    const names = buildClaraTools(fakeCtx(null)).map((tool) => tool.name);
    expect(names).toContain("find_tenders");
    expect(names).toHaveLength(11);
  });

  it("tender tools refuse invalid or hidden tender ids", async () => {
    const ctx = fakeCtx(null);
    vi.mocked(contextModule.getVisibleTender).mockResolvedValue(null);
    const result = JSON.parse(
      (await toolByName(ctx, "search_tender_documents").invoke({
        tenderId: "0".repeat(24),
        query: "Angebotsfrist",
        k: 5,
      })) as string,
    );
    expect(result.tenderNotFound).toBe(true);
    expect(retrieval.hybridRetrieveChunks).not.toHaveBeenCalled();
  });

  it("tender tools search the validated tender only", async () => {
    const ctx = fakeCtx(null);
    const scope = tenderScope();
    vi.mocked(contextModule.getVisibleTender).mockResolvedValue(scope);
    vi.mocked(retrieval.hybridRetrieveChunks).mockResolvedValue([]);
    await toolByName(ctx, "search_tender_documents").invoke({
      tenderId: scope.tenderId.toHexString(),
      query: "Angebotsfrist",
      k: 5,
    });
    const call = vi.mocked(retrieval.hybridRetrieveChunks).mock.calls[0][0];
    expect(call.filters.tenderId).toBe(scope.tenderId);
    expect(call.filters.tenantId).toBeNull();
  });

  it("find_tenders drops tenders that fail the visibility re-check", async () => {
    const ctx = fakeCtx(null);
    const visible = tenderScope();
    const hiddenId = new ObjectId();
    vi.mocked(retrieval.searchNotices).mockResolvedValue([
      { tenderId: visible.tenderId, score: 0.9 },
      { tenderId: hiddenId, score: 0.8 },
    ]);
    vi.mocked(contextModule.getVisibleTender).mockImplementation(
      async (_ctx, hex) => (hex === visible.tenderId.toHexString() ? visible : null),
    );
    const result = JSON.parse(
      (await toolByName(ctx, "find_tenders").invoke({
        query: "Straßenbau Bayern",
        limit: 5,
      })) as string,
    );
    expect(result).toHaveLength(1);
    expect(result[0].tenderId).toBe(visible.tenderId.toHexString());
  });

  it("company tools take no tender or tenant scope inputs in either mode", () => {
    for (const mode of [fakeCtx(), fakeCtx(null)]) {
      for (const name of [
        "search_company_documents",
        "get_company_profile",
        "list_company_documents",
      ]) {
        const schema = toolByName(mode, name).schema as {
          shape?: Record<string, unknown>;
        };
        const keys = Object.keys(schema.shape ?? {});
        expect(keys).not.toContain("tenderId");
        expect(keys).not.toContain("tenantId");
      }
    }
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
