import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import { CitationCollector } from "../agent/citations.ts";
import type { AgentTenderScope } from "../agent/context.ts";
import { TenderRefCollector } from "../agent/tender-refs.ts";
import { UiCallCollector } from "../agent/ui-calls.ts";
import type { DoraRunContext } from "./context.ts";

vi.mock("../retrieval/hybrid.ts", () => ({
  hybridRetrieveChunks: vi.fn(),
  hybridRetrieveCompanyChunks: vi.fn(),
  searchNotices: vi.fn(),
}));
vi.mock("../extraction/store.ts", () => ({
  getExtractions: vi.fn(),
  computeCorpusHash: vi.fn(),
}));
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
vi.mock("../db/collections.ts", () => ({ getAiCollections: vi.fn() }));
vi.mock("./document-text.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./document-text.ts")>()),
  getWorkspaceDocumentText: vi.fn(),
}));
vi.mock("./brief.ts", () => ({ getBriefState: vi.fn() }));

const docText = await import("./document-text.ts");
const { buildDoraTools } = await import("./tools.ts");

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
      description: "x",
      id: "t",
      businessCategory: "TENDER",
      language: "de",
    } as never,
  };
}

function fakeCtx(tender: AgentTenderScope | null = tenderScope()): DoraRunContext {
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
    document: {
      documentId: new ObjectId(),
      fileName: "angebot.docx",
      extension: "docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      documentType: "word",
      state: "ready",
      storageRevision: 3,
      activeEditorKey: "key-1",
      activeUserIds: [],
      version: {
        id: new ObjectId(),
        sha256: "a".repeat(64),
        s3Key: "workspace-documents/x",
        fileName: "angebot.docx",
        extension: "docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        storageRevision: 3,
        reason: "forcesave",
      },
    },
  };
}

// propose_edits (the V1 exact-text engine) is retired from the default
// registry — V2 planner + stream tiers replaced it. DORA_EDIT_ENGINE_V1=true
// is the one-release kill-switch that brings it back.
const DOCUMENT_TOOLS = [
  "get_document_info",
  "get_document_brief",
  "read_current_document",
];
const COMPANY_TOOLS = ["search_company_documents", "get_company_profile"];
const TENDER_TOOLS = [
  "get_tender_context",
  "get_extractions",
  "search_tender_documents",
  "list_tender_files",
  "read_tender_document",
];

describe("buildDoraTools registry", () => {
  it("tender-linked documents get the full document tool registry", () => {
    const names = buildDoraTools(fakeCtx()).map((tool) => tool.name);
    expect(names.sort()).toEqual(
      [...DOCUMENT_TOOLS, ...TENDER_TOOLS, ...COMPANY_TOOLS].sort(),
    );
  });

  it("unlinked documents get no tender tools", () => {
    const names = buildDoraTools(fakeCtx(null)).map((tool) => tool.name);
    expect(names.sort()).toEqual([...DOCUMENT_TOOLS, ...COMPANY_TOOLS].sort());
  });

  it("the V1 kill-switch restores propose_edits", () => {
    process.env.DORA_EDIT_ENGINE_V1 = "true";
    try {
      const names = buildDoraTools(fakeCtx(null)).map((tool) => tool.name);
      expect(names).toContain("propose_edits");
    } finally {
      delete process.env.DORA_EDIT_ENGINE_V1;
    }
  });

  it("no tool takes a tenant, tender or document id input", () => {
    for (const registered of buildDoraTools(fakeCtx())) {
      const shape =
        (registered.schema as { shape?: Record<string, unknown> }).shape ?? {};
      expect(Object.keys(shape)).not.toContain("tenantId");
      expect(Object.keys(shape)).not.toContain("tenderId");
      expect(Object.keys(shape)).not.toContain("documentId");
    }
  });
});

describe("read_current_document", () => {
  it("pages through the text by offset and registers a citation", async () => {
    const ctx = fakeCtx();
    vi.mocked(docText.getWorkspaceDocumentText).mockResolvedValue({
      status: "ready",
      source: "native",
      note: null,
      text: "0123456789".repeat(3000), // 30k chars, > one 20k window
      chars: 30_000,
      truncated: false,
    });
    const tool = buildDoraTools(ctx).find(
      (entry) => entry.name === "read_current_document",
    )!;
    const first = JSON.parse((await tool.invoke({ offset: 0 })) as string);
    expect(first.window).toEqual({ start: 0, end: 20_000 });
    expect(first.nextOffset).toBe(20_000);
    expect(first.citationKey).toBe("c1");
    const second = JSON.parse(
      (await tool.invoke({ offset: first.nextOffset })) as string,
    );
    expect(second.window.end).toBe(30_000);
    expect(second.nextOffset).toBeUndefined();
  });

  it("reports unreadable documents instead of failing", async () => {
    const ctx = fakeCtx();
    vi.mocked(docText.getWorkspaceDocumentText).mockResolvedValue({
      status: "unsupported",
      source: null,
      note: "no_text_layer",
      text: "",
      chars: 0,
      truncated: false,
    });
    const tool = buildDoraTools(ctx).find(
      (entry) => entry.name === "read_current_document",
    )!;
    const result = JSON.parse((await tool.invoke({ offset: 0 })) as string);
    expect(result.notReadable).toBe(true);
    expect(result.note).toBe("no_text_layer");
  });
});

describe("tool progress labels", () => {
  // A tool with no label renders as the generic "Working…" spinner. Both
  // catalogs are checked because the UI resolves the label in the user's
  // own language — same contract as Clara's registry.
  it("every registered tool has a label in both message catalogs", async () => {
    const [en, de] = await Promise.all([
      import("../../../messages/en.json"),
      import("../../../messages/de.json"),
    ]);
    const names = new Set(
      [...buildDoraTools(fakeCtx()), ...buildDoraTools(fakeCtx(null))].map(
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
