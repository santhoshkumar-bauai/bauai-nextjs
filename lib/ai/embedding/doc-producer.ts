import { getIngestionDb } from "../../ingestion/db/client.ts";
import type { TenderDocumentRecord } from "../../ingestion/documents/types.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { aiEnv } from "../config/env.ts";
import { processDocumentChunks } from "../chunking/doc-processor.ts";
import { getAiCollections } from "../db/collections.ts";
import { docChunkJobId } from "../queue/jobs.ts";
import { embedDocumentChunks } from "./chunk-embedder.ts";

const log = logger.child("ai.doc-producer");

const SWEEP_INTERVAL_MS = 30_000;
const SWEEP_BATCH = 25;

/**
 * Sweeps FETCHED `tender_documents` whose text-bearing files have no DONE
 * `ai_index_state` row yet, chunking and embedding them inline. Because the
 * user's documents worker keeps flipping records to FETCHED, this producer
 * continuously drains that backlog with no manual action (§14: acquisition
 * and indexing are decoupled through the ledger, not through job handoff).
 */
export async function sweepFetchedDocuments(signal: AbortSignal): Promise<void> {
  const env = aiEnv();
  const db = await getIngestionDb();
  const records = db.collection<TenderDocumentRecord>("tender_documents");
  const { aiIndexState } = await getAiCollections();

  while (!signal.aborted) {
    try {
      let processedAny = false;
      // Newest first: fresh fetches are the ones a user is waiting on.
      const cursor = records
        .find(
          { status: "FETCHED", "files.textStatus": "DONE" },
          { projection: { _id: 1, files: 1 }, sort: { updatedAt: -1 } },
        )
        .batchSize(SWEEP_BATCH * 4);

      let examined = 0;
      for await (const record of cursor) {
        if (signal.aborted) return;
        if (++examined > 2000) break; // bounded scan per sweep iteration

        const textFiles = record.files.filter(
          (file) => file.textStatus === "DONE" && file.textChars > 0,
        );
        if (textFiles.length === 0) continue;

        const stateIds = textFiles.map((file) =>
          docChunkJobId({
            documentRecordId: record._id,
            fileSha256: file.sha256,
            chunkerVersion: env.chunkerVersion,
          }),
        );
        const doneStates = await aiIndexState.countDocuments({
          _id: { $in: stateIds },
          status: "DONE",
        });
        if (doneStates === textFiles.length) continue;

        const chunkedFiles = await processDocumentChunks(record._id);
        for (const sha of chunkedFiles) {
          if (signal.aborted) return;
          await embedDocumentChunks(record._id, sha);
        }
        processedAny = true;
      }

      if (!processedAny) {
        await sleep(SWEEP_INTERVAL_MS, signal);
      }
    } catch (error) {
      log.error("document sweep failed", { error: String(error) });
      await sleep(SWEEP_INTERVAL_MS, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
