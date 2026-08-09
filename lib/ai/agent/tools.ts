import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { DOC_CLASSES } from "../classification/doc-classes.ts";
import {
  getCompanyDocEmbedStatuses,
  getCompanyFilesCollection,
} from "../company/doc-embedder.ts";
import { getExtractions } from "../extraction/store.ts";
import type { StoredCitedValue } from "../extraction/citations.ts";
import { EXTRACTION_SCHEMA_NAMES } from "../extraction/schema-names.ts";
import { loadFileText } from "../extraction/source-text.ts";
import {
  findTenderFileByName,
  listFetchedTenderFiles,
} from "../../tenders/document-files.ts";
import { buildFullCompanyContext } from "../fit/company-context.ts";
import { companyProfileInput, getFitState } from "../fit/service.ts";
import { getTenderOverview } from "../overview/service.ts";
import {
  hybridRetrieveChunks,
  hybridRetrieveCompanyChunks,
  searchNotices,
} from "../retrieval/hybrid.ts";
import {
  getVisibleTender,
  type AgentRunContext,
  type AgentTenderScope,
} from "./context.ts";

/**
 * Clara's tool registry: narrow, typed, tenant-safe. Every tool closes over the
 * server-built context — TENANT scope is never an input, so a prompt-injected
 * tool call cannot read another company's data. In global mode (ctx.tender is
 * null) tender tools DO take a tenderId input: tender data is a globally
 * shared corpus (stored under tenantId:null), so this crosses no tenant
 * boundary — but every call re-validates visibility via getVisibleTender.
 * Outputs are bounded; document text is wrapped in <document> markers so the
 * system prompt's injection posture applies.
 */

const TEXT_CAP = 1_500;
const SECTION_CAP = 2_500;
const DESCRIPTION_CAP = 2_000;
const PROFILE_CAP = 6_000;
/** Whole-file reads are the fallback when chunk search has no coverage. */
const FILE_READ_CAP = 20_000;

function cap(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function wrapDocument(text: string): string {
  return `<document>${text}</document>`;
}

const TENDER_NOT_FOUND = JSON.stringify({
  tenderNotFound: true,
  hint: "No visible tender with this id. Use find_tenders to locate the tender and its id.",
});

/** Zod shape for tool-supplied tender ids (global mode only). */
const tenderIdInput = z
  .string()
  .length(24)
  .describe("The 24-char tender id, e.g. from find_tenders results.");

// ---------------------------------------------------------------------------
// Shared renderers — one implementation behind both tool modes.
// ---------------------------------------------------------------------------

function renderTenderNotice(scope: AgentTenderScope): string {
  const d = scope.tenderDetail;
  return JSON.stringify({
    tenderId: scope.tenderId.toHexString(),
    title: d.title,
    status: d.status,
    buyer: {
      name: d.buyer?.name ?? null,
      legalType: d.buyer?.legalType ?? null,
      city: d.buyer?.address?.city ?? null,
      country: d.buyer?.address?.countryCode ?? null,
    },
    procedureType: d.procedureType,
    contractNature: d.contractNature,
    cpvCodes: d.cpvCodes,
    regions: d.regions,
    estimatedValue: d.estimatedValue,
    publicationDate: d.publicationDate,
    submissionDeadline: d.submissionDeadline,
    lots: d.lots.slice(0, 10).map((lot) => ({
      title: lot.title,
      deadline: lot.submissionDeadline,
      value: lot.estimatedValue,
    })),
    description: wrapDocument(cap(d.description, DESCRIPTION_CAP)),
  });
}

async function renderOverview(ctx: AgentRunContext, scope: AgentTenderScope): Promise<string> {
  const record = await getTenderOverview(scope.tenderId);
  if (!record) return JSON.stringify({ notGenerated: true });
  const overview = record.overview as Record<string, Record<string, unknown>>;
  const content = overview[ctx.locale] ?? overview.en;
  return JSON.stringify({
    sourceChunkCount: record.sourceChunkCount,
    about: cap(String(content.about ?? ""), SECTION_CAP),
    scope: cap(String(content.scope ?? ""), SECTION_CAP),
    buyer: cap(String(content.buyer ?? ""), SECTION_CAP),
    timeline: cap(String(content.timeline ?? ""), SECTION_CAP),
    requirements: cap(String(content.requirements ?? ""), SECTION_CAP),
    risks: (content.risks as string[] | undefined)?.slice(0, 10) ?? [],
    highlights: (content.highlights as string[] | undefined)?.slice(0, 14) ?? [],
  });
}

async function renderExtractions(
  ctx: AgentRunContext,
  scope: AgentTenderScope,
  schemaName?: (typeof EXTRACTION_SCHEMA_NAMES)[number],
): Promise<string> {
  const records = await getExtractions(scope.tenderId, schemaName);
  if (records.length === 0) {
    return JSON.stringify({
      notExtracted: true,
      hint: "No structured extraction exists yet for this tender.",
    });
  }
  if (!schemaName) {
    return JSON.stringify(
      records.map((record) => ({
        schemaName: record.schemaName,
        status: record.status,
        fieldCount: Object.values(record.fields).filter(
          (field) => (field as StoredCitedValue).value != null,
        ).length,
        unresolvedCount: record.unresolved.length,
      })),
    );
  }
  const record = records[0];
  const fields = Object.entries(record.fields)
    .filter(([, raw]) => (raw as StoredCitedValue).value != null)
    .map(([name, raw]) => {
      const field = raw as StoredCitedValue;
      const citations = field.citations.slice(0, 3).map((citation) => {
        const registered = ctx.citations.add({
          quote: citation.quote,
          fileName: citation.documentRecordId ?? "tender document",
          documentRecordId: citation.documentRecordId,
          chunkId: citation.chunkId,
        });
        return {
          key: registered.key,
          quote: wrapDocument(cap(citation.quote, 300)),
        };
      });
      return {
        name,
        value: field.value,
        confidence: field.confidence,
        citationState: field.citationState,
        citations,
      };
    });
  return JSON.stringify({
    schemaName: record.schemaName,
    status: record.status,
    fields,
    unresolved: record.unresolved,
  });
}

async function renderTenderSearch(
  ctx: AgentRunContext,
  scope: AgentTenderScope,
  input: { query: string; docClass?: (typeof DOC_CLASSES)[number]; k: number },
): Promise<string> {
  const hits = await hybridRetrieveChunks({
    text: input.query,
    mode: "hybrid",
    k: input.k,
    filters: {
      tenantId: null,
      tenderId: scope.tenderId,
      docClass: input.docClass,
    },
  });
  return JSON.stringify(
    hits.map((hit) => {
      const registered = ctx.citations.add({
        quote: hit.text,
        fileName: hit.fileName,
        documentRecordId: hit.documentRecordId,
        chunkId: String(hit.chunkId),
      });
      return {
        citationKey: registered.key,
        fileName: hit.fileName,
        sectionPath: hit.sectionPath,
        legalRefs: hit.legalRefs,
        text: wrapDocument(cap(hit.text, TEXT_CAP)),
      };
    }),
  );
}

async function renderTenderFiles(scope: AgentTenderScope): Promise<string> {
  const files = await listFetchedTenderFiles(scope.tenderId);
  if (files.length === 0) {
    return JSON.stringify({
      noFiles: true,
      hint: "No downloaded document files exist for this tender yet.",
    });
  }
  return JSON.stringify(
    files.slice(0, 40).map((file) => ({
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.byteLength,
      // Readable = extracted text exists and read_tender_document works.
      readable: file.textStatus === "DONE" && file.textChars > 0,
    })),
  );
}

async function renderReadTenderDocument(
  ctx: AgentRunContext,
  scope: AgentTenderScope,
  fileName: string,
): Promise<string> {
  const file = await findTenderFileByName(scope.tenderId, fileName);
  if (!file) {
    return JSON.stringify({
      fileNotFound: true,
      hint: "Call list_tender_files for the exact file names.",
    });
  }
  if (file.textStatus !== "DONE" || file.textChars === 0) {
    return JSON.stringify({
      notReadable: true,
      fileName: file.fileName,
      mimeType: file.mimeType,
    });
  }
  const text = await loadFileText(file);
  const registered = ctx.citations.add({
    quote: text.slice(0, 300),
    fileName: file.fileName,
  });
  return JSON.stringify({
    fileName: file.fileName,
    citationKey: registered.key,
    truncated: text.length > FILE_READ_CAP,
    text: wrapDocument(cap(text, FILE_READ_CAP)),
  });
}

async function renderFit(ctx: AgentRunContext, scope: AgentTenderScope): Promise<string> {
  const state = await getFitState(ctx.companyContext, scope.tenderId);
  if (!state.recommendation) return JSON.stringify({ notGenerated: true });
  return JSON.stringify({
    stale: state.stale,
    generatedAt: state.generatedAt,
    recommendation: state.recommendation,
  });
}

export function buildClaraTools(ctx: AgentRunContext): StructuredToolInterface[] {
  // Resolves the tool's tender scope: the run's own tender in tender mode,
  // or the validated tool input in global mode. Null → answer "not found".
  const scopeFor = async (tenderIdHex?: string): Promise<AgentTenderScope | null> => {
    if (ctx.tender) return ctx.tender;
    if (!tenderIdHex) return null;
    return getVisibleTender(ctx, tenderIdHex);
  };

  const tenderMode = ctx.tender !== null;

  // In global mode every tender tool takes a tenderId; in tender mode none do
  // (scope is closed over, per the original invariant).
  const withTenderId = <S extends z.ZodRawShape>(shape: S) =>
    tenderMode ? z.object(shape) : z.object({ tenderId: tenderIdInput, ...shape });

  const getTenderNotice = tool(
    async (input: { tenderId?: string }) => {
      const scope = await scopeFor(input?.tenderId);
      return scope ? renderTenderNotice(scope) : TENDER_NOT_FOUND;
    },
    {
      name: "get_tender_notice",
      description:
        "The tender notice: title, buyer, procedure, deadlines, CPV codes, lots, value, description. Always cheap — use first for basic facts.",
      schema: withTenderId({}),
    },
  );

  const getOverviewTool = tool(
    async (input: { tenderId?: string }) => {
      const scope = await scopeFor(input?.tenderId);
      return scope ? renderOverview(ctx, scope) : TENDER_NOT_FOUND;
    },
    {
      name: "get_tender_overview",
      description:
        "The AI-generated tender dossier (about, scope, buyer, timeline, requirements, risks, highlights) if it exists. Prefer this over document search for broad questions.",
      schema: withTenderId({}),
    },
  );

  const getExtractionsTool = tool(
    async (input: { tenderId?: string; schemaName?: (typeof EXTRACTION_SCHEMA_NAMES)[number] }) => {
      const scope = await scopeFor(input?.tenderId);
      return scope ? renderExtractions(ctx, scope, input?.schemaName) : TENDER_NOT_FOUND;
    },
    {
      name: "get_extractions",
      description:
        "Citation-verified structured facts extracted from the tender documents. Without schemaName: an index of what exists. With schemaName: the fields with verbatim source quotes. ALWAYS prefer this over document search for deadlines, criteria, proofs, penalties, payment terms.",
      schema: withTenderId({
        schemaName: z.enum(EXTRACTION_SCHEMA_NAMES).optional(),
      }),
    },
  );

  const searchTenderDocuments = tool(
    async (input: {
      tenderId?: string;
      query: string;
      docClass?: (typeof DOC_CLASSES)[number];
      k: number;
    }) => {
      const scope = await scopeFor(input?.tenderId);
      return scope ? renderTenderSearch(ctx, scope, input) : TENDER_NOT_FOUND;
    },
    {
      name: "search_tender_documents",
      description:
        "Full-text + semantic search inside ONE tender's documents. Use for specifics the structured data lacks. German queries work best; legal refs like '§ 13 VOB/B' match exactly.",
      schema: withTenderId({
        query: z.string().min(3).max(300),
        docClass: z.enum(DOC_CLASSES).optional(),
        k: z.number().int().min(1).max(12).default(8),
      }),
    },
  );

  const listTenderFiles = tool(
    async (input: { tenderId?: string }) => {
      const scope = await scopeFor(input?.tenderId);
      return scope ? renderTenderFiles(scope) : TENDER_NOT_FOUND;
    },
    {
      name: "list_tender_files",
      description:
        "List the tender's DOWNLOADED document files (name, type, size, readability). Use when document search returns nothing, or to see what documents exist before reading one.",
      schema: withTenderId({}),
    },
  );

  const readTenderDocument = tool(
    async (input: { tenderId?: string; fileName: string }) => {
      const scope = await scopeFor(input?.tenderId);
      return scope
        ? renderReadTenderDocument(ctx, scope, input.fileName)
        : TENDER_NOT_FOUND;
    },
    {
      name: "read_tender_document",
      description:
        "Read the full extracted text of ONE downloaded tender file by its exact name (from list_tender_files). The fallback when search_tender_documents has no coverage; prefer search for targeted questions.",
      schema: withTenderId({
        fileName: z.string().min(1).max(300),
      }),
    },
  );

  const getCompanyFit = tool(
    async (input: { tenderId?: string }) => {
      const scope = await scopeFor(input?.tenderId);
      return scope ? renderFit(ctx, scope) : TENDER_NOT_FOUND;
    },
    {
      name: "get_company_fit",
      description:
        "The stored assessment of how well a tender fits the user's company (verdict, fit score, strengths, concerns). Read-only; may be marked stale.",
      schema: withTenderId({}),
    },
  );

  const searchCompanyDocuments = tool(
    async ({ query, k }: { query: string; k: number }) => {
      const hits = await hybridRetrieveCompanyChunks({
        text: query,
        k,
        filters: { tenantId: ctx.tenantId },
      });
      return JSON.stringify(
        hits.map((hit) => {
          const registered = ctx.citations.add({
            quote: hit.text,
            fileName: hit.fileName,
            documentRecordId: hit.documentRecordId,
            chunkId: String(hit.chunkId),
          });
          return {
            citationKey: registered.key,
            fileName: hit.fileName,
            text: wrapDocument(cap(hit.text, TEXT_CAP)),
          };
        }),
      );
    },
    {
      name: "search_company_documents",
      description:
        "Search the user's OWN company documents (insurance certificates, references, capability statements). Use when comparing tender requirements against what the company can prove.",
      schema: z.object({
        query: z.string().min(3).max(300),
        k: z.number().int().min(1).max(8).default(6),
      }),
    },
  );

  const getCompanyProfile = tool(
    async () => {
      const brief = buildFullCompanyContext(
        companyProfileInput(ctx.companyContext.company),
      );
      // User-entered profile data is untrusted like any document text.
      return JSON.stringify({ profile: wrapDocument(cap(brief, PROFILE_CAP)) });
    },
    {
      name: "get_company_profile",
      description:
        "The user's structured company profile: identity, capabilities, certifications, financials, insurance, bonding, reference projects. Use for 'does my company…' questions before searching documents.",
      schema: z.object({}),
    },
  );

  const listCompanyDocuments = tool(
    async ({ category }: { category?: string }) => {
      const companyFiles = await getCompanyFilesCollection();
      const files = await companyFiles
        .find({
          companyId: ctx.tenantId,
          category: category ?? { $ne: "logo" },
        })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();
      const statuses = await getCompanyDocEmbedStatuses(
        files.map((file) => String(file._id)),
      );
      return JSON.stringify(
        files.map((file) => ({
          fileName: file.fileName,
          category: file.category,
          contentType: file.contentType,
          size: file.size ?? null,
          uploadedAt: file.createdAt ?? null,
          // "indexed" documents are searchable via search_company_documents.
          embeddingStatus: statuses.get(String(file._id)) ?? "not_indexed",
        })),
      );
    },
    {
      name: "list_company_documents",
      description:
        "List the company's uploaded documents with their search-index status. Use to see WHAT documents exist (and whether they are searchable) before search_company_documents; also answers why a document is not findable.",
      schema: z.object({
        category: z
          .enum(["insurance", "certification", "reference-project", "general"])
          .optional(),
      }),
    },
  );

  const findTenders = tool(
    async ({
      query,
      limit,
      status,
      cpvCodes,
      countryCodes,
      contractNature,
    }: {
      query: string;
      limit: number;
      status?: string;
      cpvCodes?: string[];
      countryCodes?: string[];
      contractNature?: string;
    }) => {
      const hits = await searchNotices({
        text: query,
        limit,
        filters: { status, cpvCodes, countryCodes, contractNature },
      });
      const results = [];
      for (const hit of hits) {
        // Visibility re-check + detail load (memoized per run) — hidden
        // tenders drop out even if their search document lags behind.
        const scope = await getVisibleTender(ctx, hit.tenderId.toHexString());
        if (!scope) continue;
        const d = scope.tenderDetail;
        results.push({
          tenderId: scope.tenderId.toHexString(),
          title: d.title,
          buyer: d.buyer?.name ?? null,
          status: d.status,
          submissionDeadline: d.submissionDeadline,
          cpvCodes: d.cpvCodes.slice(0, 6),
          score: Number(hit.score.toFixed(4)),
        });
      }
      return JSON.stringify(results);
    },
    {
      name: "find_tenders",
      description:
        "Semantic search across ALL published tenders by topic, trade or region wording. Returns tender ids to pass to the other tender tools. Use FIRST whenever the user names or describes a tender that is not already identified.",
      schema: z.object({
        query: z.string().min(3).max(300),
        limit: z.number().int().min(1).max(8).default(5),
        status: z.string().optional(),
        cpvCodes: z.array(z.string()).max(5).optional(),
        countryCodes: z.array(z.string()).max(5).optional(),
        contractNature: z.string().optional(),
      }),
    },
  );

  const companyTools = [searchCompanyDocuments, getCompanyProfile, listCompanyDocuments];
  const tenderTools = [
    getTenderNotice,
    getOverviewTool,
    getExtractionsTool,
    searchTenderDocuments,
    listTenderFiles,
    readTenderDocument,
    getCompanyFit,
  ];

  return tenderMode
    ? [...tenderTools, ...companyTools]
    : [findTenders, ...tenderTools, ...companyTools];
}
