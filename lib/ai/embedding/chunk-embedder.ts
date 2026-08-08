import { createHash } from "node:crypto";

import type { AnyBulkWriteOperation } from "mongodb";

import { logger } from "../../ingestion/observability/logger.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import { getGateway } from "../gateway/index.ts";
import type { ChunkDocument } from "../types.ts";

const log = logger.child("ai.chunk-embedder");

/**
 * Embeds every not-yet-embedded chunk of one document file. The embedded text
 * is the chunk prefixed with its section path (§16.1: carry headings into the
 * embedded text — "3. Eignung > 3.2 Referenzen" disambiguates a bare list of
 * numbers). Chunks whose sourceHash already matches under the current model
 * and version are skipped, so replays and partial-failure re-runs are cheap.
 */
export async function embedDocumentChunks(
  documentRecordId: string,
  fileSha256: string,
): Promise<{ embedded: number; skipped: number }> {
  const env = aiEnv();
  const { chunks } = await getAiCollections();
  const gateway = getGateway();

  const rows = await chunks
    .find({
      documentRecordId,
      fileSha256,
      chunkerVersion: env.chunkerVersion,
    })
    .toArray();
  if (rows.length === 0) return { embedded: 0, skipped: 0 };

  const pending: Array<{ row: typeof rows[number]; embedText: string; hash: string }> = [];
  let skipped = 0;

  for (const row of rows) {
    const embedText = row.sectionPath.length
      ? `${row.sectionPath.join(" > ")}\n${row.text}`
      : row.text;
    const hash = createHash("sha256").update(embedText).digest("hex");
    if (
      row.sourceHash === hash &&
      row.embeddingModel === env.embeddingModel &&
      row.embeddingVersion === env.embeddingVersion &&
      row.embedding.length > 0
    ) {
      skipped += 1;
      continue;
    }
    pending.push({ row, embedText, hash });
  }

  if (pending.length === 0) return { embedded: 0, skipped };

  const embedded = await gateway.embed({
    texts: pending.map((item) => item.embedText),
    taskType: "RETRIEVAL_DOCUMENT",
  });

  const ops: AnyBulkWriteOperation<ChunkDocument>[] = pending.map(
    (item, index) => ({
      updateOne: {
        filter: { _id: item.row._id },
        update: {
          $set: {
            embedding: embedded.vectors[index],
            embeddingModel: embedded.model,
            embeddingVersion: embedded.version,
            embeddingDimensions: embedded.dimensions,
            sourceHash: item.hash,
          },
        },
      },
    }),
  );
  await chunks.bulkWrite(ops, { ordered: false });

  log.info("embedded chunks", {
    documentRecordId,
    fileSha256: fileSha256.slice(0, 12),
    embedded: pending.length,
    skipped,
  });
  return { embedded: pending.length, skipped };
}
