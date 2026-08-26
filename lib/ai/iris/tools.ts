import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { deadlineDaysLeft } from "../../tenders/deadline.ts";
import { listFetchedTenderFiles } from "../../tenders/document-files.ts";
import {
  DECISION_STATUSES,
  PIPELINE_STATUSES,
  type DecisionStatus,
} from "../../tenders/pipeline-status.ts";
import { getVisibleTender, type AgentTenderScope, type TenderAgentRunContext } from "../agent/context.ts";
import {
  getTenderCoverage,
  listRelevantTenders,
  listWorkspaceTenders,
  loadReportDecisions,
  lookupCpvCodes,
  MAX_CPV_ROWS,
  MAX_FEED_ITEMS,
  MAX_WORKSPACE_ITEMS,
  type RelevantTenderRow,
} from "../agent/workspace.ts";
import {
  getCompanyDocEmbedStatuses,
  getCompanyFilesCollection,
} from "../company/doc-embedder.ts";
import type { StoredCitedValue } from "../extraction/citations.ts";
import { getExtractions } from "../extraction/store.ts";
import { getTenderOverview } from "../overview/service.ts";
import { getReportState, serializeReport } from "../report/service.ts";
import { hybridRetrieveChunks, hybridRetrieveCompanyChunks } from "../retrieval/hybrid.ts";
import { getVerdictState } from "../verdict/service.ts";
import type { BlockKind, BlockPayload, Decision, TenderCard, Tone } from "./blocks.ts";
import type { IrisRunContext } from "./context.ts";
import { t, type IrisLocale } from "./strings.ts";

/**
 * Iris's tool registry: every tool RENDERS.
 *
 * The contract that makes this a generative-UI agent rather than a chat agent
 * with pictures:
 *
 *   - Each tool maps to exactly one block kind, known before it runs. That is
 *     what lets the skeleton appear the instant the call starts.
 *   - The tool builds the block from the real collections and returns a SHORT
 *     JSON ack to the model — ids, counts, the one or two facts it needs to
 *     write a sentence. A fifteen-tender grid costs the model ~200 tokens, and
 *     the model cannot contradict the grid because it never saw a richer
 *     version of it.
 *   - Tenancy is closed over from the authenticated request (`IrisRunContext`),
 *     never taken as an input. Tender ids ARE inputs — tender data is a shared
 *     corpus stored under `tenantId: null` — but every one is re-validated
 *     through `getVisibleTender`.
 */

/** Ack the model gets when a tool's target does not resolve. */
const TENDER_NOT_FOUND = JSON.stringify({
  tenderNotFound: true,
  hint: "No visible tender with this id. Use show_opportunity_feed or show_pipeline_board to get real ids.",
});

const tenderIdInput = z
  .string()
  .length(24)
  .describe("A 24-character tender id returned by a previous Iris tool.");

// ---------------------------------------------------------------------------
// Block plumbing
// ---------------------------------------------------------------------------

/**
 * Open a slot, build the payload, settle the slot, ack the model.
 *
 * The try/catch collapses to a fixed message on purpose: a provider or driver
 * error string can carry connection details and prompt text, and it would end
 * up rendered in the user's browser.
 */
async function render<K extends BlockKind>(
  ctx: IrisRunContext,
  kind: K,
  loadingTitle: string,
  build: () => Promise<{ block: BlockPayload<K>; ack: Record<string, unknown> } | { empty: string }>,
): Promise<string> {
  const handle = ctx.blocks.open(kind, loadingTitle);
  if (!handle) {
    return JSON.stringify({
      blockLimitReached: true,
      hint: "This turn already rendered the maximum number of views. Answer with what is on screen.",
    });
  }

  try {
    const result = await build();
    if ("empty" in result) {
      handle.fail(result.empty);
      return JSON.stringify({ rendered: kind, empty: true, reason: result.empty });
    }
    if (!handle.ready(result.block)) {
      return JSON.stringify({ renderFailed: true, kind });
    }
    return JSON.stringify({ rendered: kind, blockId: handle.id, ...result.ack });
  } catch (error) {
    // The STACK, not just the message: a block builder calls into half the
    // retrieval stack, and "Maximum call stack size exceeded" with no frame
    // tells you nothing about which of them blew up.
    console.error(
      `[iris] block ${kind} failed`,
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    handle.fail(t(ctx.locale, "renderFailed"));
    return JSON.stringify({ renderFailed: true, kind });
  }
}

// ---------------------------------------------------------------------------
// Shared mappers
// ---------------------------------------------------------------------------

const CARD_DECISIONS = ["bid", "no_bid", "conditional"] as const;

function asDecision(value: string | null | undefined): Decision | null {
  return CARD_DECISIONS.find((entry) => entry === value) ?? null;
}

function feedRowToCard(row: RelevantTenderRow): TenderCard {
  return {
    tenderId: row.tenderId,
    title: row.title,
    buyer: row.buyer,
    city: row.city,
    status: row.status,
    submissionDeadline: row.submissionDeadline,
    daysLeft: row.daysLeft,
    matchScore: row.matchScore,
    scoreBreakdown: row.scoreBreakdown,
    estimatedValue: row.estimatedValue,
    cpvCodes: row.cpvCodes.slice(0, 6),
    regions: row.regions.slice(0, 4),
    workspaceStatus: row.workspaceStatus,
  };
}

function scopeToCard(scope: AgentTenderScope): TenderCard {
  const detail = scope.tenderDetail;
  return {
    tenderId: scope.tenderId.toHexString(),
    title: detail.title,
    buyer: detail.buyer?.name ?? null,
    city: detail.buyer?.address?.city ?? null,
    status: detail.status,
    submissionDeadline: detail.submissionDeadline,
    daysLeft: detail.submissionDeadline
      ? deadlineDaysLeft(detail.submissionDeadline)
      : null,
    estimatedValue: detail.estimatedValue,
    cpvCodes: detail.cpvCodes.slice(0, 8),
    regions: detail.regions.slice(0, 4),
  };
}

/** Trim a quote to something a card can hold without a scrollbar. */
function quote(text: string, max = 420): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function dateLabel(iso: string | null | undefined, locale: IrisLocale): string {
  if (!iso) return t(locale, "none");
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return t(locale, "none");
  return parsed.toISOString().slice(0, 10);
}

function moneyLabel(
  value: { amount: string | null; currency: string | null } | null | undefined,
  locale: IrisLocale,
): string {
  if (!value?.amount) return t(locale, "none");
  const numeric = Number(value.amount);
  const formatted = Number.isFinite(numeric)
    ? new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-GB", {
        maximumFractionDigits: 0,
      }).format(numeric)
    : value.amount;
  return value.currency ? `${formatted} ${value.currency}` : formatted;
}

/** Deadline pressure as a tone, so the comparison table colours itself. */
function deadlineTone(daysLeft: number | null | undefined): Tone {
  if (daysLeft == null) return "neutral";
  if (daysLeft < 0) return "critical";
  if (daysLeft <= 7) return "critical";
  if (daysLeft <= 21) return "warning";
  return "positive";
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function buildIrisTools(ctx: IrisRunContext): StructuredToolInterface[] {
  const locale = ctx.locale;
  const str = (key: Parameters<typeof t>[1]) => t(locale, key);

  /** Load + re-validate a tender id coming from a tool input. */
  const scopeFor = (tenderId: string) => getVisibleTender(ctx, tenderId);

  // -- Portfolio ------------------------------------------------------------

  const showPortfolioMetrics = tool(
    async () =>
      render(ctx, "metric-summary", str("metricsTitle"), async () => {
        const [feed, board] = await Promise.all([
          listRelevantTenders(ctx, { limit: MAX_FEED_ITEMS }),
          listWorkspaceTenders(ctx, { limit: MAX_WORKSPACE_ITEMS }),
        ]);

        const closingSoon = feed.items.filter(
          (row) => row.daysLeft != null && row.daysLeft >= 0 && row.daysLeft <= 7,
        ).length;
        const submitted = board.filter((row) => row.status === "submitted").length;
        const averageMatch =
          feed.items.length > 0
            ? feed.items.reduce((sum, row) => sum + row.matchScore, 0) / feed.items.length
            : 0;

        return {
          block: {
            title: str("metricsTitle"),
            caption: str("metricsCaption"),
            metrics: [
              { label: str("metricMatched"), value: String(feed.total), tone: "primary" as const },
              {
                label: str("metricClosingWeek"),
                value: String(closingSoon),
                tone: closingSoon > 0 ? ("critical" as const) : ("neutral" as const),
              },
              { label: str("metricOnBoard"), value: String(board.length) },
              { label: str("metricSubmitted"), value: String(submitted) },
              {
                label: str("metricAvgMatch"),
                value: `${Math.round(averageMatch * 100)}%`,
                progress: averageMatch,
                tone: "primary" as const,
              },
            ],
          },
          ack: {
            matchedTotal: feed.total,
            closingWithin7Days: closingSoon,
            onBoard: board.length,
            submitted,
          },
        };
      }),
    {
      name: "show_portfolio_metrics",
      description:
        "Render the company's headline numbers: matched opportunities, deadlines closing this week, tenders on the board, submitted bids, average match. Use to open a session or answer 'how are we doing'.",
      schema: z.object({}),
    },
  );

  // -- Feed -----------------------------------------------------------------

  const feedFilterShape = {
    query: z.string().max(200).optional().describe("Free-text topic or trade filter."),
    sectors: z
      .array(z.string())
      .max(6)
      .optional()
      .describe("CPV codes or 2-digit CPV divisions, e.g. ['45'] for construction."),
    regions: z.array(z.string()).max(6).optional().describe("NUTS region codes."),
    contractNatures: z
      .array(z.string())
      .max(4)
      .optional()
      .describe("e.g. ['works', 'services', 'supplies']."),
    deadlineInDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Only tenders whose submission deadline falls within this many days."),
    minScore: z.number().min(0).max(1).optional(),
    sort: z.enum(["relevance", "deadline", "newest"]).optional(),
  };

  const showOpportunityFeed = tool(
    async (input: {
      limit: number;
      title?: string;
      query?: string;
      sectors?: string[];
      regions?: string[];
      contractNatures?: string[];
      deadlineInDays?: number;
      minScore?: number;
      sort?: "relevance" | "deadline" | "newest";
    }) => {
      const title = input.title?.trim() || str("feedTitle");
      return render(ctx, "tender-grid", title, async () => {
        const feed = await listRelevantTenders(ctx, { ...input, limit: input.limit });
        return {
          block: {
            title,
            caption: null,
            total: feed.total,
            items: feed.items.map(feedRowToCard),
            emptyHint: feed.items.length === 0 ? str("feedEmpty") : null,
          },
          ack: {
            total: feed.total,
            shown: feed.items.length,
            // Ids only — the model needs them to drill in, not the whole row.
            tenderIds: feed.items.map((row) => row.tenderId),
            topMatch: feed.items[0]
              ? { tenderId: feed.items[0].tenderId, title: feed.items[0].title }
              : null,
          },
        };
      });
    },
    {
      name: "show_opportunity_feed",
      description:
        "Render the company's ranked opportunity feed as tender cards — the same ranking the Relevant Tenders page uses. The primary way to answer 'what should we bid on'. Returns tender ids for the drill-in tools.",
      schema: z.object({
        ...feedFilterShape,
        title: z
          .string()
          .max(80)
          .optional()
          .describe("Headline for the grid, in the user's language. Omit for the default."),
        limit: z.number().int().min(1).max(MAX_FEED_ITEMS).default(6),
      }),
    },
  );

  // -- Single tender --------------------------------------------------------

  const showTenderSpotlight = tool(
    async ({ tenderId }: { tenderId: string }) => {
      const scope = await scopeFor(tenderId);
      if (!scope) return TENDER_NOT_FOUND;

      return render(ctx, "tender-spotlight", scope.tenderDetail.title ?? "", async () => {
        const detail = scope.tenderDetail;
        const [coverage, overviewRecord, cpvRows] = await Promise.all([
          getTenderCoverage(ctx, scope.tenderId),
          getTenderOverview(scope.tenderId),
          detail.cpvCodes.length
            ? lookupCpvCodes({ codes: detail.cpvCodes.slice(0, 6), locale, limit: 6 })
            : Promise.resolve([]),
        ]);

        const overview = overviewRecord?.overview as
          | Record<string, { highlights?: string[] }>
          | undefined;
        const highlights =
          overview?.[locale]?.highlights ?? overview?.en?.highlights ?? [];

        return {
          block: {
            tender: {
              ...scopeToCard(scope),
              workspaceStatus: coverage.workspaceStatus,
              decision:
                asDecision(coverage.report.decision) ??
                asDecision(coverage.verdict.recommendation),
              hasReport: coverage.report.exists,
            },
            description: detail.description ? quote(detail.description, 900) : null,
            procedureType: detail.procedureType,
            contractNature: detail.contractNature,
            categories: cpvRows.map((row) => row.name).filter(Boolean),
            lots: detail.lots.slice(0, 6).map((lot) => ({
              title: lot.title ?? null,
              deadline: lot.submissionDeadline ?? null,
              value: lot.estimatedValue ?? null,
            })),
            coverage: {
              fetchedFiles: coverage.documents.fetchedFiles,
              readableFiles: coverage.documents.readableFiles,
              indexedChunks: coverage.documents.indexedChunks,
              hasOverview: coverage.overview.exists,
              hasReport: coverage.report.exists,
              hasVerdict: coverage.verdict.exists,
              extractionCount: coverage.extractions.filter(
                (entry) => entry.status !== "EMPTY",
              ).length,
            },
            highlights: highlights.slice(0, 6),
            sourceUrl: detail.sourceLinks.find((link) => link.url)?.url ?? null,
          },
          // Coverage is the routing hint: it tells the model which follow-up
          // block will actually have data behind it.
          ack: {
            tenderId: scope.tenderId.toHexString(),
            title: detail.title,
            daysUntilDeadline: detail.submissionDeadline
              ? deadlineDaysLeft(detail.submissionDeadline)
              : null,
            available: {
              verdict: coverage.verdict.exists,
              report: coverage.report.exists,
              extractions: coverage.extractions.filter((e) => e.status !== "EMPTY").length,
              indexedChunks: coverage.documents.indexedChunks,
            },
          },
        };
      });
    },
    {
      name: "show_tender_spotlight",
      description:
        "Render one tender in depth: notice facts, lots, CPV categories, AI highlights and — importantly — what analysis already exists for it. Call this before any other per-tender view so you know which of them have data.",
      schema: z.object({ tenderId: tenderIdInput }),
    },
  );

  const compareTendersView = tool(
    async ({ tenderIds, title }: { tenderIds: string[]; title?: string }) => {
      const heading = title?.trim() || str("compareTitle");
      return render(ctx, "tender-compare", heading, async () => {
        const scopes: AgentTenderScope[] = [];
        for (const id of tenderIds) {
          const scope = await scopeFor(id);
          if (scope) scopes.push(scope);
        }
        if (scopes.length < 2) return { empty: str("tenderNotFound") };

        const decisions = await loadReportDecisions(
          ctx,
          scopes.map((scope) => scope.tenderId),
        );
        const details = scopes.map((scope) => scope.tenderDetail);
        const daysLeft = details.map((detail) =>
          detail.submissionDeadline ? deadlineDaysLeft(detail.submissionDeadline) : null,
        );

        const row = (label: string, cells: Array<{ text: string; tone?: Tone }>) => ({
          label,
          cells,
        });

        return {
          block: {
            title: heading,
            caption: null,
            columns: scopes.map((scope) => ({
              tenderId: scope.tenderId.toHexString(),
              title: scope.tenderDetail.title,
              buyer: scope.tenderDetail.buyer?.name ?? null,
              decision: asDecision(decisions.get(scope.tenderId.toHexString())?.decision),
            })),
            rows: [
              row(
                str("rowDeadline"),
                details.map((detail) => ({ text: dateLabel(detail.submissionDeadline, locale) })),
              ),
              row(
                str("rowDaysLeft"),
                daysLeft.map((days) => ({
                  text: days == null ? str("none") : String(days),
                  tone: deadlineTone(days),
                })),
              ),
              row(
                str("rowBuyer"),
                details.map((detail) => ({ text: detail.buyer?.name ?? str("unknown") })),
              ),
              row(
                str("rowValue"),
                details.map((detail) => ({ text: moneyLabel(detail.estimatedValue, locale) })),
              ),
              row(
                str("rowProcedure"),
                details.map((detail) => ({ text: detail.procedureType ?? str("unknown") })),
              ),
              row(
                str("rowNature"),
                details.map((detail) => ({ text: detail.contractNature ?? str("unknown") })),
              ),
              row(
                str("rowRegion"),
                details.map((detail) => ({
                  text: detail.regions.slice(0, 2).join(", ") || str("unknown"),
                })),
              ),
              row(
                str("rowDecision"),
                scopes.map((scope) => {
                  const decision = decisions.get(scope.tenderId.toHexString())?.decision;
                  return {
                    text: decision ?? str("none"),
                    tone:
                      decision === "bid"
                        ? ("positive" as const)
                        : decision === "no_bid"
                          ? ("critical" as const)
                          : decision
                            ? ("warning" as const)
                            : ("neutral" as const),
                  };
                }),
              ),
            ],
          },
          ack: {
            compared: scopes.map((scope) => scope.tenderId.toHexString()),
            soonestDeadlineIndex: daysLeft.reduce<number | null>(
              (best, days, index) =>
                days == null
                  ? best
                  : best == null || days < (daysLeft[best] ?? Infinity)
                    ? index
                    : best,
              null,
            ),
          },
        };
      });
    },
    {
      name: "compare_tenders_view",
      description:
        "Render 2-5 tenders as a side-by-side comparison table (deadline, days left, buyer, value, procedure, region, stored decision). Use whenever the user is choosing between tenders instead of describing each one in prose.",
      schema: z.object({
        tenderIds: z.array(z.string().length(24)).min(2).max(5),
        title: z.string().max(80).optional(),
      }),
    },
  );

  // -- Analysis -------------------------------------------------------------

  const showBidVerdict = tool(
    async ({ tenderId }: { tenderId: string }) => {
      const scope = await scopeFor(tenderId);
      if (!scope) return TENDER_NOT_FOUND;

      return render(ctx, "bid-verdict", str("verdictTitle"), async () => {
        // getVerdictState is typed for tender-bound runs; Iris is global, so
        // the scope comes from the validated input instead of the run.
        const state = await getVerdictState({ ...ctx, tender: scope } as TenderAgentRunContext);
        if (!state) return { empty: str("verdictMissing") };

        const { verdict } = state;
        const breakdown = verdict.scoreBreakdown;
        return {
          block: {
            tenderId: scope.tenderId.toHexString(),
            tenderTitle: scope.tenderDetail.title,
            recommendation: verdict.recommendation,
            rationale: quote(verdict.rationale, 900),
            scores: [
              { label: str("scoreEligibility"), value: Math.round(breakdown.eligibilityFit * 100) },
              { label: str("scoreStrategic"), value: Math.round(breakdown.strategicFit * 100) },
              { label: str("scoreCapacity"), value: Math.round(breakdown.capacityFit * 100) },
              { label: str("scoreContractRisk"), value: Math.round(breakdown.contractRisk * 100) },
              {
                label: str("scoreDeadline"),
                value: Math.round(breakdown.deadlineFeasibility * 100),
              },
            ],
            risks: verdict.risks.slice(0, 8).map((risk) => ({
              text: quote(risk.text, 240),
              severity: risk.severity,
              uncited: risk.uncited === true,
            })),
            blockers: verdict.blockingRequirements
              .slice(0, 8)
              .map((entry) => quote(entry.text, 240)),
            openQuestions: verdict.unresolvedQuestions.slice(0, 6),
            generatedAt: verdict.updatedAt ? new Date(verdict.updatedAt).toISOString() : null,
            stale: state.stale,
          },
          ack: {
            recommendation: verdict.recommendation,
            stale: state.stale,
            riskCount: verdict.risks.length,
            blockerCount: verdict.blockingRequirements.length,
          },
        };
      });
    },
    {
      name: "show_bid_verdict",
      description:
        "Render the stored bid / no-bid verdict for one tender: decision, five score axes, cited risks, blocking requirements and open questions. Only call it when show_tender_spotlight reported a verdict exists.",
      schema: z.object({ tenderId: tenderIdInput }),
    },
  );

  const showRequirements = tool(
    async ({ tenderId }: { tenderId: string }) => {
      const scope = await scopeFor(tenderId);
      if (!scope) return TENDER_NOT_FOUND;

      return render(ctx, "requirement-checklist", str("requirementsTitle"), async () => {
        // The report is the only source that judges a requirement AGAINST the
        // company. Extractions know what the tender demands but nothing about
        // whether this bidder satisfies it — so they render as `unknown`
        // rather than quietly reading as passed checks.
        const reportState = await getReportState(ctx.companyContext, scope.tenderId);
        const serialized = reportState
          ? serializeReport(reportState.report, reportState.stale, locale)
          : null;
        const reportRequirements = serialized?.report.requirements ?? [];

        if (reportRequirements.length > 0) {
          return {
            block: {
              title: str("requirementsTitle"),
              caption: str("requirementsFromReport"),
              items: reportRequirements.slice(0, 20).map((entry) => ({
                label: quote(entry.requirement, 220),
                status: entry.companyStatus,
                detail: entry.action ? quote(entry.action, 220) : quote(entry.evidence, 220),
                mandatory: entry.mandatory ?? undefined,
                evidence: null,
              })),
            },
            ack: {
              source: "report",
              total: reportRequirements.length,
              gaps: reportRequirements.filter((entry) => entry.companyStatus === "gap").length,
            },
          };
        }

        const records = await getExtractions(scope.tenderId, "suitability_criteria");
        const fields = Object.entries(records[0]?.fields ?? {}).filter(
          ([, raw]) => (raw as StoredCitedValue).value != null,
        );
        if (fields.length === 0) return { empty: str("requirementsMissing") };

        return {
          block: {
            title: str("requirementsTitle"),
            caption: str("requirementsFromExtraction"),
            items: fields.slice(0, 20).map(([name, raw]) => {
              const field = raw as StoredCitedValue;
              const citation = field.citations[0];
              return {
                label: name.replace(/[_-]+/g, " "),
                status: "unknown" as const,
                detail: quote(String(field.value), 220),
                evidence: citation
                  ? {
                      quote: quote(citation.quote, 260),
                      fileName: citation.documentRecordId ?? "tender document",
                    }
                  : null,
              };
            }),
          },
          ack: { source: "extraction", total: fields.length, assessedAgainstCompany: false },
        };
      });
    },
    {
      name: "show_requirements",
      description:
        "Render the tender's participation and suitability requirements as a checklist. When a full report exists each item is marked met / partial / gap against THIS company; otherwise items come from the extractions and are marked unknown.",
      schema: z.object({ tenderId: tenderIdInput }),
    },
  );

  const showDeadlines = tool(
    async ({ tenderId }: { tenderId: string }) => {
      const scope = await scopeFor(tenderId);
      if (!scope) return TENDER_NOT_FOUND;

      return render(ctx, "deadline-timeline", str("timelineTitle"), async () => {
        const detail = scope.tenderDetail;
        const reportState = await getReportState(ctx.companyContext, scope.tenderId);
        const serialized = reportState
          ? serializeReport(reportState.report, reportState.stale, locale)
          : null;

        const items: BlockPayload<"deadline-timeline">["items"] = [];
        if (detail.publicationDate) {
          items.push({
            label: str("timelinePublication"),
            date: detail.publicationDate,
            kind: "publication",
            detail: null,
            daysLeft: deadlineDaysLeft(detail.publicationDate),
          });
        }

        // The report's timeline is richer (question deadlines, site visits,
        // binding periods) and already in the reader's language.
        for (const entry of serialized?.report.timeline ?? []) {
          if (!entry.date) continue;
          items.push({
            label: quote(entry.label, 90),
            date: entry.date,
            kind: entry.critical ? "binding" : "milestone",
            detail: entry.detail ? quote(entry.detail, 180) : null,
            daysLeft: deadlineDaysLeft(entry.date),
          });
        }

        if (detail.submissionDeadline) {
          items.push({
            label: str("timelineSubmission"),
            date: detail.submissionDeadline,
            kind: "submission",
            detail: null,
            daysLeft: deadlineDaysLeft(detail.submissionDeadline),
          });
        }

        if (items.length === 0) return { empty: str("timelineMissing") };

        items.sort((left, right) => (left.date ?? "").localeCompare(right.date ?? ""));
        const deduped = items.filter(
          (entry, index, all) =>
            all.findIndex((other) => other.date === entry.date && other.label === entry.label) ===
            index,
        );

        return {
          block: {
            title: str("timelineTitle"),
            caption: detail.title,
            items: deduped.slice(0, 12),
          },
          ack: {
            milestones: deduped.length,
            submissionDaysLeft: detail.submissionDeadline
              ? deadlineDaysLeft(detail.submissionDeadline)
              : null,
          },
        };
      });
    },
    {
      name: "show_deadlines",
      description:
        "Render every known date for one tender as a timeline with live countdowns — publication, question deadlines, site visits, submission, binding period. Use for any 'when' or 'how long do we have' question.",
      schema: z.object({ tenderId: tenderIdInput }),
    },
  );

  // -- Documents and evidence ----------------------------------------------

  const showTenderDocuments = tool(
    async ({ tenderId }: { tenderId: string }) => {
      const scope = await scopeFor(tenderId);
      if (!scope) return TENDER_NOT_FOUND;

      return render(ctx, "document-shelf", str("tenderDocumentsTitle"), async () => {
        const [files, coverage] = await Promise.all([
          listFetchedTenderFiles(scope.tenderId),
          getTenderCoverage(ctx, scope.tenderId),
        ]);
        if (files.length === 0) return { empty: str("documentsMissing") };

        return {
          block: {
            title: str("tenderDocumentsTitle"),
            scope: "tender" as const,
            caption: scope.tenderDetail.title,
            items: files.slice(0, 40).map((file) => ({
              fileName: file.fileName,
              mimeType: file.mimeType ?? null,
              sizeBytes: file.byteLength ?? null,
              readable: file.textStatus === "DONE" && file.textChars > 0,
              indexed: coverage.documents.indexedChunks > 0,
            })),
          },
          ack: {
            files: files.length,
            readable: files.filter((file) => file.textStatus === "DONE" && file.textChars > 0)
              .length,
            indexedChunks: coverage.documents.indexedChunks,
          },
        };
      });
    },
    {
      name: "show_tender_documents",
      description:
        "Render the document files downloaded for one tender, with readability and index status. Use to show what the analysis is based on, or to explain why an answer is unavailable.",
      schema: z.object({ tenderId: tenderIdInput }),
    },
  );

  const showCompanyDocuments = tool(
    async ({ category }: { category?: string }) =>
      render(ctx, "document-shelf", str("companyDocumentsTitle"), async () => {
        const companyFiles = await getCompanyFilesCollection();
        const files = await companyFiles
          .find({ companyId: ctx.tenantId, category: category ?? { $ne: "logo" } })
          .sort({ createdAt: -1 })
          .limit(40)
          .toArray();
        if (files.length === 0) return { empty: str("companyDocumentsMissing") };

        const statuses = await getCompanyDocEmbedStatuses(files.map((file) => String(file._id)));
        return {
          block: {
            title: str("companyDocumentsTitle"),
            scope: "company" as const,
            caption: null,
            items: files.map((file) => ({
              fileName: file.fileName,
              docClass: file.category ?? null,
              mimeType: file.contentType ?? null,
              sizeBytes: file.size ?? null,
              indexed: statuses.get(String(file._id)) === "indexed",
              updatedAt: file.createdAt ? new Date(file.createdAt).toISOString() : null,
            })),
          },
          ack: {
            files: files.length,
            indexed: files.filter((file) => statuses.get(String(file._id)) === "indexed").length,
          },
        };
      }),
    {
      name: "show_company_documents",
      description:
        "Render the company's own uploaded documents (insurance, certifications, reference projects) with their search-index status. Use when the question is about what the company can PROVE.",
      schema: z.object({
        category: z
          .enum(["insurance", "certification", "reference-project", "general"])
          .optional(),
      }),
    },
  );

  const searchEvidence = tool(
    async (input: { scope: "tender" | "company"; query: string; tenderId?: string; k: number }) => {
      let tenderScope: AgentTenderScope | null = null;
      if (input.scope === "tender") {
        if (!input.tenderId) {
          return JSON.stringify({
            missingInput: "tenderId is required when scope is 'tender'.",
          });
        }
        tenderScope = await scopeFor(input.tenderId);
        if (!tenderScope) return TENDER_NOT_FOUND;
      }

      return render(ctx, "evidence-panel", str("evidenceTitle"), async () => {
        const hits =
          tenderScope !== null
            ? await hybridRetrieveChunks({
                text: input.query,
                mode: "hybrid",
                k: input.k,
                filters: { tenantId: null, tenderId: tenderScope.tenderId },
              })
            : await hybridRetrieveCompanyChunks({
                text: input.query,
                k: input.k,
                filters: { tenantId: ctx.tenantId },
              });

        if (hits.length === 0) return { empty: str("evidenceMissing") };

        return {
          block: {
            title: str("evidenceTitle"),
            query: input.query,
            scope: input.scope,
            items: hits.slice(0, 10).map((hit) => ({
              quote: quote(hit.text, 520),
              fileName: hit.fileName,
              page: hit.anchor?.page ?? null,
              sectionPath: hit.sectionPath.slice(0, 3),
              docClass: null,
            })),
          },
          // The model gets shortened quotes so it can reason and cite without
          // the panel and the prose disagreeing about what the source says.
          ack: {
            hits: hits.length,
            excerpts: hits.slice(0, 4).map((hit) => ({
              fileName: hit.fileName,
              text: quote(hit.text, 300),
            })),
          },
        };
      });
    },
    {
      name: "search_evidence",
      description:
        "Search inside the indexed documents and render the matching passages as quotable evidence cards. scope 'tender' needs a tenderId; scope 'company' searches the company's own files. German queries work best; legal refs like '§ 13 VOB/B' match exactly.",
      schema: z.object({
        scope: z.enum(["tender", "company"]),
        tenderId: z.string().length(24).optional(),
        query: z.string().min(3).max(300),
        k: z.number().int().min(1).max(10).default(6),
      }),
    },
  );

  // -- Board, catalogue, profile -------------------------------------------

  const showPipelineBoard = tool(
    async ({ statuses }: { statuses?: DecisionStatus[] }) =>
      render(ctx, "pipeline-board", str("boardTitle"), async () => {
        const rows = await listWorkspaceTenders(ctx, {
          statuses,
          limit: MAX_WORKSPACE_ITEMS,
        });
        if (rows.length === 0) return { empty: str("boardEmpty") };

        const wanted = statuses?.length
          ? PIPELINE_STATUSES.filter((status) => statuses.includes(status))
          : PIPELINE_STATUSES;

        return {
          block: {
            title: str("boardTitle"),
            caption: null,
            columns: wanted.map((status) => {
              const inColumn = rows.filter((row) => row.status === status);
              return {
                status,
                count: inColumn.length,
                items: inColumn.slice(0, 8).map((row) => ({
                  tenderId: row.tenderId,
                  title: row.title,
                  buyer: row.buyer,
                  daysLeft: row.daysLeft,
                })),
              };
            }),
          },
          ack: {
            total: rows.length,
            byStatus: Object.fromEntries(
              PIPELINE_STATUSES.map((status) => [
                status,
                rows.filter((row) => row.status === status).length,
              ]),
            ),
            urgent: rows
              .filter((row) => row.daysLeft != null && row.daysLeft <= 7)
              .slice(0, 5)
              .map((row) => ({ tenderId: row.tenderId, daysLeft: row.daysLeft })),
          },
        };
      }),
    {
      name: "show_pipeline_board",
      description:
        "Render the company's own bid pipeline as a compact kanban board (interested / preparing / submitted / won / lost), soonest deadline first. Use for 'what are we working on' and workload questions.",
      schema: z.object({
        statuses: z.array(z.enum(DECISION_STATUSES)).max(5).optional(),
      }),
    },
  );

  const exploreCpvCodes = tool(
    async (input: { codes?: string[]; query?: string; limit: number }) =>
      render(ctx, "cpv-explorer", str("cpvTitle"), async () => {
        const rows = await lookupCpvCodes({ ...input, locale, limit: input.limit });
        if (rows.length === 0) return { empty: str("cpvMissing") };

        const profile = new Set(
          (ctx.companyContext.company.cpvCodes ?? []).map((code) => code.split("-")[0]),
        );
        return {
          block: {
            title: str("cpvTitle"),
            caption: input.query ?? null,
            items: rows.map((row) => ({
              code: row.code,
              name: row.name,
              division: row.division,
              onProfile: profile.has(row.code.split("-")[0]),
            })),
          },
          ack: {
            codes: rows.map((row) => row.code),
            onProfile: rows.filter((row) => profile.has(row.code.split("-")[0])).length,
          },
        };
      }),
    {
      name: "explore_cpv_codes",
      description:
        "Render CPV catalogue entries as chips, marking which ones are already on the company profile. Pass `codes` to name bare codes found in a notice, or `query` to find codes by trade wording.",
      schema: z.object({
        codes: z.array(z.string()).max(10).optional(),
        query: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(MAX_CPV_ROWS).default(10),
      }),
    },
  );

  const showCompanySnapshot = tool(
    async () =>
      render(ctx, "company-snapshot", ctx.companyContext.company.name, async () => {
        const company = ctx.companyContext.company;
        const [cpvRows, companyFiles] = await Promise.all([
          company.cpvCodes?.length
            ? lookupCpvCodes({ codes: company.cpvCodes.slice(0, 10), locale, limit: 10 })
            : Promise.resolve([]),
          getCompanyFilesCollection(),
        ]);
        const files = await companyFiles
          .find({ companyId: ctx.tenantId, category: { $ne: "logo" } })
          .project({ _id: 1 })
          .toArray();
        const statuses = await getCompanyDocEmbedStatuses(files.map((file) => String(file._id)));

        const foundingYear = Number(company.knowledgeBase?.companyExtended?.foundingYear);

        return {
          block: {
            name: company.name,
            city: company.knowledgeBase?.principalOffice?.city ?? null,
            country: company.knowledgeBase?.principalOffice?.country ?? null,
            employees: company.employeeCount ?? null,
            foundedYear: Number.isFinite(foundingYear) ? foundingYear : null,
            capabilities: [
              ...(company.services ?? []),
              ...(company.trade ?? []),
              ...(company.specializations ?? []),
            ]
              .filter(Boolean)
              .slice(0, 16),
            cpvCodes: cpvRows.map((row) => ({ code: row.code, name: row.name })),
            regions: [company.region].filter(Boolean).slice(0, 12),
            documentCount: files.length,
            indexedDocumentCount: [...statuses.values()].filter((status) => status === "indexed")
              .length,
          },
          ack: {
            company: company.name,
            cpvCount: company.cpvCodes?.length ?? 0,
            documentCount: files.length,
          },
        };
      }),
    {
      name: "show_company_snapshot",
      description:
        "Render the user's own company profile card: trades, CPV codes, region, headcount and how many of their documents are indexed. Use for 'what do we look like to the matcher' questions.",
      schema: z.object({}),
    },
  );

  // -- Interactive ----------------------------------------------------------

  const askUserChoice = tool(
    async (input: {
      question: string;
      caption?: string;
      options: Array<{ label: string; description?: string; prompt: string }>;
    }) =>
      render(ctx, "choice-prompt", input.question, async () => ({
        block: {
          question: input.question,
          caption: input.caption ?? null,
          options: input.options.slice(0, 5).map((option, index) => ({
            id: `option-${index + 1}`,
            label: option.label,
            description: option.description ?? null,
            prompt: option.prompt,
          })),
          allowFreeText: true,
        },
        ack: { asked: true, optionCount: Math.min(input.options.length, 5) },
      })),
    {
      name: "ask_user_choice",
      description:
        "Ask the user a question as clickable options instead of a paragraph. Use when a request is genuinely ambiguous, or to offer the two or three most useful next steps. Each option carries the message that is sent when it is clicked. STOP after calling this — the user answers next.",
      schema: z.object({
        question: z.string().min(3).max(200).describe("In the user's language."),
        caption: z.string().max(200).optional(),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(60),
              description: z.string().max(140).optional(),
              prompt: z
                .string()
                .min(3)
                .max(240)
                .describe(
                  "The message sent as the user's next turn when this option is clicked. Write it in first person, in the user's language.",
                ),
            }),
          )
          .min(2)
          .max(5),
      }),
    },
  );

  const offerFilters = tool(
    async (input: { query?: string }) =>
      render(ctx, "filter-refine", str("filtersTitle"), async () => {
        // Facets are computed from the CURRENT result set rather than authored
        // by the model: a filter chip that returns nothing is worse than no
        // chip at all, and only the query knows what is actually in there.
        const feed = await listRelevantTenders(ctx, {
          limit: MAX_FEED_ITEMS,
          query: input.query,
        });
        const divisions = new Map<string, number>();
        const regions = new Map<string, number>();
        for (const row of feed.items) {
          for (const code of row.cpvCodes.slice(0, 3)) {
            const division = code.slice(0, 2);
            divisions.set(division, (divisions.get(division) ?? 0) + 1);
          }
          for (const region of row.regions.slice(0, 2)) {
            regions.set(region, (regions.get(region) ?? 0) + 1);
          }
        }

        // Ask for the DIVISION HEADINGS ("45000000"), not the bare stems.
        // `lookupCpvCodes` matches on prefix, so a two-digit stem pulls the
        // whole family — 25 leaves of division 45, none of the other
        // divisions, and a chip labelled "Alternators" because the last row
        // wins the map. The heading code matches exactly one row per division.
        const cpvNames = await lookupCpvCodes({
          codes: [...divisions.keys()].map((division) => `${division}000000`),
          locale,
          limit: MAX_CPV_ROWS,
        });
        const nameByDivision = new Map(
          cpvNames.map((row) => [row.code.slice(0, 2), row.name] as const),
        );

        const byCount = <T extends { count: number | null }>(left: T, right: T) =>
          (right.count ?? 0) - (left.count ?? 0);

        return {
          block: {
            title: str("filtersTitle"),
            caption: str("filtersCaption"),
            facets: [
              {
                key: "sectors",
                label: str("facetSector"),
                multi: true,
                values: [...divisions.entries()]
                  .map(([division, count]) => ({
                    value: division,
                    label: nameByDivision.get(division) ?? division,
                    count,
                  }))
                  .sort(byCount)
                  .slice(0, 10),
              },
              {
                key: "regions",
                label: str("facetRegion"),
                multi: true,
                values: [...regions.entries()]
                  .map(([region, count]) => ({ value: region, label: region, count }))
                  .sort(byCount)
                  .slice(0, 10),
              },
            ].filter((facet) => facet.values.length > 0),
            deadlineDays: null,
            submitLabel: str("filtersApply"),
          },
          ack: {
            facetsOffered: divisions.size > 0 || regions.size > 0,
            pool: feed.total,
          },
        };
      }),
    {
      name: "offer_filters",
      description:
        "Render interactive facet controls (sectors, regions, deadline window) built from what is actually in the current results. Use after a broad feed when narrowing would help. STOP after calling this — the user applies the filters next.",
      schema: z.object({
        query: z
          .string()
          .max(200)
          .optional()
          .describe("The feed query the facets should be computed against."),
      }),
    },
  );

  return [
    showPortfolioMetrics,
    showOpportunityFeed,
    showTenderSpotlight,
    compareTendersView,
    showBidVerdict,
    showRequirements,
    showDeadlines,
    showTenderDocuments,
    showCompanyDocuments,
    searchEvidence,
    showPipelineBoard,
    exploreCpvCodes,
    showCompanySnapshot,
    askUserChoice,
    offerFilters,
  ];
}
