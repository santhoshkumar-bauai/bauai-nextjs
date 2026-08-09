import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitationCollector } from "./citations.ts";
import type { AgentRunContext } from "./context.ts";
import { TenderRefCollector } from "./tender-refs.ts";

vi.mock("../../ingestion/db/client.ts", () => ({ getIngestionDb: vi.fn() }));
vi.mock("../../tenders/document-files.ts", () => ({
  listFetchedTenderFiles: vi.fn(),
}));
vi.mock("../db/collections.ts", () => ({ getAiCollections: vi.fn() }));
vi.mock("../extraction/store.ts", () => ({
  getExtractions: vi.fn(),
  computeCorpusHash: vi.fn(),
}));
vi.mock("../fit/company-hash.ts", () => ({
  hashCompanyData: vi.fn(() => "COMPANY_HASH"),
  listEmbeddedCompanyDocs: vi.fn(async () => []),
}));
vi.mock("../fit/service.ts", () => ({
  getFitState: vi.fn(),
  companyProfileInput: vi.fn(() => ({})),
}));

const dbClient = await import("../../ingestion/db/client.ts");
const docFiles = await import("../../tenders/document-files.ts");
const collections = await import("../db/collections.ts");
const store = await import("../extraction/store.ts");
const fit = await import("../fit/service.ts");
const {
  getTenderCoverage,
  listRelevantTenders,
  listWorkspaceTenders,
  lookupCpvCodes,
} = await import("./workspace.ts");

const TENANT = new ObjectId();

function ctxOf(company: Record<string, unknown> = {}): AgentRunContext {
  return {
    tenantId: TENANT,
    userId: "u",
    locale: "de",
    companyContext: { company } as never,
    citations: new CitationCollector(),
    tenderRefs: new TenderRefCollector(),
    tender: null,
    tenderCache: new Map(),
  };
}

/**
 * A minimal native-driver stand-in. `handlers` maps collection name to the
 * cursor/aggregate results that collection should answer with, so each test
 * declares only the reads it cares about.
 */
function fakeDb(handlers: Record<string, { find?: unknown[]; aggregate?: unknown[] }>) {
  const calls: Record<string, { filter?: unknown; pipeline?: unknown }[]> = {};
  const db = {
    collection(name: string) {
      calls[name] ??= [];
      const rows = handlers[name] ?? {};
      return {
        find(filter?: unknown) {
          calls[name].push({ filter });
          const cursor = {
            sort: () => cursor,
            limit: () => cursor,
            toArray: async () => rows.find ?? [],
          };
          return cursor;
        },
        aggregate(pipeline?: unknown) {
          calls[name].push({ pipeline });
          return { toArray: async () => rows.aggregate ?? [] };
        },
      };
    },
  };
  vi.mocked(dbClient.getIngestionDb).mockResolvedValue(db as never);
  return calls;
}

beforeEach(() => {
  vi.mocked(dbClient.getIngestionDb).mockReset();
  vi.mocked(docFiles.listFetchedTenderFiles).mockReset();
});

describe("listRelevantTenders", () => {
  it("excludes dead-zoned tenders and annotates the rest with their board status", async () => {
    const kept = new ObjectId();
    const rejected = new ObjectId();
    const calls = fakeDb({
      tender_decisions: {
        find: [
          { tenderId: kept.toHexString(), status: "preparing", updatedAt: new Date() },
          { tenderId: rejected.toHexString(), status: "deadzone", updatedAt: new Date() },
        ],
      },
      tenders: {
        aggregate: [
          {
            items: [
              {
                _id: kept,
                title: "Neubau Kita",
                buyer: { name: "Stadt X", address: { city: "Kiel" } },
                cpvCodes: ["45000000"],
                regions: ["DEF0"],
                status: "OPEN",
                submissionDeadline: new Date("2026-09-01"),
                publicationDate: new Date("2026-07-01"),
                estimatedValueAmount: "120000",
                estimatedValueCurrency: "EUR",
                score: 0.7123,
                cpvScore: 0.6,
                geoScore: 0.4,
                timeScore: 0.9,
              },
            ],
            total: [{ value: 1 }],
          },
        ],
      },
    });

    const result = await listRelevantTenders(
      ctxOf({ cpvCodes: ["45000000-7"], region: "Kiel" }),
      { limit: 5 },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].tenderId).toBe(kept.toHexString());
    expect(result.items[0].workspaceStatus).toBe("preparing");
    expect(result.items[0].matchScore).toBe(0.712);
    expect(result.items[0].daysLeft).toBeTypeOf("number");
    expect(result.profile.cpvCodes).toEqual(["45000000-7"]);

    // The rejected tender is excluded by the pipeline, not filtered afterwards.
    const pipeline = calls.tenders[0].pipeline as Array<{
      $match?: { _id?: { $nin?: ObjectId[] } };
    }>;
    const nin = pipeline[0].$match?._id?.$nin;
    expect(nin?.map(String)).toEqual([rejected.toHexString()]);
  });

  it("clamps the requested page size to the feed cap", async () => {
    const calls = fakeDb({
      tender_decisions: { find: [] },
      tenders: { aggregate: [{ items: [], total: [] }] },
    });
    await listRelevantTenders(ctxOf(), { limit: 500 });
    const pipeline = calls.tenders[0].pipeline as Array<Record<string, unknown>>;
    const facet = pipeline.at(-1) as { $facet: { items: Array<{ $limit?: number }> } };
    expect(facet.$facet.items.find((stage) => stage.$limit)?.$limit).toBe(15);
  });
});

describe("listWorkspaceTenders", () => {
  it("hides the dead zone by default and orders by soonest deadline", async () => {
    const soon = new ObjectId();
    const later = new ObjectId();
    const undated = new ObjectId();
    const dropped = new ObjectId();
    fakeDb({
      tender_decisions: {
        find: [
          { tenderId: later.toHexString(), status: "preparing" },
          { tenderId: soon.toHexString(), status: "submitted" },
          { tenderId: undated.toHexString(), status: "interested" },
          { tenderId: dropped.toHexString(), status: "deadzone" },
        ],
      },
      tenders: {
        find: [
          { _id: later, title: "Later", submissionDeadline: new Date(Date.now() + 40 * 864e5) },
          { _id: soon, title: "Soon", submissionDeadline: new Date(Date.now() + 3 * 864e5) },
          { _id: undated, title: "Undated", submissionDeadline: null },
        ],
      },
    });

    const rows = await listWorkspaceTenders(ctxOf(), { limit: 20 });
    expect(rows.map((row) => row.title)).toEqual(["Soon", "Later", "Undated"]);
    expect(rows.map((row) => row.tenderId)).not.toContain(dropped.toHexString());
  });

  it("returns the dead zone when it is explicitly asked for", async () => {
    const dropped = new ObjectId();
    fakeDb({
      tender_decisions: {
        find: [{ tenderId: dropped.toHexString(), status: "deadzone" }],
      },
      tenders: { find: [{ _id: dropped, title: "Rejected" }] },
    });
    const rows = await listWorkspaceTenders(ctxOf(), {
      statuses: ["deadzone"],
      limit: 5,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("deadzone");
  });
});

describe("lookupCpvCodes", () => {
  it("matches codes on their 8-digit stem, so the check digit is optional", async () => {
    const calls = fakeDb({
      cpvcodes: {
        find: [
          {
            code: "45233120-6",
            name: { en: "Road construction works", de: "Straßenbauarbeiten" },
            division: "45",
          },
        ],
      },
    });
    const rows = await lookupCpvCodes({
      codes: ["45233120-6", "45000000"],
      locale: "de",
      limit: 5,
    });
    expect(rows[0].name).toBe("Straßenbauarbeiten");
    expect(calls.cpvcodes[0].filter).toEqual({
      $or: [
        { code: { $regex: "^45233120" } },
        { code: { $regex: "^45000000" } },
      ],
    });
  });

  it("escapes free-text queries before building the catalog regex", async () => {
    const calls = fakeDb({ cpvcodes: { find: [] } });
    await lookupCpvCodes({ query: "Bau (Tief.*)", locale: "en", limit: 5 });
    const filter = calls.cpvcodes[0].filter as { $or: Array<{ code?: RegExp }> };
    expect(filter.$or[0].code?.source).toBe("Bau \\(Tief\\.\\*\\)");
  });

  it("returns nothing rather than scanning the catalog when given no criteria", async () => {
    fakeDb({ cpvcodes: { find: [] } });
    expect(await lookupCpvCodes({ locale: "en", limit: 5 })).toEqual([]);
    expect(dbClient.getIngestionDb).not.toHaveBeenCalled();
  });
});

describe("getTenderCoverage", () => {
  const tenderId = new ObjectId();

  function setup(overrides: {
    verdict?: unknown;
    report?: unknown;
    overview?: unknown;
    chunkCount?: number;
    files?: unknown[];
  }) {
    fakeDb({ tender_decisions: { find: [] } });
    vi.mocked(docFiles.listFetchedTenderFiles).mockResolvedValue(
      (overrides.files ?? []) as never,
    );
    vi.mocked(store.getExtractions).mockResolvedValue([
      {
        schemaName: "deadlines",
        status: "VERIFIED",
        fields: { a: { value: 1 }, b: { value: null } },
        unresolved: [],
      },
    ] as never);
    vi.mocked(store.computeCorpusHash).mockResolvedValue("CORPUS_HASH");
    vi.mocked(fit.getFitState).mockResolvedValue({
      recommendation: null,
      stale: false,
      generatedAt: null,
    });
    vi.mocked(collections.getAiCollections).mockResolvedValue({
      chunks: { countDocuments: async () => overrides.chunkCount ?? 0 },
      tenderOverviews: { findOne: async () => overrides.overview ?? null },
      tenderVerdicts: { findOne: async () => overrides.verdict ?? null },
      tenderReports: { findOne: async () => overrides.report ?? null },
    } as never);
  }

  it("flags a stored report as stale when the corpus hash moved on", async () => {
    setup({
      report: {
        tenderId,
        primaryLocale: "en",
        report: { en: { recommendation: { decision: "no_bid" } } },
        inputs: { corpusHash: "OLD", companyDataHash: "COMPANY_HASH" },
        model: { promptVersion: "rep-p1" },
        generatedAt: new Date("2026-07-01"),
      },
      chunkCount: 120,
    });

    const coverage = await getTenderCoverage(ctxOf(), tenderId);
    expect(coverage.report.exists).toBe(true);
    expect(coverage.report.stale).toBe(true);
    expect(coverage.report.decision).toBe("no_bid");
    // German was requested but never generated — the English analysis answers.
    expect(coverage.report.locales).toEqual(["en"]);
    expect(coverage.extractions[0]).toMatchObject({
      schemaName: "deadlines",
      filledFields: 1,
    });
  });

  it("suggests the cheapest authoritative tool first", async () => {
    setup({
      report: {
        tenderId,
        primaryLocale: "de",
        report: { de: { recommendation: { decision: "bid" } } },
        inputs: { corpusHash: "CORPUS_HASH", companyDataHash: "COMPANY_HASH" },
        model: { promptVersion: "rep-p1" },
        generatedAt: new Date(),
      },
      overview: { sourceChunkCount: 12 },
      chunkCount: 40,
    });
    const coverage = await getTenderCoverage(ctxOf(), tenderId);
    expect(coverage.report.stale).toBe(false);
    expect(coverage.suggestedTools[0]).toBe("get_tender_report");
    expect(coverage.suggestedTools).toContain("search_tender_documents");
  });

  it("falls back to reading files when nothing is indexed, and to the notice when nothing exists", async () => {
    setup({
      files: [
        { fileName: "LV.pdf", textStatus: "DONE", textChars: 900 },
        { fileName: "Plan.dwg", textStatus: "PENDING", textChars: 0 },
      ],
      chunkCount: 0,
    });
    vi.mocked(store.getExtractions).mockResolvedValue([]);
    const coverage = await getTenderCoverage(ctxOf(), tenderId);
    expect(coverage.documents).toMatchObject({
      fetchedFiles: 2,
      readableFiles: 1,
      indexedChunks: 0,
    });
    expect(coverage.suggestedTools).toEqual(["read_tender_document"]);

    setup({ chunkCount: 0 });
    vi.mocked(store.getExtractions).mockResolvedValue([]);
    const bare = await getTenderCoverage(ctxOf(), tenderId);
    expect(bare.suggestedTools).toEqual(["get_tender_notice"]);
  });
});
