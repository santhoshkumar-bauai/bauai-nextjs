import { getIngestionDb } from "../../ingestion/db/client.ts";
import { loadDocumentFile } from "../../ingestion/documents/store.ts";
import type {
  StoredDocumentFile,
  TenderDocumentRecord,
} from "../../ingestion/documents/types.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import { docChunkJobId } from "../queue/jobs.ts";
import type { ChunkDocument } from "../types.ts";
import { chunkText } from "./chunker.ts";

const log = logger.child("ai.doc-processor");

/**
 * Chunks every text-extracted file of one `tender_documents` record into the
 * global `chunks` collection (tenantId null — shared corpus).
 *
 * Idempotency (§10.3): per file, the `ai_index_state` row keyed by
 * `chunk:doc:{recordId}:{fileSha256}:{chunkerVersion}` is the ledger.
 * Re-chunking under the same identity is a delete+insert, so a crash mid-way
 * re-runs cleanly.
 *
 * Returns the sha256 of every file that produced chunks (the chunk-embed
 * stage takes over from there).
 */
export async function processDocumentChunks(
  documentRecordId: string,
): Promise<string[]> {
  const env = aiEnv();
  const db = await getIngestionDb();
  const records = db.collection<TenderDocumentRecord>("tender_documents");
  const { chunks, aiIndexState } = await getAiCollections();

  const record = await records.findOne({ _id: documentRecordId });
  if (!record) {
    log.warn("document record missing", { documentRecordId });
    return [];
  }

  const chunkedFiles: string[] = [];

  for (const file of record.files) {
    if (file.textStatus !== "DONE" || file.textChars === 0) continue;

    const stateId = docChunkJobId({
      documentRecordId,
      fileSha256: file.sha256,
      chunkerVersion: env.chunkerVersion,
    });

    const existing = await aiIndexState.findOne({ _id: stateId });
    if (existing?.status === "DONE") {
      chunkedFiles.push(file.sha256);
      continue;
    }

    await aiIndexState.updateOne(
      { _id: stateId },
      {
        $set: {
          kind: "doc_chunks",
          refId: documentRecordId,
          sourceHash: file.sha256,
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
      const text = await loadFileText(file);
      const rawChunks = chunkText(text, {
        targetTokens: env.chunkTargetTokens,
        maxTokens: env.chunkMaxTokens,
      });

      // Delete+insert under the same identity keeps re-runs clean (§6.4:
      // derived artefacts are reproducible, never patched in place).
      await chunks.deleteMany({
        documentRecordId,
        fileSha256: file.sha256,
        chunkerVersion: env.chunkerVersion,
      });

      if (rawChunks.length > 0) {
        const now = new Date();
        const rows: ChunkDocument[] = rawChunks.map((chunk) => ({
          tenantId: null,
          tenderId: record.tenderId,
          documentRecordId,
          fileSha256: file.sha256,
          fileName: file.fileName,
          mimeType: file.mimeType,
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
          // Embedding fields are filled by the chunk-embed stage.
          embedding: [],
          embeddingModel: "",
          embeddingVersion: "",
          embeddingDimensions: 0,
          sourceHash: "",
          createdAt: now,
        }));
        await chunks.insertMany(rows as never[], { ordered: false });
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
      chunkedFiles.push(file.sha256);
      log.info("chunked file", {
        documentRecordId,
        fileName: file.fileName,
        chunks: rawChunks.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await aiIndexState.updateOne(
        { _id: stateId },
        { $set: { status: "FAILED", error: message.slice(0, 500), updatedAt: new Date() } },
      );
      log.error("chunking failed", { documentRecordId, fileName: file.fileName, error: message });
    }
  }

  return chunkedFiles;
}

/** Full text from S3 when the Mongo copy is truncated; Mongo copy otherwise. */
async function loadFileText(file: StoredDocumentFile): Promise<string> {
  const truncated = file.text != null && file.text.length < file.textChars;
  if (!truncated && file.text != null) return file.text;
  if (file.textS3Key) {
    const buffer = await loadDocumentFile(file.s3.bucket, file.textS3Key);
    return buffer.toString("utf8");
  }
  return file.text ?? "";
}
