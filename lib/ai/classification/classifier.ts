import { getIngestionDb } from "../../ingestion/db/client.ts";
import type { TenderDocumentRecord } from "../../ingestion/documents/types.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import type { DocumentClassificationDocument } from "../types.ts";
import { classifyByHeuristics } from "./heuristics.ts";
import { classifyWithModel } from "./llm-classifier.ts";

const log = logger.child("ai.classifier");

export function classificationStateId(
  documentRecordId: string,
  fileSha256: string,
  classifierVersion: string,
): string {
  return `class:doc:${documentRecordId}:${fileSha256}:${classifierVersion}`;
}

export interface ClassifyOptions {
  /** Skip the LLM fallback (heuristics-only dry runs for the backfill). */
  allowModel?: boolean;
}

/**
 * Classifies one file of a tender_documents record: heuristics first, LLM
 * fallback, then stamps `docClass` onto the file's chunks and records the
 * decision. Idempotent via the `ai_index_state` ledger; re-classification
 * happens by bumping CLASSIFIER_VERSION.
 */
export async function classifyDocumentFile(
  documentRecordId: string,
  fileSha256: string,
  options: ClassifyOptions = {},
): Promise<DocumentClassificationDocument | null> {
  const env = aiEnv();
  const allowModel = options.allowModel ?? true;
  const db = await getIngestionDb();
  const records = db.collection<TenderDocumentRecord>("tender_documents");
  const { chunks, aiIndexState, documentClassifications } = await getAiCollections();

  const stateId = classificationStateId(
    documentRecordId,
    fileSha256,
    env.classifierVersion,
  );
  const existingState = await aiIndexState.findOne({ _id: stateId });
  if (existingState?.status === "DONE") {
    return documentClassifications.findOne({
      _id: `${documentRecordId}#${fileSha256}`,
    });
  }

  const record = await records.findOne({ _id: documentRecordId });
  const file = record?.files.find((f) => f.sha256 === fileSha256);
  if (!record || !file) {
    log.warn("file not found for classification", { documentRecordId, fileSha256 });
    return null;
  }

  await aiIndexState.updateOne(
    { _id: stateId },
    {
      $set: {
        kind: "doc_class",
        refId: documentRecordId,
        sourceHash: fileSha256,
        status: "RUNNING",
        error: null,
        updatedAt: new Date(),
      },
      $inc: { attempts: 1 },
      $setOnInsert: { chunkCount: null },
    },
    { upsert: true },
  );

  try {
    const firstPageText = file.text?.slice(0, 3000) ?? "";
    const heuristic = classifyByHeuristics({
      fileName: file.fileName,
      firstPageText,
    });

    let docClass: DocumentClassificationDocument["docClass"];
    let confidence: number;
    let method: "heuristic" | "llm";
    let source: string;

    if (heuristic) {
      ({ docClass, confidence } = heuristic);
      method = "heuristic";
      source = heuristic.rule;
    } else if (allowModel) {
      const llm = await classifyWithModel({
        fileName: file.fileName,
        excerpt: firstPageText,
      });
      docClass = llm.docClass;
      confidence = llm.confidence;
      method = "llm";
      source = llm.model;
    } else {
      // Dry mode: leave unclassified rather than recording a guess.
      await aiIndexState.deleteOne({ _id: stateId });
      return null;
    }

    const now = new Date();
    const classification: DocumentClassificationDocument = {
      _id: `${documentRecordId}#${fileSha256}`,
      tenderId: record.tenderId,
      documentRecordId,
      fileSha256,
      fileName: file.fileName,
      docClass,
      confidence,
      method,
      source,
      classifierVersion: env.classifierVersion,
      createdAt: now,
      updatedAt: now,
    };

    const { createdAt, ...updatable } = classification;
    await documentClassifications.updateOne(
      { _id: classification._id },
      { $set: updatable, $setOnInsert: { createdAt } },
      { upsert: true },
    );
    await chunks.updateMany(
      { documentRecordId, fileSha256 },
      { $set: { docClass } },
    );
    await aiIndexState.updateOne(
      { _id: stateId },
      { $set: { status: "DONE", error: null, updatedAt: new Date() } },
    );

    return classification;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await aiIndexState.updateOne(
      { _id: stateId },
      { $set: { status: "FAILED", error: message.slice(0, 500), updatedAt: new Date() } },
    );
    log.error("classification failed", { documentRecordId, fileSha256, error: message });
    throw error;
  }
}
