import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitationCollector } from "./citations.ts";
import type { AgentRunContext, AgentTenderScope } from "./context.ts";
import { TenderRefCollector } from "./tender-refs.ts";
import { UiCallCollector } from "./ui-calls.ts";

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
vi.mock("../report/service.ts", () => ({
  getReportState: vi.fn(),
  serializeReport: vi.fn(),
  listReportSummaries: vi.fn(),
}));
vi.mock("../verdict/service.ts", () => ({ getVerdictState: vi.fn() }));
vi.mock("./workspace.ts", async (importOriginal) => ({
  // The registry reads the MAX_* clamps at build time, so they must be real.
  ...(await importOriginal<typeof import("./workspace.ts")>()),
  getTenderCoverage: vi.fn(),
  listRelevantTenders: vi.fn(),
  listWorkspaceTenders: vi.fn(),
  loadReportDecisions: vi.fn(),
  lookupCpvCodes: vi.fn(),
}));

const retrieval = await import("../retrieval/hybrid.ts");
const contextModule = await import("./context.ts");
const docEmbedder = await import("../company/doc-embedder.ts");
const reportService = await import("../report/service.ts");
const verdictService = await import("../verdict/service.ts");
const workspace = await import("./workspace.ts");
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
    tenderRefs: new TenderRefCollector(),

    uiCalls: new UiCallCollector(),
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

/** Every tool whose scope is the run's tender (or a validated tender input). */
const TENDER_SCOPED = [
  "find_similar_tenders",
  "get_company_fit",
  "get_extractions",
  "get_tender_analysis_status",
  "get_tender_notice",
  "get_tender_overview",
  "get_tender_report",
  "get_tender_verdict",
  "list_tender_files",
  "read_tender_document",
  "search_tender_documents",
];

describe("buildClaraTools — tender mode", () => {
  it("registers the tender registry (no find_tenders, no tenderId inputs)", () => {
    const names = buildClaraTools(fakeCtx()).map((tool) => tool.name);
    expect(names.sort()).toEqual(
      [
        ...TENDER_SCOPED,
        "compare_tenders",
        "get_company_profile",
        "list_company_documents",
        "list_relevant_tenders",
        "list_tender_reports",
        "list_workspace_tenders",
        "lookup_cpv_codes",
        "search_company_documents",
      ].sort(),
    );
  });

  it("binds every tender-scoped tool to the run's tender — no tenderId input", () => {
    const ctx = fakeCtx();
    for (const name of TENDER_SCOPED) {
      const schema = toolByName(ctx, name).schema as {
        shape?: Record<string, unknown>;
      };
      expect(Object.keys(schema.shape ?? {})).not.toContain("tenderId");
    }
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
    const ctx = fakeCtx(null);
    const names = buildClaraTools(ctx).map((tool) => tool.name);
    expect(names).toContain("find_tenders");
    // Same registry as tender mode, plus find_tenders.
    expect(names).toHaveLength(buildClaraTools(fakeCtx()).length + 1);
    for (const name of TENDER_SCOPED) {
      const schema = toolByName(ctx, name).schema as {
        shape?: Record<string, unknown>;
      };
      expect(Object.keys(schema.shape ?? {})).toContain("tenderId");
    }
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

  it("find_tenders registers its hits as navigation cards", async () => {
    const ctx = fakeCtx(null);
    const visible = tenderScope();
    vi.mocked(retrieval.searchNotices).mockResolvedValue([
      { tenderId: visible.tenderId, score: 0.9 },
    ]);
    vi.mocked(contextModule.getVisibleTender).mockResolvedValue(visible);

    await toolByName(ctx, "find_tenders").invoke({
      query: "Straßenbau Bayern",
      limit: 5,
    });
    expect(ctx.tenderRefs.list()).toEqual([
      expect.objectContaining({
        tenderId: visible.tenderId.toHexString(),
        title: "Testausschreibung",
        status: "OPEN",
      }),
    ]);
  });

  it("list_workspace_tenders cards carry the board column", async () => {
    const ctx = fakeCtx(null);
    vi.mocked(workspace.listWorkspaceTenders).mockResolvedValue([
      {
        tenderId: "a".repeat(24),
        status: "preparing",
        title: "Neubau Kita",
        buyer: "Stadt X",
        tenderStatus: "OPEN",
        submissionDeadline: null,
        daysLeft: 12,
        movedAt: null,
      },
    ]);

    await toolByName(ctx, "list_workspace_tenders").invoke({ limit: 5 });
    expect(ctx.tenderRefs.list()).toEqual([
      expect.objectContaining({
        tenderId: "a".repeat(24),
        workspaceStatus: "preparing",
        daysUntilDeadline: 12,
      }),
    ]);
  });

  it("company tools take no tender or tenant scope inputs in either mode", () => {
    for (const mode of [fakeCtx(), fakeCtx(null)]) {
      for (const name of [
        "search_company_documents",
        "get_company_profile",
        "list_company_documents",
        "list_relevant_tenders",
        "list_workspace_tenders",
        "list_tender_reports",
        "lookup_cpv_codes",
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

describe("buildClaraTools — stored analysis tools", () => {
  it("get_tender_report returns the summary by default and registers cited evidence", async () => {
    const ctx = fakeCtx();
    vi.mocked(reportService.getReportState).mockResolvedValue({
      report: {} as never,
      stale: true,
    });
    vi.mocked(reportService.serializeReport).mockReturnValue({
      locale: "de",
      requestedLocale: null,
      stale: true,
      generatedAt: "2026-08-01T00:00:00.000Z",
      citations: {
        E1: {
          key: "E1",
          quote: "Die Angebotsfrist endet am 01.09.2026.",
          fileName: "Bekanntmachung.pdf",
          documentRecordId: "proc:x#1",
          chunkId: "abc",
        },
      },
      report: {
        executiveSummary: "First paragraph.\n\nSecond paragraph.",
        recommendation: {
          decision: "conditional",
          confidence: 0.62,
          rationale: "Because.",
          conditions: ["Nachweis 124 beschaffen"],
        },
        scores: { eligibilityFit: 0.8 },
        requirements: [
          {
            requirement: "Haftpflicht 5 Mio",
            companyStatus: "gap",
            evidenceIds: ["E1", "UNKNOWN"],
          },
        ],
        risks: [{ severity: "high" }],
      },
    } as never);

    const result = JSON.parse(
      (await toolByName(ctx, "get_tender_report").invoke({})) as string,
    );
    expect(result.section).toBe("summary");
    expect(result.decision).toBe("conditional");
    expect(result.stale).toBe(true);
    expect(result.counts).toMatchObject({ requirementGaps: 1, highRisks: 1 });
    // The summary is a menu — it must name the sections worth asking for.
    expect(result.availableSections).toContain("requirements");
    // Only the opening paragraph of the executive summary rides in the summary.
    expect(result.executiveSummaryOpening).toBe("First paragraph.");

    const requirements = JSON.parse(
      (await toolByName(ctx, "get_tender_report").invoke({
        section: "requirements",
      })) as string,
    );
    // Report-local evidence ids are replaced by this turn's citation keys, and
    // ids with no matching citation simply drop out.
    expect(requirements.requirements[0].citationKeys).toEqual(["c1"]);
    expect(requirements.requirements[0].evidenceIds).toBeUndefined();
    expect(ctx.citations.list()[0].fileName).toBe("Bekanntmachung.pdf");
  });

  it("get_tender_report reports honestly when no report exists", async () => {
    vi.mocked(reportService.getReportState).mockResolvedValue(null);
    const result = JSON.parse(
      (await toolByName(fakeCtx(), "get_tender_report").invoke({})) as string,
    );
    expect(result.notGenerated).toBe(true);
  });

  it("get_tender_verdict registers risk citations and caps the lists", async () => {
    const ctx = fakeCtx();
    vi.mocked(verdictService.getVerdictState).mockResolvedValue({
      stale: false,
      verdict: {
        updatedAt: new Date("2026-08-02"),
        locale: "de",
        recommendation: "bid",
        rationale: "r".repeat(5000),
        scoreBreakdown: { eligibilityFit: 0.9 },
        risks: Array.from({ length: 20 }, (_, index) => ({
          text: `risk ${index}`,
          severity: "medium",
          citations: [
            { key: "x", quote: `q${index}`, fileName: "LV.pdf", chunkId: `c${index}` },
          ],
        })),
        blockingRequirements: [{ text: "Formblatt 124", citations: [] }],
        unresolvedQuestions: ["Wer haftet?"],
      },
    } as never);

    const result = JSON.parse(
      (await toolByName(ctx, "get_tender_verdict").invoke({})) as string,
    );
    expect(result.recommendation).toBe("bid");
    expect(result.rationale.length).toBeLessThanOrEqual(2_500 + 1);
    expect(result.risks).toHaveLength(12);
    expect(result.risks[0].citationKeys).toEqual(["c1"]);
    expect(result.blockingRequirements[0].citationKeys).toEqual([]);
  });

  it("global-mode analysis tools resolve the tender before touching tenant data", async () => {
    const ctx = fakeCtx(null);
    vi.mocked(contextModule.getVisibleTender).mockResolvedValue(null);
    const result = JSON.parse(
      (await toolByName(ctx, "get_tender_report").invoke({
        tenderId: "0".repeat(24),
      })) as string,
    );
    expect(result.tenderNotFound).toBe(true);
    expect(reportService.getReportState).not.toHaveBeenCalled();
  });
});

describe("buildClaraTools — workspace tools", () => {
  it("list_relevant_tenders forwards filters and clamps the page size", async () => {
    const ctx = fakeCtx(null);
    vi.mocked(workspace.listRelevantTenders).mockResolvedValue({
      profile: { cpvCodes: [], nuts: [], country: "DE", nutsSource: "name" },
      total: 0,
      items: [],
    });
    await toolByName(ctx, "list_relevant_tenders").invoke({
      limit: 5,
      sectors: ["45"],
      deadlineInDays: 30,
      sort: "deadline",
    });
    const [passedCtx, filters] = vi.mocked(workspace.listRelevantTenders).mock
      .calls[0];
    expect(passedCtx).toBe(ctx);
    expect(filters).toMatchObject({
      limit: 5,
      sectors: ["45"],
      deadlineInDays: 30,
      sort: "deadline",
    });
    await expect(
      toolByName(ctx, "list_relevant_tenders").invoke({ limit: 99 }),
    ).rejects.toThrow();
    // Sectors are CPV divisions; free text there would silently match nothing.
    await expect(
      toolByName(ctx, "list_relevant_tenders").invoke({
        limit: 5,
        sectors: ["Straßenbau"],
      }),
    ).rejects.toThrow();
  });

  it("list_workspace_tenders only accepts real board statuses", async () => {
    const ctx = fakeCtx();
    vi.mocked(workspace.listWorkspaceTenders).mockResolvedValue([]);
    await toolByName(ctx, "list_workspace_tenders").invoke({
      statuses: ["preparing", "submitted"],
      limit: 20,
    });
    expect(vi.mocked(workspace.listWorkspaceTenders).mock.calls[0][1]).toEqual({
      statuses: ["preparing", "submitted"],
      limit: 20,
    });
    await expect(
      toolByName(ctx, "list_workspace_tenders").invoke({
        statuses: ["archived"],
        limit: 5,
      }),
    ).rejects.toThrow();
  });

  it("list_tender_reports and lookup_cpv_codes inherit the run's locale", async () => {
    const ctx = fakeCtx();
    vi.mocked(reportService.listReportSummaries).mockResolvedValue([]);
    vi.mocked(workspace.lookupCpvCodes).mockResolvedValue([]);

    await toolByName(ctx, "list_tender_reports").invoke({ limit: 4 });
    expect(reportService.listReportSummaries).toHaveBeenCalledWith(
      ctx.companyContext,
      "de",
      4,
    );

    await toolByName(ctx, "lookup_cpv_codes").invoke({
      codes: ["45233120-6"],
      limit: 5,
    });
    expect(workspace.lookupCpvCodes).toHaveBeenCalledWith({
      codes: ["45233120-6"],
      query: undefined,
      locale: "de",
      limit: 5,
    });
  });

  it("compare_tenders drops ids that fail the visibility check", async () => {
    const ctx = fakeCtx(null);
    const visible = tenderScope();
    vi.mocked(contextModule.getVisibleTender).mockImplementation(
      async (_ctx, hex) => (hex === visible.tenderId.toHexString() ? visible : null),
    );
    vi.mocked(workspace.loadReportDecisions).mockResolvedValue(new Map());
    vi.mocked(workspace.getTenderCoverage).mockResolvedValue({
      workspaceStatus: "preparing",
      verdict: { recommendation: "bid" },
      documents: { fetchedFiles: 3, indexedChunks: 40 },
      overview: { exists: true },
      report: { exists: false },
    } as never);

    const hiddenId = "0".repeat(24);
    const result = JSON.parse(
      (await toolByName(ctx, "compare_tenders").invoke({
        tenderIds: [visible.tenderId.toHexString(), hiddenId],
      })) as string,
    );
    expect(result.tenders).toHaveLength(1);
    expect(result.notFound).toEqual([hiddenId]);
    expect(result.tenders[0].workspaceStatus).toBe("preparing");
    // Fewer than two ids is a comparison of nothing.
    await expect(
      toolByName(ctx, "compare_tenders").invoke({ tenderIds: [hiddenId] }),
    ).rejects.toThrow();
  });

  it("find_similar_tenders excludes the tender itself", async () => {
    const ctx = fakeCtx();
    const other = tenderScope();
    vi.mocked(retrieval.searchNotices).mockResolvedValue([
      { tenderId: ctx.tender!.tenderId, score: 1 },
      { tenderId: other.tenderId, score: 0.8 },
    ]);
    vi.mocked(contextModule.getVisibleTender).mockResolvedValue(other);

    const result = JSON.parse(
      (await toolByName(ctx, "find_similar_tenders").invoke({ limit: 3 })) as string,
    );
    expect(result).toHaveLength(1);
    expect(result[0].tenderId).toBe(other.tenderId.toHexString());
    // One extra candidate is requested to absorb the self-match.
    expect(vi.mocked(retrieval.searchNotices).mock.calls[0][0].limit).toBe(4);
    // The similar tender is worth a card; the tender under discussion is not.
    expect(ctx.tenderRefs.list().map((ref) => ref.tenderId)).toEqual([
      other.tenderId.toHexString(),
    ]);
  });

  it("never cards the tender a tender chat is already about", async () => {
    const ctx = fakeCtx();
    const self = ctx.tender!.tenderId.toHexString();
    const other = tenderScope();
    vi.mocked(contextModule.getVisibleTender).mockImplementation(
      async (_ctx, hex) => (hex === self ? ctx.tender : other),
    );
    vi.mocked(workspace.loadReportDecisions).mockResolvedValue(new Map());
    vi.mocked(workspace.getTenderCoverage).mockResolvedValue({
      workspaceStatus: null,
      verdict: { recommendation: null },
      documents: { fetchedFiles: 0, indexedChunks: 0 },
      overview: { exists: false },
      report: { exists: false },
    } as never);

    await toolByName(ctx, "compare_tenders").invoke({
      tenderIds: [self, other.tenderId.toHexString()],
    });
    expect(ctx.tenderRefs.list().map((ref) => ref.tenderId)).toEqual([
      other.tenderId.toHexString(),
    ]);
  });
});

describe("tool progress labels", () => {
  // A tool with no label renders as the generic "Working…" spinner, which
  // makes the most interesting part of a turn invisible. Both catalogs are
  // checked because the UI resolves the label in the user's own language.
  it("every registered tool has a label in both message catalogs", async () => {
    const [en, de] = await Promise.all([
      import("../../../messages/en.json"),
      import("../../../messages/de.json"),
    ]);
    const names = new Set(
      [...buildClaraTools(fakeCtx()), ...buildClaraTools(fakeCtx(null))].map(
        (tool) => tool.name,
      ),
    );
    for (const catalog of [en.default, de.default]) {
      const labels = (catalog as { Chat: { tool: Record<string, unknown> } }).Chat
        .tool;
      expect([...names].filter((name) => labels[name] == null)).toEqual([]);
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
