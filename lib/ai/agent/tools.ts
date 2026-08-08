import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { DOC_CLASSES } from "../classification/doc-classes.ts";
import { getExtractions } from "../extraction/store.ts";
import type { StoredCitedValue } from "../extraction/citations.ts";
import { EXTRACTION_SCHEMA_NAMES } from "../extraction/schema-names.ts";
import { getFitState } from "../fit/service.ts";
import { getTenderOverview } from "../overview/service.ts";
import {
  hybridRetrieveChunks,
  hybridRetrieveCompanyChunks,
} from "../retrieval/hybrid.ts";
import type { AgentRunContext } from "./context.ts";

/**
 * Dora's v1 tool registry (roadmap §19): narrow, typed, tenant-safe. Every
 * tool closes over the server-built context — scope is not an input. Outputs
 * are bounded; document text is wrapped in <document> markers so the system
 * prompt's injection posture applies.
 */

const TEXT_CAP = 1_500;
const SECTION_CAP = 2_500;
const DESCRIPTION_CAP = 2_000;

function cap(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function wrapDocument(text: string): string {
  return `<document>${text}</document>`;
}

export function buildDoraTools(ctx: AgentRunContext): StructuredToolInterface[] {
  const getTenderNotice = tool(
    async () => {
      const d = ctx.tenderDetail;
      return JSON.stringify({
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
    },
    {
      name: "get_tender_notice",
      description:
        "The tender notice: title, buyer, procedure, deadlines, CPV codes, lots, value, description. Always cheap — use first for basic facts.",
      schema: z.object({}),
    },
  );

  const getOverviewTool = tool(
    async () => {
      const record = await getTenderOverview(ctx.tenderId);
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
    },
    {
      name: "get_tender_overview",
      description:
        "The AI-generated tender dossier (about, scope, buyer, timeline, requirements, risks, highlights) if it exists. Prefer this over document search for broad questions.",
      schema: z.object({}),
    },
  );

  const getExtractionsTool = tool(
    async ({ schemaName }) => {
      const records = await getExtractions(ctx.tenderId, schemaName);
      if (records.length === 0) {
        return JSON.stringify({ notExtracted: true, hint: "No structured extraction exists yet for this tender." });
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
    },
    {
      name: "get_extractions",
      description:
        "Citation-verified structured facts extracted from the tender documents. Without schemaName: an index of what exists. With schemaName: the fields with verbatim source quotes. ALWAYS prefer this over document search for deadlines, criteria, proofs, penalties, payment terms.",
      schema: z.object({
        schemaName: z.enum(EXTRACTION_SCHEMA_NAMES).optional(),
      }),
    },
  );

  const searchTenderDocuments = tool(
    async ({ query, docClass, k }) => {
      const hits = await hybridRetrieveChunks({
        text: query,
        mode: "hybrid",
        k,
        filters: {
          tenantId: null,
          tenderId: ctx.tenderId,
          docClass,
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
    },
    {
      name: "search_tender_documents",
      description:
        "Full-text + semantic search inside THIS tender's documents. Use for specifics the structured data lacks. German queries work best; legal refs like '§ 13 VOB/B' match exactly.",
      schema: z.object({
        query: z.string().min(3).max(300),
        docClass: z.enum(DOC_CLASSES).optional(),
        k: z.number().int().min(1).max(12).default(8),
      }),
    },
  );

  const getCompanyFit = tool(
    async () => {
      const state = await getFitState(ctx.companyContext, ctx.tenderId);
      if (!state.recommendation) return JSON.stringify({ notGenerated: true });
      return JSON.stringify({
        stale: state.stale,
        generatedAt: state.generatedAt,
        recommendation: state.recommendation,
      });
    },
    {
      name: "get_company_fit",
      description:
        "The stored assessment of how well this tender fits the user's company (verdict, fit score, strengths, concerns). Read-only; may be marked stale.",
      schema: z.object({}),
    },
  );

  const searchCompanyDocuments = tool(
    async ({ query, k }) => {
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

  return [
    getTenderNotice,
    getOverviewTool,
    getExtractionsTool,
    searchTenderDocuments,
    getCompanyFit,
    searchCompanyDocuments,
  ];
}
