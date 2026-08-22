import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";

import { getChatModel } from "@/lib/ai/agent/model";
import { aiEnv } from "@/lib/ai/config/env";
import { getAiCollections } from "@/lib/ai/db/collections";
import { connectMongoose } from "@/lib/db/mongoose";
import { getOrParseGaebDocument } from "@/lib/gaeb/store";
import type { GaebDocument, GaebItem } from "@/lib/gaeb/types";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

import { buildFillGrounding } from "../grounding";
import { updateFillRun } from "../runs";
import type {
  DocumentFillEvidence,
  DocumentFillField,
  DocumentFillGaebSummary,
  GaebTenderContext,
} from "../types";
import {
  bulkPatchGaebFillItems,
  countGaebFillItems,
  listGaebFillItems,
  seedGaebFillItems,
  type GaebFillClassification,
  type GaebFillItemDocument,
  type GaebFillSuggestion,
} from "./items";
import {
  buildGaebClassifyPrompt,
  buildGaebContextPrompt,
  buildGaebPricingPrompt,
} from "./prompt-gaeb";
import {
  GAEB_CLASSIFY_BATCH_JSON_SCHEMA,
  GAEB_CONTEXT_JSON_SCHEMA,
  GAEB_PRICING_BATCH_JSON_SCHEMA,
  gaebClassifyBatchSchema,
  gaebContextSchema,
  gaebPricingBatchSchema,
} from "./schema-gaeb";
import { lookupWebPrices, type GaebWebPriceFinding } from "./web-prices";

/**
 * The GAEB pricing engine. Stage mapping onto the shared ladder:
 *
 *   discovering — parse assert + seed items + tender-context extraction +
 *                 CLASSIFICATION batches (trade/attributes/product mentions)
 *   grounding   — company profile + chunks + web price lookups
 *   validating  — PRICING batches + deterministic post-processing
 *   review      — mandatory human gate; ALWAYS reached, failures included
 *
 * Every batch persists before the next starts, so progress is resumable and a
 * failed batch costs its own items, never the run. Suggestion text is written
 * in German — the domain language of the documents being priced.
 */

const SUGGESTION_LOCALE = "de" as const;

export async function analyzeGaebFillRun(runIdHex: string): Promise<void> {
  const { documentFillRuns } = await getAiCollections();
  const runId = new ObjectId(runIdHex);
  const run = await documentFillRuns.findOne({ _id: runId });
  // Same re-entrancy guard as the PDF engine: queue retries of an advanced
  // run are no-ops. "review" is additionally allowed in via retry_failed,
  // which flips it back to analyzing before dispatch.
  if (!run || !["queued", "failed", "analyzing"].includes(run.status)) return;
  await updateFillRun(runId, { status: "analyzing", stage: "discovering", error: null });

  try {
    await connectMongoose();
    const [document, version] = await Promise.all([
      WorkspaceDocument.findById(run.documentId).lean(),
      WorkspaceDocumentVersion.findOne({
        _id: run.sourceVersionId,
        documentId: run.documentId,
        state: "committed",
      }).lean(),
    ]);
    if (!document) throw new Error("document_context_missing");
    if (!version) throw new Error("source_version_missing");
    if (version.sha256 !== run.sourceSha256) throw new Error("source_bytes_changed");

    const stored = await getOrParseGaebDocument({
      tenantId: run.tenantId,
      documentId: run.documentId,
      versionId: new ObjectId(String(version._id)),
      sourceSha256: version.sha256,
      s3Key: version.s3Key,
      extension: version.extension,
    });
    if (!stored.document) {
      throw new Error(`gaeb_parse_failed:${stored.parseError?.code ?? "unknown"}`);
    }
    const parsed = stored.document;
    const env = aiEnv();
    if (parsed.items.length > env.gaebFillMaxPositions) {
      throw new Error("gaeb_too_many_positions");
    }

    const summary: DocumentFillGaebSummary = {
      phase: parsed.phase,
      flavor: parsed.flavor,
      parserVersion: stored.parserVersion,
      sourceItemCount: parsed.items.length,
      batchSize: env.gaebFillBatchSize,
      batchCount: Math.ceil(parsed.items.length / env.gaebFillBatchSize),
      classifiedCount: 0,
      pricedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      webLookupsDone: 0,
      webLookupsTotal: 0,
      contextHash: null,
      context: null,
      warnings: [...(run.gaeb?.warnings ?? [])],
    };
    const pushSummary = async () => updateFillRun(runId, { gaeb: { ...summary } });
    const refreshCounts = async () => {
      const counts = await countGaebFillItems(runId);
      summary.classifiedCount = counts.classified;
      summary.pricedCount = counts.priced;
      summary.failedCount = counts.failed;
      summary.skippedCount = counts.skipped;
      await pushSummary();
    };
    const stillAnalyzing = async () => {
      const fresh = await documentFillRuns.findOne(
        { _id: runId },
        { projection: { status: 1 } },
      );
      return fresh?.status === "analyzing";
    };

    // Idempotent seed — re-entry inserts only missing keys.
    await seedGaebFillItems({
      runId,
      tenantId: run.tenantId,
      documentId: run.documentId,
      items: parsed.items,
      batchSize: env.gaebFillBatchSize,
    });

    // Tender context: reuse a prior extraction on re-entry, else one call.
    let context = run.gaeb?.context ?? null;
    if (!context) {
      context = await extractTenderContext(parsed);
    }
    summary.context = context;
    summary.contextHash = context
      ? createHash("sha256").update(JSON.stringify(context)).digest("hex")
      : null;
    await refreshCounts();

    const itemByKey = new Map(parsed.items.map((item) => [item.key, item]));
    const categoryPathByItem = buildCategoryPaths(parsed);

    /* ------------------------- classification ---------------------------- */

    await classifyPending({
      runId,
      env,
      context,
      itemByKey,
      categoryPathByItem,
      stillAnalyzing,
      refreshCounts,
      warnings: summary.warnings,
    });

    /* ---------------------------- grounding ------------------------------ */

    await updateFillRun(runId, { stage: "grounding", gaeb: { ...summary } });
    const grounding = await buildFillGrounding({
      tenantId: run.tenantId,
      tenderId: document.tenderId ? new ObjectId(String(document.tenderId)) : null,
    });

    const classified = await listGaebFillItems(runId, { status: ["classified", "pending"] });
    let web: { findings: GaebWebPriceFinding[]; warnings: string[] };
    if (run.gaeb?.webFindings?.length) {
      // A retry pass reuses the evidence already paid for.
      web = { findings: run.gaeb.webFindings, warnings: [] };
      summary.webLookupsTotal = run.gaeb.webLookupsTotal;
      summary.webLookupsDone = run.gaeb.webLookupsDone;
    } else {
      const products = rankProductMentions(classified);
      summary.webLookupsTotal = Math.min(products.length, env.gaebWebPricingMaxLookups);
      await pushSummary();
      web = await lookupWebPrices({
        products,
        region: context?.region ?? null,
        shouldContinue: stillAnalyzing,
        onProgress: async (done) => {
          summary.webLookupsDone = done;
          await pushSummary();
        },
      });
    }
    summary.warnings.push(...web.warnings);
    summary.webFindings = web.findings;
    for (const finding of web.findings) {
      const reference = finding.sourceUrl || `web-product:${finding.product}`;
      grounding.evidence.set(`web:${reference}`, {
        source: "web",
        reference,
        excerpt:
          `${finding.product}: ${finding.unitPrice !== null ? `${finding.unitPrice} ${finding.currency}/${finding.unit || "unit"}` : "no reliable price"}`.slice(
            0,
            240,
          ),
      });
    }

    /* ----------------------------- pricing ------------------------------- */

    await updateFillRun(runId, { stage: "validating", gaeb: { ...summary } });
    await priceClassified({
      runId,
      env,
      context,
      currency: parsed.meta.currency ?? "EUR",
      itemByKey,
      profileLines: grounding.profileLines,
      evidence: grounding.evidence,
      webFindings: web.findings,
      stillAnalyzing,
      refreshCounts,
      warnings: summary.warnings,
    });

    /* ------------------------------ review ------------------------------- */

    const fields = buildBidderMetaFields(parsed, grounding.evidence);
    await refreshCounts();
    // The review gate is unconditional: partial results are usable results.
    await documentFillRuns.updateOne(
      { _id: runId, status: "analyzing" },
      {
        $set: {
          status: "review",
          stage: "review",
          fields,
          gaeb: { ...summary },
          error: null,
          updatedAt: new Date(),
        },
      },
    );
  } catch (error) {
    await updateFillRun(runId, {
      status: "failed",
      error: (error instanceof Error ? error.message : "analysis_failed").slice(0, 500),
      finishedAt: new Date(),
    });
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Stages                                                                     */
/* -------------------------------------------------------------------------- */

async function extractTenderContext(parsed: GaebDocument): Promise<GaebTenderContext | null> {
  try {
    const model = await getChatModel({
      role: "dora_gaeb_fill",
      maxOutputTokens: 4_096,
      temperature: 0,
    });
    const structured = model.withStructuredOutput(GAEB_CONTEXT_JSON_SCHEMA as never, {
      name: "gaeb_tender_context",
    });
    const raw = await structured.invoke(
      buildGaebContextPrompt({ document: parsed, locale: SUGGESTION_LOCALE }),
    );
    return gaebContextSchema.parse(raw);
  } catch {
    // Context is an enrichment; pricing proceeds without it.
    return null;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    }),
  );
}

async function classifyPending(input: {
  runId: ObjectId;
  env: ReturnType<typeof aiEnv>;
  context: GaebTenderContext | null;
  itemByKey: ReadonlyMap<string, GaebItem>;
  categoryPathByItem: ReadonlyMap<string, string>;
  stillAnalyzing: () => Promise<boolean>;
  refreshCounts: () => Promise<void>;
  warnings: string[];
}): Promise<void> {
  const pending = await listGaebFillItems(input.runId, { status: "pending" });
  if (pending.length === 0) return;

  const model = await getChatModel({
    role: "dora_gaeb_fill",
    maxOutputTokens: input.env.gaebFillMaxOutputTokens,
    temperature: 0,
  });
  const structured = model.withStructuredOutput(GAEB_CLASSIFY_BATCH_JSON_SCHEMA as never, {
    name: "gaeb_classify_batch",
  });

  const classifyOnce = async (batchItems: GaebItem[]) => {
    const prompt = buildGaebClassifyPrompt({
      context: input.context,
      categoryPathByItem: input.categoryPathByItem,
      batch: batchItems,
    });
    const raw = await structured.invoke(prompt);
    return gaebClassifyBatchSchema.parse(raw);
  };

  /**
   * Retry ladder: same batch once more, then split halves (a truncated-JSON
   * runaway is deterministic at temperature 0, so only a DIFFERENT prompt has
   * a real second chance). Whatever still fails degrades to unclassified —
   * pricing works from raw text, so the item stays in the flow either way.
   */
  const classifyResilient = async (
    batchItems: GaebItem[],
    allowSplit: boolean,
  ): Promise<Map<string, GaebFillClassification>> => {
    try {
      const parsed = await classifyOnce(batchItems).catch(() => classifyOnce(batchItems));
      const out = new Map<string, GaebFillClassification>();
      for (const entry of parsed.items) {
        out.set(entry.itemKey, {
          trade: entry.trade,
          workCategory: entry.workCategory,
          attributes: entry.attributes,
          productMentions: entry.productMentions,
        });
      }
      return out;
    } catch (error) {
      if (allowSplit && batchItems.length > 4) {
        const middle = Math.ceil(batchItems.length / 2);
        const [left, right] = await Promise.all([
          classifyResilient(batchItems.slice(0, middle), false),
          classifyResilient(batchItems.slice(middle), false),
        ]);
        return new Map([...left, ...right]);
      }
      input.warnings.push(
        `classify_batch_failed:${batchItems[0]?.key ?? "?"}:${
          error instanceof Error ? error.message.slice(0, 80) : "error"
        }`,
      );
      return new Map();
    }
  };

  await runPool(
    chunk(pending, input.env.gaebFillBatchSize),
    input.env.gaebFillBatchConcurrency,
    async (batchRows) => {
      if (!(await input.stillAnalyzing())) return;
      const batchItems = batchRows
        .map((row) => input.itemByKey.get(row.itemKey))
        .filter((item): item is GaebItem => Boolean(item));
      if (batchItems.length === 0) return;

      const classified = await classifyResilient(batchItems, true);
      await bulkPatchGaebFillItems(
        input.runId,
        batchRows.map((row) => ({
          itemKey: row.itemKey,
          status: "classified" as const,
          classification: classified.get(row.itemKey) ?? null,
          incrementAttempts: !classified.has(row.itemKey),
        })),
      );
      await input.refreshCounts();
    },
  );
}

async function priceClassified(input: {
  runId: ObjectId;
  env: ReturnType<typeof aiEnv>;
  context: GaebTenderContext | null;
  currency: string;
  itemByKey: ReadonlyMap<string, GaebItem>;
  profileLines: string[];
  evidence: Map<string, DocumentFillEvidence>;
  webFindings: GaebWebPriceFinding[];
  stillAnalyzing: () => Promise<boolean>;
  refreshCounts: () => Promise<void>;
  warnings: string[];
}): Promise<void> {
  const rows = await listGaebFillItems(input.runId, { status: ["classified", "pending"] });
  if (rows.length === 0) return;

  const model = await getChatModel({
    role: "dora_gaeb_fill",
    maxOutputTokens: input.env.gaebFillMaxOutputTokens,
    temperature: 0,
  });
  const structured = model.withStructuredOutput(GAEB_PRICING_BATCH_JSON_SCHEMA as never, {
    name: "gaeb_pricing_batch",
  });

  await runPool(
    chunk(rows, input.env.gaebFillBatchSize),
    input.env.gaebFillBatchConcurrency,
    async (batchRows) => {
      if (!(await input.stillAnalyzing())) return;
      const batch = batchRows
        .map((row) => {
          const item = input.itemByKey.get(row.itemKey);
          return item ? { item, classification: row.classification } : null;
        })
        .filter((entry): entry is { item: GaebItem; classification: GaebFillClassification | null } =>
          Boolean(entry),
        );
      if (batch.length === 0) return;

      const prompt = buildGaebPricingPrompt({
        context: input.context,
        currency: input.currency,
        locale: SUGGESTION_LOCALE,
        profileLines: input.profileLines,
        batch,
        webFindings: input.webFindings,
        comparableLines: [],
      });

      const attempt = async () => {
        const raw = await structured.invoke(prompt);
        return gaebPricingBatchSchema.parse(raw);
      };
      try {
        let parsed: Awaited<ReturnType<typeof attempt>>;
        try {
          parsed = await attempt();
        } catch {
          parsed = await attempt();
        }
        const byKey = new Map(parsed.items.map((entry) => [entry.itemKey, entry]));
        await bulkPatchGaebFillItems(
          input.runId,
          batchRows.map((row) => {
            const entry = byKey.get(row.itemKey);
            if (!entry) {
              return {
                itemKey: row.itemKey,
                status: "failed" as const,
                error: "missing_from_batch",
                incrementAttempts: true,
              };
            }
            if (entry.unitPrice === null) {
              return {
                itemKey: row.itemKey,
                status: "skipped" as const,
                suggestion: null,
                error: "not_unit_priceable",
              };
            }
            return {
              itemKey: row.itemKey,
              status: "priced" as const,
              suggestion: toSuggestion(entry, input.evidence),
              error: null,
            };
          }),
        );
      } catch (error) {
        input.warnings.push(
          `pricing_batch_failed:${batchRows[0]?.batchIndex ?? "?"}:${
            error instanceof Error ? error.message.slice(0, 80) : "error"
          }`,
        );
        await bulkPatchGaebFillItems(
          input.runId,
          batchRows.map((row) => ({
            itemKey: row.itemKey,
            status: "failed" as const,
            error: "pricing_batch_failed",
            incrementAttempts: true,
          })),
        );
      }
      await input.refreshCounts();
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Deterministic post-processing                                              */
/* -------------------------------------------------------------------------- */

function toSuggestion(
  entry: {
    unitPrice: number | null;
    rangeLow: number;
    rangeHigh: number;
    confidence: number;
    assumptions: string[];
    risks: string[];
    evidenceReferences: string[];
    reason: string;
  },
  evidence: Map<string, DocumentFillEvidence>,
): GaebFillSuggestion {
  const unitPrice = round3(entry.unitPrice ?? 0);
  // The model proposes; the clamp decides. Ranges may not exclude the price.
  const rangeLow = round3(Math.min(entry.rangeLow > 0 ? entry.rangeLow : unitPrice, unitPrice));
  const rangeHigh = round3(Math.max(entry.rangeHigh > 0 ? entry.rangeHigh : unitPrice, unitPrice));
  // Citations resolve against the trust boundary; unknown keys vanish,
  // exactly like ../resolve.ts.
  const resolved = entry.evidenceReferences
    .map((reference) => evidence.get(reference) ?? evidence.get(`web:${reference}`))
    .filter((item): item is DocumentFillEvidence => Boolean(item));
  return {
    unitPrice,
    rangeLow,
    rangeHigh,
    confidence: Math.min(1, Math.max(0, entry.confidence)),
    assumptions: entry.assumptions,
    risks: entry.risks,
    evidence: resolved,
    reason: entry.reason,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function buildCategoryPaths(parsed: GaebDocument): Map<string, string> {
  const byKey = new Map(parsed.categories.map((category) => [category.key, category]));
  const pathOf = new Map<string, string>();
  for (const category of parsed.categories) {
    const labels: string[] = [];
    let key: string | null = category.key;
    const seen = new Set<string>();
    while (key && !seen.has(key)) {
      seen.add(key);
      const node = byKey.get(key);
      if (!node) break;
      if (node.label) labels.unshift(node.label);
      key = node.parentKey;
    }
    pathOf.set(category.key, labels.join(" > "));
  }
  const out = new Map<string, string>();
  for (const item of parsed.items) {
    out.set(item.key, pathOf.get(item.categoryKey) ?? "");
  }
  return out;
}

function rankProductMentions(rows: GaebFillItemDocument[]): string[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const row of rows) {
    for (const mention of row.classification?.productMentions ?? []) {
      const name = mention.trim();
      if (name.length < 3) continue;
      const key = name.toLowerCase();
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { name, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).map((entry) => entry.name);
}

/**
 * The few X84 document-level fields, grounded deterministically in the
 * company profile — no model involved for six address slots.
 */
function buildBidderMetaFields(
  parsed: GaebDocument,
  evidence: Map<string, DocumentFillEvidence>,
): DocumentFillField[] {
  const slots: Array<{
    key: "bidder.name" | "bidder.street" | "bidder.zip" | "bidder.city" | "bidder.contact" | "bidder.email";
    label: string;
    path: string;
    candidates: string[];
  }> = [
    { key: "bidder.name", label: "Bieter: Firma", path: "Award/CTR/Address/Name1", candidates: ["company.name", "company.companyName", "company.legalName"] },
    { key: "bidder.street", label: "Bieter: Straße", path: "Award/CTR/Address/Street", candidates: ["company.address.street", "company.street"] },
    { key: "bidder.zip", label: "Bieter: PLZ", path: "Award/CTR/Address/PCode", candidates: ["company.address.zip", "company.address.postalCode", "company.zip", "company.postalCode"] },
    { key: "bidder.city", label: "Bieter: Ort", path: "Award/CTR/Address/City", candidates: ["company.address.city", "company.city"] },
    { key: "bidder.contact", label: "Bieter: Ansprechpartner", path: "Award/CTR/Address/Contact", candidates: ["company.contactName", "company.contact.name"] },
    { key: "bidder.email", label: "Bieter: E-Mail", path: "Award/CTR/Address/Email", candidates: ["company.email", "company.contact.email", "company.contactEmail"] },
  ];

  return slots.map((slot) => {
    const hit = slot.candidates
      .map((candidate) => ({ candidate, evidence: evidence.get(candidate) }))
      .find((entry) => entry.evidence);
    const existing = existingBidderValue(parsed, slot.key);
    const value = existing ?? hit?.evidence?.excerpt ?? null;
    return {
      id: `gm:${slot.key}`,
      label: slot.label,
      description: "",
      required: slot.key === "bidder.name",
      sensitive: false,
      value,
      confidence: value ? 1 : 0,
      state: value ? "ready" : "missing",
      locator: { strategy: "gaeb_meta", nodeId: `gm:${slot.key}`, path: slot.path, key: slot.key },
      evidence: hit?.evidence && !existing ? [hit.evidence] : [],
      reason: existing ? "Bereits in der Datei vorhanden." : value ? "Aus dem Firmenprofil übernommen." : "",
      updatedBy: "ai",
    };
  });
}

function existingBidderValue(
  parsed: GaebDocument,
  key: "bidder.name" | "bidder.street" | "bidder.zip" | "bidder.city" | "bidder.contact" | "bidder.email",
): string | null {
  const bidder = parsed.meta.bidder;
  if (!bidder) return null;
  switch (key) {
    case "bidder.name":
      return bidder.name;
    case "bidder.street":
      return bidder.street;
    case "bidder.zip":
      return bidder.zip;
    case "bidder.city":
      return bidder.city;
    case "bidder.contact":
      return bidder.contact;
    case "bidder.email":
      return bidder.email;
  }
}
