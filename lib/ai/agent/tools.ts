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
import { deadlineDaysLeft } from "../../tenders/deadline.ts";
import {
  findTenderFileByName,
  listFetchedTenderFiles,
} from "../../tenders/document-files.ts";
import { DECISION_STATUSES } from "../../tenders/pipeline-status.ts";
import { buildFullCompanyContext } from "../fit/company-context.ts";
import { companyProfileInput, getFitState } from "../fit/service.ts";
import { getTenderOverview } from "../overview/service.ts";
import { getReportState, listReportSummaries, serializeReport } from "../report/service.ts";
import {
  hybridRetrieveChunks,
  hybridRetrieveCompanyChunks,
  searchNotices,
} from "../retrieval/hybrid.ts";
import { getVerdictState } from "../verdict/service.ts";
import type { ChatCitation } from "./citations.ts";
import {
  getVisibleTender,
  type AgentRunContext,
  type AgentTenderScope,
  type TenderAgentRunContext,
} from "./context.ts";
import {
  projectReportSection,
  REPORT_SECTIONS,
  type ReportSection,
} from "./report-view.ts";
import type { TenderRefInput } from "./tender-refs.ts";
import {
  getTenderCoverage,
  listRelevantTenders,
  listWorkspaceTenders,
  loadReportDecisions,
  lookupCpvCodes,
  MAX_CPV_ROWS,
  MAX_FEED_ITEMS,
  MAX_WORKSPACE_ITEMS,
} from "./workspace.ts";

/**
 * Clara's tool registry: narrow, typed, tenant-safe. Every tool closes over the
 * server-built context — TENANT scope is never an input, so a prompt-injected
 * tool call cannot read another company's data. In global mode (ctx.tender is
 * null) tender tools DO take a tenderId input: tender data is a globally
 * shared corpus (stored under tenantId:null), so this crosses no tenant
 * boundary — but every call re-validates visibility via getVisibleTender.
 * The two CROSS-tender tools (find_similar_tenders, compare_tenders) take ids
 * in BOTH modes for the same reason, and validate them the same way.
 * Outputs are bounded; document text is wrapped in <document> markers so the
 * system prompt's injection posture applies.
 *
 * The registry is deliberately layered so the model can spend one cheap call
 * instead of several speculative ones: coverage (what exists) → stored
 * analysis (report/verdict/fit) → structured facts (extractions) → retrieval →
 * whole files. `get_tender_analysis_status` returns that routing explicitly.
 */

const TEXT_CAP = 1_500;
const SECTION_CAP = 2_500;
const DESCRIPTION_CAP = 2_000;
const PROFILE_CAP = 6_000;
/** Whole-file reads are the fallback when chunk search has no coverage. */
const FILE_READ_CAP = 20_000;

export function cap(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function wrapDocument(text: string): string {
  return `<document>${text}</document>`;
}

/**
 * Registers a tender for the answer's navigation cards (tender-refs.ts). The
 * tender a tender chat is already bound to is skipped — the reader is looking
 * at its page, so a card back to it is noise.
 */
function noteTender(ctx: AgentRunContext, ref: TenderRefInput): void {
  if (ctx.tender?.tenderId.toHexString() === ref.tenderId) return;
  ctx.tenderRefs.add(ref);
}

/** The notice-level facts every card needs, from an already-loaded scope. */
function noteTenderScope(ctx: AgentRunContext, scope: AgentTenderScope): void {
  const d = scope.tenderDetail;
  noteTender(ctx, {
    tenderId: scope.tenderId.toHexString(),
    title: d.title,
    buyer: d.buyer?.name ?? null,
    status: d.status,
    submissionDeadline: d.submissionDeadline,
    daysUntilDeadline: d.submissionDeadline
      ? deadlineDaysLeft(d.submissionDeadline)
      : null,
  });
}

/** Report/verdict decisions arrive as loose strings; only these are cards. */
const CARD_DECISIONS = ["bid", "no_bid", "conditional"] as const;

function asDecision(value: string | null | undefined): TenderRefInput["decision"] {
  return CARD_DECISIONS.find((decision) => decision === value) ?? null;
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
// Shared renderers — one implementation behind both tool modes. The tender
// renderers are exported for reuse by Dora's tool registry (lib/ai/dora),
// which resolves the same AgentTenderScope from its document's linked tender.
// ---------------------------------------------------------------------------

export function renderTenderNotice(scope: AgentTenderScope): string {
  const d = scope.tenderDetail;
  return JSON.stringify({
    tenderId: scope.tenderId.toHexString(),
    title: d.title,
    status: d.status,
    // Computed here so the model never has to do date arithmetic — it gets
    // that wrong, and "how long do we have" is the most asked question.
    daysUntilDeadline: d.submissionDeadline
      ? deadlineDaysLeft(d.submissionDeadline)
      : null,
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

export async function renderOverview(ctx: AgentRunContext, scope: AgentTenderScope): Promise<string> {
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

export async function renderExtractions(
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

export async function renderTenderSearch(
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

export async function renderTenderFiles(scope: AgentTenderScope): Promise<string> {
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

export async function renderReadTenderDocument(
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

/**
 * Rewrites the report's internal evidence ids into this turn's citation keys,
 * registering each referenced quote on the way. Without this the report's
 * claims would arrive uncited — the one thing §6 forbids — because the stored
 * evidence ids are report-local and mean nothing outside that document.
 */
function attachReportCitations(
  ctx: AgentRunContext,
  value: unknown,
  citations: Record<string, ChatCitation>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) attachReportCitations(ctx, entry, citations);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === "evidenceIds") {
      const keys = (Array.isArray(child) ? child : [])
        .flatMap((id) => (typeof id === "string" ? [citations[id]] : []))
        .filter((citation): citation is ChatCitation => citation != null)
        .map(
          (citation) =>
            ctx.citations.add({
              quote: citation.quote,
              fileName: citation.fileName,
              documentRecordId: citation.documentRecordId,
              chunkId: citation.chunkId,
            }).key,
        );
      delete record[key];
      if (keys.length > 0) record.citationKeys = keys;
      continue;
    }
    attachReportCitations(ctx, child, citations);
  }
}

async function renderReport(
  ctx: AgentRunContext,
  scope: AgentTenderScope,
  section: ReportSection,
): Promise<string> {
  const state = await getReportState(ctx.companyContext, scope.tenderId);
  const serialized = state
    ? serializeReport(state.report, state.stale, ctx.locale)
    : null;
  if (!serialized) {
    return JSON.stringify({
      notGenerated: true,
      hint: "No full report exists for this tender yet. The user generates it from the tender's report page. Use get_extractions, get_tender_overview and get_company_fit instead.",
    });
  }

  // Cloned because the projection shares object references with the loaded
  // report document and the citation rewrite mutates in place.
  const projected = structuredClone(
    projectReportSection(serialized.report, section),
  );
  attachReportCitations(ctx, projected, serialized.citations ?? {});
  return JSON.stringify({
    section,
    stale: serialized.stale,
    locale: serialized.locale,
    // Set when the requested language was never generated — the reader must
    // know they are being answered from another language's analysis.
    fallbackFromLocale: serialized.requestedLocale,
    generatedAt: serialized.generatedAt,
    ...projected,
  });
}

async function renderVerdict(
  ctx: AgentRunContext,
  scope: AgentTenderScope,
): Promise<string> {
  // getVerdictState is typed for tender-bound runs; in global mode the scope
  // comes from the validated tool input instead of the run.
  const state = await getVerdictState({
    ...ctx,
    tender: scope,
  } as TenderAgentRunContext);
  if (!state) {
    return JSON.stringify({
      notGenerated: true,
      hint: "No verdict exists for this tender yet. Use get_tender_report, get_company_fit or get_extractions.",
    });
  }

  const { verdict } = state;
  const withCitations = <T extends { citations: Array<Record<string, unknown>> }>(
    entry: T,
  ): string[] =>
    entry.citations
      .map((raw) => raw as unknown as ChatCitation)
      .filter((citation) => citation?.quote)
      .map(
        (citation) =>
          ctx.citations.add({
            quote: citation.quote,
            fileName: citation.fileName,
            documentRecordId: citation.documentRecordId,
            chunkId: citation.chunkId,
          }).key,
      );

  return JSON.stringify({
    stale: state.stale,
    generatedAt: verdict.updatedAt,
    locale: verdict.locale,
    recommendation: verdict.recommendation,
    rationale: cap(verdict.rationale, SECTION_CAP),
    scoreBreakdown: verdict.scoreBreakdown,
    risks: verdict.risks.slice(0, 12).map((risk) => ({
      text: risk.text,
      severity: risk.severity,
      citationKeys: withCitations(risk),
      uncited: risk.uncited === true,
    })),
    blockingRequirements: verdict.blockingRequirements
      .slice(0, 12)
      .map((requirement) => ({
        text: requirement.text,
        citationKeys: withCitations(requirement),
      })),
    unresolvedQuestions: verdict.unresolvedQuestions.slice(0, 10),
  });
}

async function renderSimilarTenders(
  ctx: AgentRunContext,
  scope: AgentTenderScope,
  limit: number,
): Promise<string> {
  const d = scope.tenderDetail;
  // The notice's own wording IS the query — same text the notice embedding was
  // built from, so this lands in the right neighbourhood of the vector space.
  const text = [d.title, d.description?.slice(0, 1_000)]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text.length < 3) {
    return JSON.stringify({
      noQueryText: true,
      hint: "This tender has no title or description to search similar tenders with.",
    });
  }

  const self = scope.tenderId.toHexString();
  // One extra hit covers the tender matching itself, which it always does.
  const hits = await searchNotices({ text, limit: limit + 1 });
  const results = [];
  for (const hit of hits) {
    const hex = hit.tenderId.toHexString();
    if (hex === self) continue;
    const candidate = await getVisibleTender(ctx, hex);
    if (!candidate) continue;
    noteTenderScope(ctx, candidate);
    const detail = candidate.tenderDetail;
    results.push({
      tenderId: hex,
      title: detail.title,
      buyer: detail.buyer?.name ?? null,
      status: detail.status,
      submissionDeadline: detail.submissionDeadline,
      daysUntilDeadline: detail.submissionDeadline
        ? deadlineDaysLeft(detail.submissionDeadline)
        : null,
      cpvCodes: detail.cpvCodes.slice(0, 6),
      similarity: Number(hit.score.toFixed(4)),
    });
    if (results.length >= limit) break;
  }
  return JSON.stringify(results);
}

async function renderCompareTenders(
  ctx: AgentRunContext,
  tenderIds: string[],
): Promise<string> {
  const scopes: AgentTenderScope[] = [];
  const notFound: string[] = [];
  for (const hex of [...new Set(tenderIds)]) {
    const scope = await getVisibleTender(ctx, hex);
    if (scope) scopes.push(scope);
    else notFound.push(hex);
  }
  if (scopes.length === 0) {
    return JSON.stringify({ tenderNotFound: true, notFound });
  }

  const [reportDecisions, coverages] = await Promise.all([
    loadReportDecisions(
      ctx,
      scopes.map((scope) => scope.tenderId),
    ),
    // Workspace status per tender comes from the coverage map, which is one
    // decisions read shared across the row set.
    Promise.all(scopes.map((scope) => getTenderCoverage(ctx, scope.tenderId))),
  ]);

  return JSON.stringify({
    ...(notFound.length > 0 ? { notFound } : {}),
    tenders: scopes.map((scope, index) => {
      const d = scope.tenderDetail;
      const hex = scope.tenderId.toHexString();
      const coverage = coverages[index];
      noteTenderScope(ctx, scope);
      noteTender(ctx, {
        tenderId: hex,
        workspaceStatus: coverage.workspaceStatus,
        decision:
          asDecision(reportDecisions.get(hex)?.decision) ??
          asDecision(coverage.verdict.recommendation),
        hasReport: coverage.report.exists,
      });
      return {
        tenderId: hex,
        title: d.title,
        buyer: d.buyer?.name ?? null,
        city: d.buyer?.address?.city ?? null,
        status: d.status,
        procedureType: d.procedureType,
        contractNature: d.contractNature,
        cpvCodes: d.cpvCodes.slice(0, 6),
        regions: d.regions.slice(0, 4),
        estimatedValue: d.estimatedValue,
        submissionDeadline: d.submissionDeadline,
        daysUntilDeadline: d.submissionDeadline
          ? deadlineDaysLeft(d.submissionDeadline)
          : null,
        lotCount: d.lots.length,
        workspaceStatus: coverage.workspaceStatus,
        reportDecision: reportDecisions.get(hex) ?? null,
        verdictRecommendation: coverage.verdict.recommendation,
        analysisDepth: {
          documents: coverage.documents.fetchedFiles,
          indexedChunks: coverage.documents.indexedChunks,
          hasOverview: coverage.overview.exists,
          hasReport: coverage.report.exists,
        },
      };
    }),
  });
}

export function buildClaraTools(ctx: AgentRunContext): StructuredToolInterface[] {
  // Resolves the tool's tender scope: the run's own tender in tender mode,
  // or the validated tool input in global mode. Null → answer "not found".
  const scopeFor = async (tenderIdHex?: string): Promise<AgentTenderScope | null> => {
    if (ctx.tender) return ctx.tender;
    if (!tenderIdHex) return null;
    const scope = await getVisibleTender(ctx, tenderIdHex);
    // Every global-mode tool that drills into a tender routes through here, so
    // one registration covers notice, report, verdict, documents and the rest.
    if (scope) noteTenderScope(ctx, scope);
    return scope;
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

  const getTenderReport = tool(
    async (input: { tenderId?: string; section?: ReportSection }) => {
      const scope = await scopeFor(input?.tenderId);
      return scope
        ? renderReport(ctx, scope, input?.section ?? "summary")
        : TENDER_NOT_FOUND;
    },
    {
      name: "get_tender_report",
      description:
        "The full BID/NO-BID report for this tender and this company — the deepest analysis the system produces (decision, scores, requirements assessed against the company, risks, commercials, bid strategy, action plan). Returns a compact summary by default; pass a section to read one part in full. ALWAYS check this FIRST for any bid/no-bid, requirement-gap, risk or strategy question — it already answers most of them.",
      schema: withTenderId({
        section: z
          .enum(REPORT_SECTIONS)
          .optional()
          .describe(
            "Which part to read in full. Omit for the summary, which lists the sections that actually exist.",
          ),
      }),
    },
  );

  const getTenderVerdict = tool(
    async (input: { tenderId?: string }) => {
      const scope = await scopeFor(input?.tenderId);
      return scope ? renderVerdict(ctx, scope) : TENDER_NOT_FOUND;
    },
    {
      name: "get_tender_verdict",
      description:
        "The stored short verdict for this tender: bid / conditional / no_bid with a score breakdown, cited risks, blocking requirements and open questions. Cheaper and shorter than get_tender_report — use it when the user wants the call, not the full analysis.",
      schema: withTenderId({}),
    },
  );

  const getTenderAnalysisStatus = tool(
    async (input: { tenderId?: string }) => {
      const scope = await scopeFor(input?.tenderId);
      if (!scope) return TENDER_NOT_FOUND;
      const coverage = await getTenderCoverage(ctx, scope.tenderId);
      noteTender(ctx, {
        tenderId: coverage.tenderId,
        workspaceStatus: coverage.workspaceStatus,
        decision:
          asDecision(coverage.report.decision) ??
          asDecision(coverage.verdict.recommendation),
        hasReport: coverage.report.exists,
      });
      return JSON.stringify(coverage);
    },
    {
      name: "get_tender_analysis_status",
      description:
        "What the system already knows about this tender: how many documents were downloaded and indexed, which extractions/overview/fit/verdict/report exist and whether they are stale, where the tender sits on the company board, plus a suggestedTools list. Call this FIRST when unsure which tool will pay off, or to explain honestly why an answer is not available.",
      schema: withTenderId({}),
    },
  );

  const findSimilarTenders = tool(
    async (input: { tenderId?: string; limit: number }) => {
      const scope = await scopeFor(input?.tenderId);
      return scope
        ? renderSimilarTenders(ctx, scope, input.limit)
        : TENDER_NOT_FOUND;
    },
    {
      name: "find_similar_tenders",
      description:
        "Other published tenders whose notices resemble this one, by semantic similarity of title and description. Use for 'are there comparable jobs', competitor/benchmark and 'what else could we bid on instead' questions.",
      schema: withTenderId({
        limit: z.number().int().min(1).max(8).default(5),
      }),
    },
  );

  const compareTenders = tool(
    async ({ tenderIds }: { tenderIds: string[] }) =>
      renderCompareTenders(ctx, tenderIds),
    {
      name: "compare_tenders",
      description:
        "Side-by-side facts for 2-5 tenders in ONE call: deadlines and days left, buyer, value, procedure, CPV, board status, and any stored report/verdict decision. Use instead of calling get_tender_notice repeatedly when the user is choosing between tenders.",
      schema: z.object({
        tenderIds: z
          .array(z.string().length(24))
          .min(2)
          .max(5)
          .describe("Tender ids from find_tenders, list_relevant_tenders or the board."),
      }),
    },
  );

  const listRelevantTendersTool = tool(
    async (input: {
      limit: number;
      query?: string;
      sectors?: string[];
      regions?: string[];
      contractNatures?: string[];
      deadlineInDays?: number;
      minScore?: number;
      sort?: "relevance" | "deadline" | "newest";
    }) => {
      const feed = await listRelevantTenders(ctx, input);
      for (const row of feed.items) {
        noteTender(ctx, {
          tenderId: row.tenderId,
          title: row.title,
          buyer: row.buyer,
          status: row.status,
          submissionDeadline: row.submissionDeadline,
          daysUntilDeadline: row.daysLeft,
          workspaceStatus: row.workspaceStatus,
          matchScore: row.matchScore,
        });
      }
      return JSON.stringify(feed);
    },
    {
      name: "list_relevant_tenders",
      description:
        "The company's OWN ranked opportunity feed — exactly what the Relevant Tenders page shows, scored on CPV fit, location and timing, with tenders the company rejected excluded. Use for 'what should we bid on', 'anything new for us', 'what closes this month'. Prefer this over find_tenders whenever the question is about THIS company's opportunities rather than a named tender.",
      schema: z.object({
        limit: z.number().int().min(1).max(MAX_FEED_ITEMS).default(8),
        query: z
          .string()
          .min(2)
          .max(120)
          .optional()
          .describe("Free-text narrowing over title and description."),
        sectors: z
          .array(z.string().regex(/^[0-9]{2}$/))
          .max(5)
          .optional()
          .describe("Two-digit CPV divisions, e.g. ['45','71']."),
        regions: z
          .array(z.string().regex(/^DE[0-9A-Z]{0,2}$/))
          .max(5)
          .optional()
          .describe("NUTS prefixes, e.g. ['DE3','DEA']."),
        contractNatures: z
          .array(z.enum(["works", "services", "supplies"]))
          .max(3)
          .optional(),
        deadlineInDays: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Only tenders whose submission deadline falls within N days."),
        minScore: z.number().min(0).max(1).optional(),
        sort: z.enum(["relevance", "deadline", "newest"]).default("relevance"),
      }),
    },
  );

  const listWorkspaceTendersTool = tool(
    async (input: {
      statuses?: Array<(typeof DECISION_STATUSES)[number]>;
      limit: number;
    }) => {
      const rows = await listWorkspaceTenders(ctx, input);
      for (const row of rows) {
        noteTender(ctx, {
          tenderId: row.tenderId,
          title: row.title,
          buyer: row.buyer,
          status: row.tenderStatus,
          submissionDeadline: row.submissionDeadline,
          daysUntilDeadline: row.daysLeft,
          workspaceStatus: row.status,
        });
      }
      return JSON.stringify(rows);
    },
    {
      name: "list_workspace_tenders",
      description:
        "The company's own bid pipeline: which tenders sit in which board column (interested, preparing, submitted, won, lost) plus their deadlines and days left, soonest first. Use for 'what are we working on', 'what have we submitted', 'what is due next', win/loss questions. Pass statuses ['deadzone'] to inspect rejected tenders.",
      schema: z.object({
        statuses: z
          .array(z.enum(DECISION_STATUSES))
          .max(7)
          .optional()
          .describe("Board columns to include. Omit for every non-rejected tender."),
        limit: z.number().int().min(1).max(MAX_WORKSPACE_ITEMS).default(20),
      }),
    },
  );

  const listTenderReportsTool = tool(
    async ({ limit }: { limit: number }) => {
      const summaries = await listReportSummaries(
        ctx.companyContext,
        ctx.locale,
        limit,
      );
      for (const summary of summaries) {
        noteTender(ctx, {
          tenderId: summary.tenderId,
          title: summary.tenderTitle,
          buyer: summary.buyerName,
          submissionDeadline: summary.submissionDeadline,
          decision: asDecision(summary.decision),
          hasReport: true,
        });
      }
      return JSON.stringify(summaries);
    },
    {
      name: "list_tender_reports",
      description:
        "Every full report this company has generated, newest first: tender, decision, confidence, headline, risk and gap counts. Use for 'what have we analyzed', 'which ones did you recommend bidding on', or to find the tenderId of a tender the user only remembers by its analysis.",
      schema: z.object({
        limit: z.number().int().min(1).max(24).default(10),
      }),
    },
  );

  const lookupCpvCodesTool = tool(
    async (input: { codes?: string[]; query?: string; limit: number }) =>
      JSON.stringify(
        await lookupCpvCodes({
          codes: input.codes,
          query: input.query,
          locale: ctx.locale,
          limit: input.limit,
        }),
      ),
    {
      name: "lookup_cpv_codes",
      description:
        "The CPV catalog, both directions: codes → their official names, or wording → the codes that cover it. Use to explain what a tender's bare CPV codes actually mean, and to turn a trade description into the sector filters for list_relevant_tenders or find_tenders. Never guess what a CPV code means — look it up.",
      schema: z.object({
        codes: z
          .array(z.string().min(2).max(12))
          .max(8)
          .optional()
          .describe("CPV codes to resolve, with or without check digit."),
        query: z
          .string()
          .min(2)
          .max(80)
          .optional()
          .describe("Trade or sector wording to search the catalog for."),
        limit: z.number().int().min(1).max(MAX_CPV_ROWS).default(10),
      }),
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
        noteTenderScope(ctx, scope);
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

  const companyTools = [
    searchCompanyDocuments,
    getCompanyProfile,
    listCompanyDocuments,
    listRelevantTendersTool,
    listWorkspaceTendersTool,
    listTenderReportsTool,
    lookupCpvCodesTool,
  ];
  const tenderTools = [
    getTenderAnalysisStatus,
    getTenderNotice,
    getTenderReport,
    getTenderVerdict,
    getOverviewTool,
    getExtractionsTool,
    searchTenderDocuments,
    listTenderFiles,
    readTenderDocument,
    getCompanyFit,
    findSimilarTenders,
  ];
  /**
   * Takes explicit ids rather than a scope, so it is registered identically in
   * both modes — comparison is only ever driven by ids the model already got
   * back from a listing tool.
   */
  const crossTenderTools = [compareTenders];

  return tenderMode
    ? [...tenderTools, ...crossTenderTools, ...companyTools]
    : [findTenders, ...tenderTools, ...crossTenderTools, ...companyTools];
}
