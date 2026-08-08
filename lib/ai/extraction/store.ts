import { createHash } from "node:crypto";

import type { ObjectId } from "mongodb";

import { getAiCollections } from "../db/collections.ts";
import { resolveRole } from "../gateway/config.ts";
import type { ExtractionDocument } from "../types.ts";
import type { ExtractionOutcome } from "./extractor.ts";
import { PROMPT_VERSION } from "./prompts.ts";

/**
 * Persistence for extraction records: one current record per
 * (tenderId, schemaName), replaced wholesale — derived artifacts are
 * reproducible, never patched in place.
 */

/**
 * Identity of the tender's chunked document corpus. Part of the extraction
 * idempotency key: when the user's document fetch adds a file and the sweep
 * chunks it, the hash changes, stale DONE ledger entries no longer match, and
 * the next extract request runs again.
 */
export async function computeCorpusHash(tenderId: ObjectId): Promise<string> {
  const { chunks } = await getAiCollections();
  const files = await chunks
    .aggregate<{ _id: { documentRecordId: string; fileSha256: string } }>([
      { $match: { tenderId } },
      { $group: { _id: { documentRecordId: "$documentRecordId", fileSha256: "$fileSha256" } } },
    ])
    .toArray();

  const identity = files
    .map((row) => `${row._id.documentRecordId}:${row._id.fileSha256}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(identity).digest("hex");
}

export async function saveExtraction(input: {
  tenderId: ObjectId;
  outcome: ExtractionOutcome;
  corpusHash: string;
}): Promise<void> {
  const { extractions } = await getAiCollections();
  const modelRef = resolveRole("extraction");
  const now = new Date();

  const record: Omit<ExtractionDocument, "_id" | "createdAt"> = {
    tenantId: null,
    tenderId: input.tenderId,
    schemaName: input.outcome.schemaName,
    schemaVersion: input.outcome.schemaVersion,
    model: {
      provider: modelRef.provider,
      providerModel: modelRef.model,
      promptVersion: PROMPT_VERSION,
      temperature: 0,
    },
    corpusHash: input.corpusHash,
    sourceDocumentRecordIds: input.outcome.sourceDocumentRecordIds,
    fields: input.outcome.fields,
    unresolved: input.outcome.unresolved,
    status: input.outcome.status,
    stats: input.outcome.stats,
    extractedAt: now,
    updatedAt: now,
  };

  await extractions.updateOne(
    { tenderId: input.tenderId, schemaName: input.outcome.schemaName },
    { $set: record, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
}

export async function getExtractions(
  tenderId: ObjectId,
  schemaName?: string,
): Promise<ExtractionDocument[]> {
  const { extractions } = await getAiCollections();
  const filter: Record<string, unknown> = { tenderId };
  if (schemaName) filter.schemaName = schemaName;
  return extractions.find(filter as never).sort({ schemaName: 1 }).toArray();
}
