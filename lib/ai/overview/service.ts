import type { ObjectId } from "mongodb";
import { z } from "zod";

import { logger } from "../../ingestion/observability/logger.ts";
import type { SerializedTenderDetail } from "../../tenders/detail.ts";
import { getAiCollections } from "../db/collections.ts";
import { resolveRole } from "../gateway/config.ts";
import { getGateway } from "../gateway/index.ts";
import { hybridRetrieveChunks } from "../retrieval/hybrid.ts";
import { computeCorpusHash } from "../extraction/store.ts";
import type { TenderOverviewDocument } from "../types.ts";

const log = logger.child("ai.overview");

export const OVERVIEW_PROMPT_VERSION = "ov-p2";

/** One language's overview. */
const langOverviewSchema = z.object({
  about: z
    .string()
    .describe(
      "One substantial paragraph (4-7 sentences): what this tender is about, its purpose and background, why the buyer is procuring it, and its overall significance",
    ),
  scope: z
    .string()
    .describe(
      "Detailed multi-paragraph description of everything being procured: every work package, deliverable, quantity, area, construction method, technical approach, lot structure, and how the parts fit together. Use paragraph breaks (\\n\\n) between themes. Be exhaustive about what is stated; note explicitly what remains unspecified",
    ),
  buyer: z
    .string()
    .describe(
      "A full paragraph on the contracting authority: who they are, their legal form and role, what they are responsible for, where they operate, and any context the material gives about them",
    ),
  timeline: z
    .string()
    .describe(
      "A paragraph walking through the procedure and all known dates in order: procedure type and what it means for bidders, publication, question deadlines, submission deadline, binding period, expected award, execution start/end, and milestones",
    ),
  requirements: z
    .string()
    .describe(
      "A paragraph summarizing what is known about eligibility and participation: who may bid, required proofs/certifications/references, award criteria and weighting, subcontracting or lot rules. State clearly when the notice does not specify these yet",
    ),
  risks: z
    .array(z.string())
    .describe(
      "6-10 tender-specific risks, each 1-2 full sentences explaining the risk AND why it matters to a bidder: tight or unusual deadlines, penalties, missing information, demanding eligibility, procedural particularities, ambiguities",
    ),
  highlights: z
    .array(z.string())
    .describe(
      "8-14 concrete facts a bidder must not miss, each a complete sentence with the specific figure, date, or condition",
    ),
});

const overviewOutputSchema = z.object({
  en: langOverviewSchema,
  de: langOverviewSchema,
});

export type TenderOverviewContent = z.infer<typeof overviewOutputSchema>;

const OVERVIEW_JSON_SCHEMA = z.toJSONSchema(overviewOutputSchema, {
  target: "draft-7",
}) as Record<string, unknown>;

/** Generic queries pulling the most overview-relevant chunks when they exist. */
const CONTEXT_QUERIES = [
  "Leistungsbeschreibung Gegenstand der Ausschreibung scope of work",
  "Vertragsstrafen Risiken besondere Bedingungen Fristen",
  "Eignung Nachweise Zuschlagskriterien Wertung",
];
const MAX_CONTEXT_CHUNKS = 16;

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "—";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function noticeSection(tender: SerializedTenderDetail): string {
  const lots = tender.lots
    .slice(0, 8)
    .map(
      (lot, index) =>
        `Lot ${index + 1}: ${lot.title ?? lot.lotId}${lot.description ? ` — ${truncate(lot.description, 300)}` : ""}`,
    );
  return [
    `Title: ${tender.title ?? "—"}`,
    `Buyer: ${tender.buyer?.name ?? "—"} (${tender.buyer?.legalType ?? "—"}; activity: ${tender.buyer?.activityType ?? "—"})`,
    `Buyer location: ${[tender.buyer?.address?.city, tender.buyer?.address?.countryCode].filter(Boolean).join(", ") || "—"}`,
    `Status: ${tender.status} | Procedure: ${tender.procedureType ?? "—"} | Contract nature: ${tender.contractNature ?? "—"}`,
    `CPV: ${tender.cpvCodes.join(", ") || "—"}`,
    `Estimated value: ${tender.estimatedValue?.amount ?? "—"} ${tender.estimatedValue?.currency ?? ""}`.trim(),
    `Published: ${tender.publicationDate ?? "—"} | Submission deadline: ${tender.submissionDeadline ?? "—"}`,
    `Description: ${truncate(tender.description, 6000)}`,
    ...lots,
  ].join("\n");
}

/**
 * Generates the tender-centric AI overview — what the tender is about, the
 * scope, the buyer, risks and highlights — in BOTH languages with one model
 * call, from the notice data plus whatever document chunks exist (none
 * required). Persisted globally per tender; the UI picks the locale.
 */
export async function generateTenderOverview(input: {
  tenderId: ObjectId;
  tender: SerializedTenderDetail;
}): Promise<TenderOverviewDocument> {
  const { chunks, tenderOverviews } = await getAiCollections();

  const chunkCount = await chunks.countDocuments({ tenderId: input.tenderId });
  let excerpts: string[] = [];
  if (chunkCount > 0) {
    const seen = new Set<string>();
    for (const query of CONTEXT_QUERIES) {
      const hits = await hybridRetrieveChunks({
        text: query,
        mode: "hybrid",
        k: 6,
        filters: { tenantId: null, tenderId: input.tenderId },
      });
      for (const hit of hits) {
        const id = String(hit.chunkId);
        if (seen.has(id) || excerpts.length >= MAX_CONTEXT_CHUNKS) continue;
        seen.add(id);
        excerpts.push(`[${hit.fileName}] ${truncate(hit.text, 900)}`);
      }
    }
  }

  const prompt = [
    "You analyze German public tenders for prospective bidders.",
    "Produce a THOROUGH, DETAILED factual dossier of THIS tender — not advice for a specific company.",
    "Be generous with detail: a reader should understand the full picture without opening the source. Use every relevant fact in the material; explain terms a non-expert might not know (procedure types, German construction terms).",
    "Base every statement ONLY on the material below; never invent facts. When something is unknown or unspecified, say so explicitly — that is itself useful information.",
    "Return the SAME content in both English (en) and German (de). Write naturally in each language — do not translate word-for-word.",
    "",
    "=== TENDER NOTICE ===",
    noticeSection(input.tender),
    ...(excerpts.length > 0
      ? ["", "=== DOCUMENT EXCERPTS ===", excerpts.join("\n\n")]
      : ["", "(No tender documents are available yet — the notice is the only source.)"]),
  ].join("\n");

  const result = await getGateway().generateStructured({
    role: "reasoning",
    prompt,
    schema: OVERVIEW_JSON_SCHEMA,
    zod: overviewOutputSchema,
  });

  const corpusHash = chunkCount > 0 ? await computeCorpusHash(input.tenderId) : null;
  const modelRef = resolveRole("reasoning");
  const now = new Date();
  const record: Omit<TenderOverviewDocument, "_id" | "createdAt"> = {
    tenantId: null,
    tenderId: input.tenderId,
    overview: result.value,
    sourceChunkCount: Math.min(chunkCount, MAX_CONTEXT_CHUNKS),
    corpusHash,
    model: {
      provider: modelRef.provider,
      providerModel: modelRef.model,
      promptVersion: OVERVIEW_PROMPT_VERSION,
    },
    generatedAt: now,
    updatedAt: now,
  };

  await tenderOverviews.updateOne(
    { tenderId: input.tenderId },
    { $set: record, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );

  log.info("tender overview generated", {
    tenderId: String(input.tenderId),
    chunksUsed: excerpts.length,
  });

  const stored = await tenderOverviews.findOne({ tenderId: input.tenderId });
  return stored as TenderOverviewDocument;
}

export async function getTenderOverview(
  tenderId: ObjectId,
): Promise<TenderOverviewDocument | null> {
  const { tenderOverviews } = await getAiCollections();
  return tenderOverviews.findOne({ tenderId });
}
