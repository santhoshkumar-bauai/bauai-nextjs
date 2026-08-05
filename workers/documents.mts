/**
 * Document worker: downloads tender documents into S3 and extracts their text.
 *
 * The work list is the `tender_documents` collection, filled by the writer inside the
 * same transaction that commits a tender. Scale horizontally — rows are claimed with
 * a lease, so replicas never collide.
 *
 *   npm run worker:documents
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { ingestionEnv, assertS3Configured } = await import(
  "../lib/ingestion/config/env.ts"
);
const { describeError, logger } = await import("../lib/ingestion/observability/logger.ts");
const { ensureDocumentIndexes, requeueNowBiddable } = await import(
  "../lib/ingestion/documents/records.ts"
);
const { runDocumentFetch, emptyDocumentCounters } = await import(
  "../lib/ingestion/documents/runner.ts"
);
const { sleep } = await import("../lib/ingestion/utils/time.ts");
const { runWorker } = await import("../lib/ingestion/worker/runtime.ts");

const log = logger.child("documents-worker");

let lastTickAt = Date.now();

await runWorker({
  name: "documents",
  // Reads and writes only its own collection and S3; no transactions involved.
  requiresReplicaSet: false,
  isHealthy: () => Date.now() - lastTickAt < ingestionEnv.documents.pollIntervalMs * 6,
  run: async (signal) => {
    assertS3Configured();
    await ensureDocumentIndexes();

    const counters = emptyDocumentCounters();

    // Promotes documents whose tender has since become biddable, so an UPCOMING
    // tender's documents are picked up once it opens.
    const promoter = (async () => {
      while (!signal.aborted) {
        try {
          const promoted = await requeueNowBiddable();
          if (promoted) log.info("promoted newly biddable documents", { promoted });
        } catch (error) {
          log.error("promotion sweep failed", describeError(error));
        }
        await sleep(5 * 60_000, signal);
      }
    })();

    const reporter = (async () => {
      while (!signal.aborted) {
        await sleep(60_000, signal);
        lastTickAt = Date.now();
        log.info("document progress", {
          claimed: counters.claimed,
          fetched: counters.fetched,
          files: counters.files,
          skipped: counters.skipped,
          failed: counters.failed,
          mib: Math.round(counters.bytes / 1_048_576),
        });
      }
    })();

    await runDocumentFetch({
      limit: null,
      concurrency: ingestionEnv.documents.concurrency,
      signal,
      counters,
      // Idles and polls rather than exiting, unlike the one-shot CLI.
      exitWhenDrained: false,
    });

    await Promise.allSettled([promoter, reporter]);
  },
});
