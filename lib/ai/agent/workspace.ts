import { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import type { TenderDocument } from "../../ingestion/types.ts";
import { deadlineDaysLeft } from "../../tenders/deadline.ts";
import { listFetchedTenderFiles } from "../../tenders/document-files.ts";
import { resolveCompanyNuts } from "../../tenders/nuts.ts";
import {
  HIDDEN_STATUSES,
  type DecisionStatus,
} from "../../tenders/pipeline-status.ts";
import {
  buildRelevancePipeline,
  stripCheckDigit,
  type RankedTenderRaw,
} from "../../tenders/relevance.ts";
import { getAiCollections } from "../db/collections.ts";
import { computeCorpusHash, getExtractions } from "../extraction/store.ts";
import { hashCompanyData, listEmbeddedCompanyDocs } from "../fit/company-hash.ts";
import { companyProfileInput, getFitState } from "../fit/service.ts";
import { REPORT_PROMPT_VERSION, type ReportLocale } from "../report/schema.ts";
import { CLARA_VERDICT_PROMPT_VERSION } from "../verdict/schema.ts";
import type { AgentRunContext } from "./context.ts";

/**
 * The COMPANY-WORKSPACE half of Clara's toolset: the personalized feed, the
 * kanban decisions, the CPV catalog and the per-tender analysis coverage map.
 *
 * Kept out of `tools.ts` so the tool registry stays a thin, readable wiring
 * layer and this data access can be unit-tested on its own. Every function
 * takes the server-built `AgentRunContext` and derives tenant scope from it —
 * no caller, and therefore no model, can pass a tenant identifier in.
 *
 * The native driver is used throughout (never the Mongoose models) so this
 * module also loads inside the `--experimental-strip-types` worker/script
 * runtime, matching gotcha #1 in `docs/AI_SUBSYSTEM.md`.
 */

/** A feed page bigger than this is noise in a chat answer, not help. */
export const MAX_FEED_ITEMS = 15;
export const MAX_WORKSPACE_ITEMS = 30;
export const MAX_CPV_ROWS = 25;

const HIDDEN = new Set<string>(HIDDEN_STATUSES);

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function daysLeftOf(deadline: Date | null | undefined): number | null {
  return deadline ? deadlineDaysLeft(deadline.toISOString()) : null;
}

// ---------------------------------------------------------------------------
// Decisions (kanban / dead zone)
// ---------------------------------------------------------------------------

export interface WorkspaceDecision {
  tenderId: string;
  status: DecisionStatus;
  assigneeUserId: string | null;
  updatedAt: Date | null;
}

/**
 * Every decision this company has recorded. `tender_decisions.companyId` is a
 * STRING copy of `Company._id` (the Mongoose model stores it that way), so the
 * tenant ObjectId is stringified here rather than at every call site.
 */
export async function listDecisions(
  tenantId: ObjectId,
): Promise<WorkspaceDecision[]> {
  const db = await getIngestionDb();
  const rows = await db
    .collection("tender_decisions")
    .find(
      { companyId: String(tenantId) },
      {
        projection: { tenderId: 1, status: 1, assigneeUserId: 1, updatedAt: 1 },
      },
    )
    .toArray();
  return rows.map((row) => ({
    tenderId: String(row.tenderId),
    status: row.status as DecisionStatus,
    assigneeUserId: (row.assigneeUserId as string | undefined) ?? null,
    updatedAt: (row.updatedAt as Date | undefined) ?? null,
  }));
}

/** tenderId → decision status, for annotating any tender listing. */
export function decisionMap(
  decisions: WorkspaceDecision[],
): Map<string, DecisionStatus> {
  return new Map(decisions.map((decision) => [decision.tenderId, decision.status]));
}

// ---------------------------------------------------------------------------
// Personalized feed
// ---------------------------------------------------------------------------

export interface RelevantTenderFilters {
  limit: number;
  query?: string;
  sectors?: string[];
  regions?: string[];
  contractNatures?: string[];
  deadlineInDays?: number;
  minScore?: number;
  sort?: "relevance" | "deadline" | "newest";
}

export interface RelevantTenderRow {
  tenderId: string;
  title: string | null;
  buyer: string | null;
  city: string | null;
  status: string;
  submissionDeadline: string | null;
  daysLeft: number | null;
  cpvCodes: string[];
  regions: string[];
  estimatedValue: { amount: string | null; currency: string | null } | null;
  /** 0..1 composite of the CPV / location / timing sub-scores. */
  matchScore: number;
  scoreBreakdown: { cpv: number; location: number; timing: number };
  /** Where the tender already sits on the company's board, if anywhere. */
  workspaceStatus: DecisionStatus | null;
}

export interface RelevantTendersResult {
  profile: {
    cpvCodes: string[];
    nuts: string[];
    country: string;
    nutsSource: string;
  };
  /** Every tender matching the feed, not just the `items` page. */
  total: number;
  items: RelevantTenderRow[];
}

/**
 * The company's ranked opportunity feed — the exact ranking the Relevant
 * Tenders page shows, so Clara and the UI can never disagree about what is
 * "relevant to us". Tenders the company sent to the dead zone (or deleted) are
 * excluded; the rest carry their board status so Clara knows what is already
 * being worked on.
 */
export async function listRelevantTenders(
  ctx: AgentRunContext,
  filters: RelevantTenderFilters,
): Promise<RelevantTendersResult> {
  const company = ctx.companyContext.company as unknown as {
    cpvCodes?: string[];
    region?: string | null;
    regionLocation?: { latitude?: number; longitude?: number } | null;
    addressCoordinates?: { lat?: number; lng?: number } | null;
  };

  const decisions = await listDecisions(ctx.tenantId);
  const byTender = decisionMap(decisions);
  const excludeIds = decisions
    .filter((decision) => HIDDEN.has(decision.status))
    .filter((decision) => ObjectId.isValid(decision.tenderId))
    .map((decision) => new ObjectId(decision.tenderId));

  const nuts = resolveCompanyNuts({
    region: company.region ?? null,
    regionLocation: company.regionLocation ?? null,
    addressCoordinates: company.addressCoordinates ?? null,
  });

  const pageSize = Math.min(filters.limit, MAX_FEED_ITEMS);
  const { pipeline } = buildRelevancePipeline(
    { companyCpvCodes: company.cpvCodes ?? [], nuts },
    {
      now: new Date(),
      page: 0,
      pageSize,
      q: filters.query,
      minScore: filters.minScore,
      contractNatures: filters.contractNatures?.length
        ? filters.contractNatures
        : undefined,
      sectors: filters.sectors?.length ? filters.sectors : undefined,
      regions: filters.regions?.length ? filters.regions : undefined,
      deadlineInDays: filters.deadlineInDays,
      sort: filters.sort,
      excludeIds,
    },
  );

  const db = await getIngestionDb();
  const [facet] = await db
    .collection<TenderDocument>("tenders")
    .aggregate<{ items: RankedTenderRaw[]; total: { value: number }[] }>(pipeline, {
      allowDiskUse: true,
    })
    .toArray();

  const rows = facet?.items ?? [];
  return {
    profile: {
      cpvCodes: company.cpvCodes ?? [],
      nuts: [nuts.nuts3, nuts.nuts2, nuts.nuts1].filter(Boolean) as string[],
      country: nuts.country,
      nutsSource: nuts.source,
    },
    total: facet?.total?.[0]?.value ?? 0,
    items: rows.map((row) => ({
      tenderId: String(row._id),
      title: row.title,
      buyer: row.buyer?.name ?? null,
      city: row.buyer?.address?.city ?? null,
      status: row.status,
      submissionDeadline: iso(row.submissionDeadline),
      daysLeft: daysLeftOf(row.submissionDeadline),
      cpvCodes: (row.cpvCodes ?? []).slice(0, 6),
      regions: (row.regions ?? []).slice(0, 4),
      estimatedValue: row.estimatedValueAmount
        ? {
            amount: row.estimatedValueAmount,
            currency: row.estimatedValueCurrency,
          }
        : null,
      matchScore: Number(row.score.toFixed(3)),
      scoreBreakdown: {
        cpv: Number(row.cpvScore.toFixed(2)),
        location: Number(row.geoScore.toFixed(2)),
        timing: Number(row.timeScore.toFixed(2)),
      },
      workspaceStatus: byTender.get(String(row._id)) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Kanban board
// ---------------------------------------------------------------------------

export interface WorkspaceTenderRow {
  tenderId: string;
  status: DecisionStatus;
  title: string | null;
  buyer: string | null;
  tenderStatus: string | null;
  submissionDeadline: string | null;
  daysLeft: number | null;
  movedAt: string | null;
}

/**
 * The company's own bid pipeline: which tenders sit in which kanban column.
 * Ordered by the deadline that actually threatens the company (soonest first),
 * because that is the order the question "what should we be working on" wants.
 */
export async function listWorkspaceTenders(
  ctx: AgentRunContext,
  input: { statuses?: DecisionStatus[]; limit: number },
): Promise<WorkspaceTenderRow[]> {
  const decisions = await listDecisions(ctx.tenantId);
  const wanted = input.statuses?.length
    ? new Set<string>(input.statuses)
    : new Set<string>(
        // Default view is the live board — the dead zone is opt-in.
        decisions.map((decision) => decision.status).filter((s) => !HIDDEN.has(s)),
      );

  const selected = decisions.filter((decision) => wanted.has(decision.status));
  if (selected.length === 0) return [];

  const ids = selected
    .filter((decision) => ObjectId.isValid(decision.tenderId))
    .map((decision) => new ObjectId(decision.tenderId));

  const db = await getIngestionDb();
  const tenders = await db
    .collection<TenderDocument>("tenders")
    .find(
      { _id: { $in: ids } },
      {
        projection: {
          title: 1,
          status: 1,
          submissionDeadline: 1,
          "buyer.name": 1,
        },
      },
    )
    .toArray();
  const byId = new Map(tenders.map((tender) => [String(tender._id), tender]));

  return selected
    .map((decision) => {
      const tender = byId.get(decision.tenderId);
      const deadline = (tender?.submissionDeadline as Date | null) ?? null;
      return {
        tenderId: decision.tenderId,
        status: decision.status,
        title: tender?.title ?? null,
        buyer: tender?.buyer?.name ?? null,
        tenderStatus: tender?.status ?? null,
        submissionDeadline: iso(deadline),
        daysLeft: daysLeftOf(deadline),
        movedAt: iso(decision.updatedAt),
      };
    })
    .sort((left, right) => {
      // Undated entries sort last; everything else soonest-deadline first.
      if (left.daysLeft === null) return right.daysLeft === null ? 0 : 1;
      if (right.daysLeft === null) return -1;
      return left.daysLeft - right.daysLeft;
    })
    .slice(0, Math.min(input.limit, MAX_WORKSPACE_ITEMS));
}

// ---------------------------------------------------------------------------
// CPV catalog
// ---------------------------------------------------------------------------

export interface CpvRow {
  code: string;
  name: string;
  division: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolves CPV codes to their catalog names, or finds codes by wording. The
 * corpus is full of bare codes ("45233120-6") that mean nothing in an answer,
 * and a bidder asking "which codes cover road building" needs the reverse
 * direction to drive the tender filters.
 *
 * Codes are matched on their 8-digit stem so both stored forms — with and
 * without the check digit — resolve. A short prefix ("45") therefore matches
 * the whole family, which is exactly what "what is sector 45" means.
 */
export async function lookupCpvCodes(input: {
  codes?: string[];
  query?: string;
  locale: "en" | "de";
  limit: number;
}): Promise<CpvRow[]> {
  const limit = Math.min(input.limit, MAX_CPV_ROWS);

  // The filter is resolved BEFORE opening a connection: a call with neither
  // criterion would otherwise page the whole catalog into the model.
  let filter: Record<string, unknown>;
  if (input.codes?.length) {
    const stems = [...new Set(input.codes.map(stripCheckDigit).filter(Boolean))];
    if (stems.length === 0) return [];
    filter = {
      $or: stems.map((stem) => ({
        code: { $regex: `^${escapeRegex(stem)}` },
      })),
    };
  } else if (input.query?.trim()) {
    const regex = new RegExp(escapeRegex(input.query.trim()), "i");
    filter = {
      $or: [
        { code: regex },
        { "name.en": regex },
        { "name.de": regex },
        { keywords: regex },
      ],
    };
  } else {
    return [];
  }

  const db = await getIngestionDb();
  const rows = await db
    .collection("cpvcodes")
    .find(filter, { projection: { _id: 0, code: 1, name: 1, division: 1 } })
    // Shorter (broader) codes sort first within a division, so a family lookup
    // leads with the heading rather than an arbitrary leaf.
    .sort({ code: 1 })
    .limit(limit)
    .toArray();

  return rows.map((row) => {
    const name = row.name as { en?: string; de?: string } | undefined;
    return {
      code: String(row.code),
      name: (input.locale === "de" ? name?.de : name?.en) ?? name?.en ?? "",
      division: String(row.division ?? String(row.code).slice(0, 2)),
    };
  });
}

// ---------------------------------------------------------------------------
// Per-tender analysis coverage
// ---------------------------------------------------------------------------

export interface TenderCoverage {
  tenderId: string;
  documents: {
    fetchedFiles: number;
    readableFiles: number;
    indexedChunks: number;
  };
  extractions: Array<{
    schemaName: string;
    status: string;
    filledFields: number;
    unresolved: number;
  }>;
  overview: { exists: boolean; sourceChunkCount: number | null };
  fit: { exists: boolean; stale: boolean; generatedAt: string | null };
  verdict: {
    exists: boolean;
    stale: boolean;
    recommendation: string | null;
    generatedAt: string | null;
  };
  report: {
    exists: boolean;
    stale: boolean;
    decision: string | null;
    locales: string[];
    generatedAt: string | null;
  };
  workspaceStatus: DecisionStatus | null;
  /** Deterministic routing hint: what is actually worth calling next. */
  suggestedTools: string[];
}

/**
 * What the system already knows about one tender, and how fresh it is.
 *
 * This exists so Clara stops guessing. Without it the only way to discover
 * that a tender has no fetched documents is to search them and get nothing —
 * two wasted iterations and an answer that reads like the data is missing when
 * really it was never ingested. The staleness hashes are computed ONCE here
 * and compared against all of verdict/report, rather than each service
 * recomputing them.
 */
export async function getTenderCoverage(
  ctx: AgentRunContext,
  tenderId: ObjectId,
): Promise<TenderCoverage> {
  const { chunks, tenderOverviews, tenderVerdicts, tenderReports } =
    await getAiCollections();

  const [
    files,
    indexedChunks,
    extractions,
    overview,
    verdict,
    report,
    fit,
    decisions,
    corpusHash,
    embeddedDocs,
  ] = await Promise.all([
    listFetchedTenderFiles(tenderId),
    chunks.countDocuments({ tenderId, tenantId: null }),
    getExtractions(tenderId),
    tenderOverviews.findOne({ tenderId }),
    tenderVerdicts.findOne({ tenantId: ctx.tenantId, tenderId }),
    tenderReports.findOne({ tenantId: ctx.tenantId, tenderId }),
    getFitState(ctx.companyContext, tenderId),
    listDecisions(ctx.tenantId),
    computeCorpusHash(tenderId),
    listEmbeddedCompanyDocs(ctx.tenantId),
  ]);

  const companyDataHash = hashCompanyData(
    companyProfileInput(ctx.companyContext.company),
    embeddedDocs,
  );

  const reportLocales = report
    ? Object.keys(report.report ?? {}).filter(
        (locale) => report.report[locale as ReportLocale] != null,
      )
    : [];
  const reportContent = report
    ? ((report.report[ctx.locale as ReportLocale] ??
        report.report[report.primaryLocale]) as
        | { recommendation?: { decision?: string } }
        | undefined)
    : undefined;

  const coverage: TenderCoverage = {
    tenderId: tenderId.toHexString(),
    documents: {
      fetchedFiles: files.length,
      readableFiles: files.filter(
        (file) => file.textStatus === "DONE" && file.textChars > 0,
      ).length,
      indexedChunks,
    },
    extractions: extractions.map((extraction) => ({
      schemaName: extraction.schemaName,
      status: extraction.status,
      filledFields: Object.values(extraction.fields).filter(
        (field) => (field as { value?: unknown }).value != null,
      ).length,
      unresolved: extraction.unresolved.length,
    })),
    overview: {
      exists: overview != null,
      sourceChunkCount: overview?.sourceChunkCount ?? null,
    },
    fit: {
      exists: fit.recommendation != null,
      stale: fit.stale,
      generatedAt: iso(fit.generatedAt),
    },
    verdict: {
      exists: verdict != null,
      stale: verdict
        ? verdict.inputs.corpusHash !== corpusHash ||
          verdict.inputs.companyDataHash !== companyDataHash ||
          verdict.model.promptVersion !== CLARA_VERDICT_PROMPT_VERSION
        : false,
      recommendation: verdict?.recommendation ?? null,
      generatedAt: iso(verdict?.updatedAt),
    },
    report: {
      exists: report != null,
      stale: report
        ? report.inputs.corpusHash !== corpusHash ||
          report.inputs.companyDataHash !== companyDataHash ||
          report.model.promptVersion !== REPORT_PROMPT_VERSION
        : false,
      decision: reportContent?.recommendation?.decision ?? null,
      locales: reportLocales,
      generatedAt: iso(report?.generatedAt),
    },
    workspaceStatus:
      decisionMap(decisions).get(tenderId.toHexString()) ?? null,
    suggestedTools: [],
  };

  coverage.suggestedTools = suggestTools(coverage);
  return coverage;
}

/**
 * Ranked "call this next" hints, cheapest and most authoritative first. This is
 * a routing aid, not a rule — but it keeps the model from searching documents
 * that were never fetched, or re-deriving a conclusion the report already
 * states.
 */
function suggestTools(coverage: TenderCoverage): string[] {
  const next: string[] = [];
  if (coverage.report.exists) next.push("get_tender_report");
  if (coverage.verdict.exists) next.push("get_tender_verdict");
  if (coverage.extractions.some((entry) => entry.status !== "EMPTY")) {
    next.push("get_extractions");
  }
  if (coverage.overview.exists) next.push("get_tender_overview");
  if (coverage.documents.indexedChunks > 0) next.push("search_tender_documents");
  else if (coverage.documents.readableFiles > 0) next.push("read_tender_document");
  if (next.length === 0) next.push("get_tender_notice");
  return next;
}

/** Stored report decisions for a set of tenders — the comparison table's verdict column. */
export async function loadReportDecisions(
  ctx: AgentRunContext,
  tenderIds: ObjectId[],
): Promise<Map<string, { decision: string; confidence: number | null }>> {
  if (tenderIds.length === 0) return new Map();
  const { tenderReports } = await getAiCollections();
  const projection: Record<string, 1> = { tenderId: 1, primaryLocale: 1 };
  for (const locale of ["en", "de"] as const) {
    projection[`report.${locale}.recommendation`] = 1;
  }
  const docs = await tenderReports
    .find({ tenantId: ctx.tenantId, tenderId: { $in: tenderIds } }, { projection })
    .toArray();

  const out = new Map<string, { decision: string; confidence: number | null }>();
  for (const doc of docs) {
    const content = (doc.report[ctx.locale as ReportLocale] ??
      doc.report[doc.primaryLocale]) as
      | { recommendation?: { decision?: string; confidence?: number } }
      | undefined;
    if (!content?.recommendation?.decision) continue;
    out.set(String(doc.tenderId), {
      decision: content.recommendation.decision,
      confidence: content.recommendation.confidence ?? null,
    });
  }
  return out;
}
