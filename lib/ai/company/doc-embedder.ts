import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { extractText } from "../../ingestion/documents/text-extract.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { getObjectBuffer } from "../../storage/s3.ts";
import { chunkText } from "../chunking/chunker.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import { embedDocumentChunks } from "../embedding/chunk-embedder.ts";
import type { CompanyDocEmbedJob } from "../queue/jobs.ts";
import type { ChunkDocument } from "../types.ts";

const log = logger.child("ai.company-doc-embedder");

export function companyDocRecordId(companyFileId: string): string {
  return `company:${companyFileId}`;
}

/**
 * Native-driver view of the Mongoose `CompanyFile` model ("companyfiles"
 * collection). Worker code avoids Mongoose entirely — its CJS named exports
 * do not survive Node's strip-types ESM loader.
 */
export interface CompanyFileRow {
  _id: ObjectId;
  companyId: ObjectId;
  category: string;
  fileName: string;
  contentType: string;
  s3Key: string;
  size?: number;
  createdAt?: Date;
}

export async function getCompanyFilesCollection() {
  const db = await getIngestionDb();
  return db.collection<CompanyFileRow>("companyfiles");
}

/**
 * Text-extracts, chunks and embeds ONE company document as tenant-scoped
 * context (chunks with `tenantId` = the company, `tenderId` = null). The
 * company's own documents thereby become retrievable evidence for the fit
 * analysis — never visible to any other tenant (retrieval requires an exact
 * tenantId match on the company-corpus path).
 *
 * Ledger: `company:{fileId}:{sha256}:{chunkerVersion}` in ai_index_state —
 * replays are no-ops, re-uploads with new bytes re-process.
 */
export async function processCompanyDocEmbed(job: CompanyDocEmbedJob): Promise<void> {
  const env = aiEnv();
  const { chunks, aiIndexState } = await getAiCollections();

  const companyFiles = await getCompanyFilesCollection();
  const file = await companyFiles.findOne({
    _id: new ObjectId(job.companyFileId),
  });
  if (!file) {
    log.warn("company file gone, skipping", { companyFileId: job.companyFileId });
    return;
  }
  if (String(file.companyId) !== job.tenantId) {
    // A mismatched job can only come from a bug or a forged payload — refuse.
    throw new Error(
      `company file ${job.companyFileId} does not belong to tenant ${job.tenantId}`,
    );
  }

  const tenantId = new ObjectId(job.tenantId);
  const documentRecordId = companyDocRecordId(job.companyFileId);

  const bytes = await getObjectBuffer(file.s3Key);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  const stateId = `company:${job.companyFileId}:${fileSha256}:${env.chunkerVersion}`;

  const existing = await aiIndexState.findOne({ _id: stateId });
  if (existing?.status === "DONE") return;

  await aiIndexState.updateOne(
    { _id: stateId },
    {
      $set: {
        kind: "company_doc_embed",
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
    const extracted = await extractText(bytes, file.contentType, file.fileName);
    if (extracted.status !== "DONE" || extracted.text.trim().length === 0) {
      // Images/xlsx/etc. carry no extractable text — done, zero chunks.
      await chunks.deleteMany({ tenantId, documentRecordId });
      await aiIndexState.updateOne(
        { _id: stateId },
        { $set: { status: "DONE", chunkCount: 0, error: null, updatedAt: new Date() } },
      );
      log.info("company file has no extractable text", {
        companyFileId: job.companyFileId,
        contentType: file.contentType,
        extractStatus: extracted.status,
      });
      return;
    }

    const rawChunks = chunkText(extracted.text, {
      targetTokens: env.chunkTargetTokens,
      maxTokens: env.chunkMaxTokens,
    });

    // Replace any previous version of this file's chunks (re-upload case).
    await chunks.deleteMany({ tenantId, documentRecordId });

    if (rawChunks.length > 0) {
      const now = new Date();
      const rows: ChunkDocument[] = rawChunks.map((chunk) => ({
        tenantId,
        tenderId: null,
        documentRecordId,
        fileSha256,
        fileName: file.fileName,
        mimeType: file.contentType,
        docClass: null,
        language: null,
        sectionPath: chunk.sectionPath,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        legalRefs: chunk.legalRefs,
        anchor: {
          page: null,
          paragraph: null,
          bbox: null,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
        },
        tokenCount: chunk.tokenCount,
        chunkerVersion: env.chunkerVersion,
        embedding: [],
        embeddingModel: "",
        embeddingVersion: "",
        embeddingDimensions: 0,
        sourceHash: "",
        createdAt: now,
      }));
      await chunks.insertMany(rows as never[], { ordered: false });
      await embedDocumentChunks(documentRecordId, fileSha256);
    }

    await aiIndexState.updateOne(
      { _id: stateId },
      {
        $set: {
          status: "DONE",
          chunkCount: rawChunks.length,
          error: null,
          updatedAt: new Date(),
        },
      },
    );
    log.info("company document embedded", {
      companyFileId: job.companyFileId,
      chunks: rawChunks.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await aiIndexState.updateOne(
      { _id: stateId },
      { $set: { status: "FAILED", error: message.slice(0, 500), updatedAt: new Date() } },
    );
    throw error;
  }
}

export type CompanyDocEmbedStatus =
  | "indexed"
  | "failed"
  | "processing"
  | "not_indexed";

/**
 * Latest embedding-ledger status per company file, batched. A file can have
 * several ledger rows (one per content hash); the most recent one wins.
 * "not_indexed" covers both never-processed files and ones with no
 * extractable text (DONE with chunkCount 0).
 */
export async function getCompanyDocEmbedStatuses(
  companyFileIds: string[],
): Promise<Map<string, CompanyDocEmbedStatus>> {
  const statuses = new Map<string, CompanyDocEmbedStatus>(
    companyFileIds.map((id) => [id, "not_indexed" as const]),
  );
  if (companyFileIds.length === 0) return statuses;

  const { aiIndexState } = await getAiCollections();
  const rows = await aiIndexState
    .find({
      kind: "company_doc_embed",
      refId: { $in: companyFileIds.map(companyDocRecordId) },
    } as never)
    .sort({ updatedAt: 1 })
    .toArray();

  for (const row of rows as Array<{
    refId?: string;
    status?: string;
    chunkCount?: number | null;
  }>) {
    const fileId = row.refId?.slice("company:".length);
    if (!fileId || !statuses.has(fileId)) continue;
    // Ascending sort → the last row per file (latest updatedAt) sticks.
    if (row.status === "DONE") {
      statuses.set(fileId, (row.chunkCount ?? 0) > 0 ? "indexed" : "not_indexed");
    } else if (row.status === "FAILED") {
      statuses.set(fileId, "failed");
    } else if (row.status === "RUNNING") {
      statuses.set(fileId, "processing");
    }
  }
  return statuses;
}

/** Removes every AI artifact of a deleted company file. */
export async function deleteCompanyDocArtifacts(
  companyId: ObjectId,
  companyFileId: string,
): Promise<void> {
  const { chunks, aiIndexState } = await getAiCollections();
  const documentRecordId = companyDocRecordId(companyFileId);
  await chunks.deleteMany({ tenantId: companyId, documentRecordId });
  await aiIndexState.deleteMany({
    _id: { $regex: `^company:${companyFileId}:` },
  } as never);
}
