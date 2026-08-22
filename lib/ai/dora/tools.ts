import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { DOC_CLASSES } from "../classification/doc-classes.ts";
import { EXTRACTION_SCHEMA_NAMES } from "../extraction/schema-names.ts";
import { buildFullCompanyContext } from "../fit/company-context.ts";
import { companyProfileInput } from "../fit/service.ts";
import { hybridRetrieveCompanyChunks } from "../retrieval/hybrid.ts";
import type { ChatCitation } from "../agent/citations.ts";
import {
  cap,
  renderExtractions,
  renderOverview,
  renderReadTenderDocument,
  renderTenderFiles,
  renderTenderNotice,
  renderTenderSearch,
  wrapDocument,
} from "../agent/tools.ts";
import { buildProposeEditsTool } from "../../dora-gateway/edit-ops.ts";
import { getAiCollections } from "../db/collections.ts";
import { getBriefState } from "./brief.ts";
import type { BriefContent } from "./brief-schema.ts";
import type { DoraRunContext } from "./context.ts";
import { getWorkspaceDocumentText, workspaceTextCacheKey } from "./document-text.ts";
import { latestFillRun, patchFillFields } from "./fill/runs.ts";

/**
 * Dora's tool registry: the document-panel subset. Same invariants as Clara's
 * (§ agent/tools.ts): every tool closes over the server-built context, no
 * tenant/tender/document id is ever a tool input, outputs are bounded, and
 * document text rides inside <document> markers. The tender tools register
 * only when the document is linked to a (still visible) tender — for direct
 * uploads Dora simply has no tender surface.
 */

const TEXT_CAP = 1_500;
const PROFILE_CAP = 6_000;
/** One read_current_document window; long docs page via `offset`. */
const DOCUMENT_WINDOW_CHARS = 20_000;

export function buildDoraTools(ctx: DoraRunContext): StructuredToolInterface[] {
  const scope = ctx.tender;

  const readCurrentDocument = tool(
    async ({ offset }: { offset: number }) => {
      const text = await getWorkspaceDocumentText(ctx.document, ctx.tenantId);
      if (text.status !== "ready") {
        return JSON.stringify({
          notReadable: true,
          status: text.status,
          note: text.note,
          hint:
            text.note === "no_text_layer"
              ? "Scanned PDF with no text layer. Its pages are attached to this conversation — read them directly rather than answering from tender context alone."
              : "The document's text could not be extracted.",
        });
      }
      const start = Math.min(Math.max(0, offset), Math.max(0, text.text.length - 1));
      const window = text.text.slice(start, start + DOCUMENT_WINDOW_CHARS);
      const registered = ctx.citations.add({
        quote: window.slice(0, 300),
        fileName: ctx.document.fileName,
      });
      const end = start + window.length;
      return JSON.stringify({
        fileName: ctx.document.fileName,
        storageRevision: ctx.document.version?.storageRevision ?? ctx.document.storageRevision,
        citationKey: registered.key,
        totalChars: text.chars,
        window: { start, end },
        ...(end < text.text.length ? { nextOffset: end } : {}),
        ...(text.note ? { note: text.note } : {}),
        text: wrapDocument(window),
      });
    },
    {
      name: "read_current_document",
      description:
        "Read the OPEN document's extracted text (the last saved version), 20k characters per call. Pass offset (from nextOffset) to page through long documents. Your primary source for anything about the document itself.",
      schema: z.object({
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Character offset to read from; use nextOffset of the previous call."),
      }),
    },
  );

  const getDocumentBrief = tool(
    async () => {
      const state = await getBriefState(ctx);
      if (!state) {
        return JSON.stringify({
          notGenerated: true,
          hint: "No Document Brief exists yet. The user generates it with the Analyze button in the panel.",
        });
      }
      const content = (state.doc.brief[ctx.locale] ??
        state.doc.brief.en ??
        state.doc.brief.de) as unknown as BriefContent;
      // Stored evidence ids become THIS turn's citation keys so the answer's
      // chips resolve — same rewrite the report tool performs for Clara.
      const keysFor = (evidenceIds: string[]): string[] =>
        evidenceIds
          .map((id) => state.doc.citations[id] as unknown as ChatCitation | undefined)
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
      return JSON.stringify({
        stale: state.stale,
        generatedAt: state.doc.generatedAt.toISOString(),
        analyzedRevision: state.doc.storageRevision,
        documentType: content.documentType,
        purpose: content.purpose,
        summary: content.summary,
        keyRequirements: content.keyRequirements.map((item) => ({
          text: item.text,
          citationKeys: keysFor(item.evidenceIds),
        })),
        deadlines: content.deadlines.map((item) => ({
          label: item.label,
          date: item.date,
          citationKeys: keysFor(item.evidenceIds),
        })),
        requiredActions: content.requiredActions.map((item) => ({
          step: item.step,
          detail: item.detail,
          citationKeys: keysFor(item.evidenceIds),
        })),
        suggestedValues: content.suggestedValues.map((item) => ({
          field: item.field,
          value: item.value,
          source: item.source,
          citationKeys: keysFor(item.evidenceIds),
        })),
        missingInfo: content.missingInfo,
        risks: content.risks.map((item) => ({
          text: item.text,
          severity: item.severity,
          citationKeys: keysFor(item.evidenceIds),
        })),
      });
    },
    {
      name: "get_document_brief",
      description:
        "Dora's stored Document Brief for the open document: type, purpose, requirements, deadlines, the action checklist, suggested fill-in values, missing info and risks. Check this FIRST — it already answers most questions about the document. May be marked stale after edits.",
      schema: z.object({}),
    },
  );

  const getDocumentInfo = tool(
    async () => {
      const { workspaceDocumentTexts, documentBriefs } = await getAiCollections();
      const version = ctx.document.version;
      const [textRow, briefRow] = await Promise.all([
        version
          ? workspaceDocumentTexts.findOne(
              {
                _id: workspaceTextCacheKey(
                  ctx.document.documentId.toHexString(),
                  version.sha256,
                ),
              },
              { projection: { status: 1, note: 1, chars: 1 } },
            )
          : Promise.resolve(null),
        documentBriefs.findOne(
          { tenantId: ctx.tenantId, documentId: ctx.document.documentId },
          { projection: { versionSha256: 1, generatedAt: 1 } },
        ),
      ]);
      return JSON.stringify({
        fileName: ctx.document.fileName,
        documentType: ctx.document.documentType,
        state: ctx.document.state,
        storageRevision: ctx.document.storageRevision,
        activeEditors: ctx.document.activeUserIds.length,
        source: version?.reason ?? null,
        linkedTender: scope
          ? {
              title: scope.tenderDetail.title,
              submissionDeadline: scope.tenderDetail.submissionDeadline,
              status: scope.tenderDetail.status,
            }
          : null,
        // null = not extracted yet; read_current_document triggers extraction.
        textExtraction: textRow
          ? { status: textRow.status, note: textRow.note, chars: textRow.chars }
          : null,
        brief: briefRow
          ? {
              exists: true,
              stale: version ? briefRow.versionSha256 !== version.sha256 : false,
              generatedAt: briefRow.generatedAt,
            }
          : { exists: false },
      });
    },
    {
      name: "get_document_info",
      description:
        "Cheap status call: the open document's name, type, revision, linked tender, whether its text is extracted and whether a brief exists (and is fresh). Call first when unsure what material is available.",
      schema: z.object({}),
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
        "Search the user's OWN company documents (insurance certificates, references, capability statements). Use to find the company data a form field or requirement asks for.",
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
        "The user's structured company profile: identity, capabilities, certifications, financials, insurance, bonding, reference projects. The first stop for values that belong in forms (VAT id, address, bank details, headcounts).",
      schema: z.object({}),
    },
  );

  const getDocumentFillPlan = tool(
    async () => {
      const run = await latestFillRun(ctx.tenantId, ctx.document.documentId);
      if (!run) return JSON.stringify({ notAnalyzed: true });
      return JSON.stringify({
        status: run.status,
        fields: run.fields.map((field) => ({
          id: field.id,
          label: field.label,
          required: field.required,
          sensitive: field.sensitive,
          value: field.value,
          state: field.state,
          confidence: field.confidence,
          reason: field.reason,
          evidence: field.evidence,
        })),
      });
    },
    {
      name: "get_document_fill_plan",
      description:
        "Read the current reviewed fill-field list for the open document, including ready, missing, manual and needs-review fields. Use when the user asks what is fillable or what is still missing.",
      schema: z.object({}),
    },
  );

  const setDocumentFillValue = tool(
    async ({ field, value, notApplicable }: { field: string; value?: string; notApplicable: boolean }) => {
      const run = await latestFillRun(ctx.tenantId, ctx.document.documentId);
      if (!run || run.status !== "review") {
        return JSON.stringify({ updated: false, error: "fill_review_not_available" });
      }
      const needle = field.trim().toLocaleLowerCase();
      const matches = run.fields.filter(
        (item) => item.id === field || item.label.trim().toLocaleLowerCase() === needle,
      );
      if (matches.length !== 1) {
        return JSON.stringify({
          updated: false,
          error: matches.length ? "field_ambiguous" : "field_not_found",
          availableFields: run.fields.map((item) => ({ id: item.id, label: item.label })),
        });
      }
      const updated = await patchFillFields({
        tenantId: ctx.tenantId,
        documentId: ctx.document.documentId,
        updates: [{
          id: matches[0].id,
          ...(notApplicable ? { state: "not_applicable" as const } : { value: value ?? "" }),
        }],
      });
      const result = updated?.fields.find((item) => item.id === matches[0].id);
      return JSON.stringify({ updated: Boolean(result), field: result ?? null });
    },
    {
      name: "set_document_fill_value",
      description:
        "Set one field in the document-local fill review plan from the user's explicit answer, or mark it not applicable. This never updates the company profile and never generates a file.",
      schema: z.object({
        field: z.string().min(1).max(200).describe("Exact field label or id from get_document_fill_plan"),
        value: z.string().max(20_000).optional(),
        notApplicable: z.boolean().default(false),
      }),
    },
  );

  /**
   * Point the viewer at a discovered field. PDF-only: it is the answer to
   * "where do I sign?", which in a Word document the user can simply scroll to
   * but in a paginated PDF they cannot.
   *
   * The tool returns text; the actual scrolling is a UI call the panel picks
   * up. WireUiCall is already generic, so this needs no wire-protocol change.
   */
  const locateDocumentField = tool(
    async ({ field }: { field: string }) => {
      const run = await latestFillRun(ctx.tenantId, ctx.document.documentId);
      if (!run) return JSON.stringify({ located: false, error: "not_analyzed" });
      const needle = field.trim().toLocaleLowerCase();
      // Same matcher as set_document_fill_value: exact id, else folded label.
      const matches = run.fields.filter(
        (item) => item.id === field || item.label.trim().toLocaleLowerCase() === needle,
      );
      if (matches.length !== 1) {
        return JSON.stringify({
          located: false,
          error: matches.length ? "field_ambiguous" : "field_not_found",
          availableFields: run.fields.map((item) => ({ id: item.id, label: item.label })),
        });
      }
      const target = matches[0];
      const locator = target.locator;
      if (!locator || !("page" in locator)) {
        return JSON.stringify({ located: false, error: "field_has_no_location", label: target.label });
      }
      ctx.uiCalls.add({
        action: "dora.pdf.locate_field",
        args: {
          fieldId: target.id,
          page: locator.page,
          rect: locator.rect,
          anchorText: "anchorText" in locator ? locator.anchorText : null,
        },
      });
      return JSON.stringify({
        located: true,
        id: target.id,
        label: target.label,
        page: locator.page + 1,
        state: target.state,
      });
    },
    {
      name: "locate_document_field",
      description:
        "Scroll the open PDF to a field from the fill plan and highlight it. Use when the user asks where a field is or where they need to sign.",
      schema: z.object({
        field: z.string().min(1).max(200).describe("Exact field label or id from get_document_fill_plan"),
      }),
    },
  );

  // The V1 exact-text edit engine is retired: the V2 planner + stream tiers
  // cover everything it did with live-range targeting instead of text-anchor
  // search. Kill-switch kept for one release, then delete buildProposeEditsTool.
  const documentTools = [
    getDocumentInfo,
    getDocumentBrief,
    readCurrentDocument,
    getDocumentFillPlan,
    setDocumentFillValue,
    // PDF-only: a Word user scrolls; a PDF user needs the page and the box.
    ...(ctx.document.documentType === "pdf" ? [locateDocumentField] : []),
    // V1 is a Word text-anchor engine. Registering it for a PDF would offer a
    // tool that cannot possibly work on this document.
    ...(process.env.DORA_EDIT_ENGINE_V1 === "true" && ctx.document.documentType === "word"
      ? [buildProposeEditsTool(ctx)]
      : []),
  ];
  const companyTools = [searchCompanyDocuments, getCompanyProfile];

  if (!scope) return [...documentTools, ...companyTools];

  // Tender tools — the linked tender is closed over; no ids are inputs.
  const getTenderContext = tool(
    async () => {
      const [overview] = await Promise.all([renderOverview(ctx, scope)]);
      return JSON.stringify({
        notice: JSON.parse(renderTenderNotice(scope)),
        overview: JSON.parse(overview),
      });
    },
    {
      name: "get_tender_context",
      description:
        "The linked tender in one call: the notice (buyer, deadlines, CPV, value, lots) plus the AI overview when it exists. Use for questions that need tender context around the document.",
      schema: z.object({}),
    },
  );

  const getExtractionsTool = tool(
    async (input: { schemaName?: (typeof EXTRACTION_SCHEMA_NAMES)[number] }) =>
      renderExtractions(ctx, scope, input?.schemaName),
    {
      name: "get_extractions",
      description:
        "Citation-verified structured facts extracted from the linked tender's documents. Without schemaName: an index of what exists. With schemaName: the fields with verbatim source quotes. ALWAYS prefer this over document search for deadlines, criteria, proofs, penalties, payment terms.",
      schema: z.object({
        schemaName: z.enum(EXTRACTION_SCHEMA_NAMES).optional(),
      }),
    },
  );

  const searchTenderDocuments = tool(
    async (input: {
      query: string;
      docClass?: (typeof DOC_CLASSES)[number];
      k: number;
    }) => renderTenderSearch(ctx, scope, input),
    {
      name: "search_tender_documents",
      description:
        "Full-text + semantic search inside the linked tender's documents. Use for requirements or context the open document references but does not contain. German queries work best; legal refs like '§ 13 VOB/B' match exactly.",
      schema: z.object({
        query: z.string().min(3).max(300),
        docClass: z.enum(DOC_CLASSES).optional(),
        k: z.number().int().min(1).max(12).default(8),
      }),
    },
  );

  const listTenderFiles = tool(async () => renderTenderFiles(scope), {
    name: "list_tender_files",
    description:
      "List the linked tender's DOWNLOADED document files (name, type, size, readability). Use when document search returns nothing, or to see what exists before reading one.",
    schema: z.object({}),
  });

  const readTenderDocument = tool(
    async (input: { fileName: string }) =>
      renderReadTenderDocument(ctx, scope, input.fileName),
    {
      name: "read_tender_document",
      description:
        "Read the full extracted text of ONE downloaded tender file by its exact name (from list_tender_files). The fallback when search_tender_documents has no coverage.",
      schema: z.object({
        fileName: z.string().min(1).max(300),
      }),
    },
  );

  return [
    ...documentTools,
    getTenderContext,
    getExtractionsTool,
    searchTenderDocuments,
    listTenderFiles,
    readTenderDocument,
    ...companyTools,
  ];
}
