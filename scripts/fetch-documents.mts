/**
 * Downloads tender documents into S3 and extracts their text. No Redis, no Docker —
 * the work list lives in MongoDB, so this is the seed-side counterpart to
 * `workers/documents.mts`.
 *
 *   npm run fetch:documents                        # drain the queue
 *   npm run fetch:documents -- --limit 50
 *   npm run fetch:documents -- --host www.evergabe-online.de
 *   npm run fetch:documents -- --status            # coverage by host and outcome
 *   npm run fetch:documents -- --retry-failed
 *   npm run fetch:documents -- --backfill-rows      # rows for tenders seeded earlier
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const { closeIngestionClient } = await import("../lib/ingestion/db/client.ts");
const { assertS3Configured, ingestionEnv } = await import(
  "../lib/ingestion/config/env.ts"
);
const {
  ensureDocumentIndexes,
  documentStore,
  requeueNowBiddable,
  backfillDocumentRows,
} = await import("../lib/ingestion/documents/records.ts");
const { runDocumentFetch, emptyDocumentCounters, releaseStaleLeases } = await import(
  "../lib/ingestion/documents/runner.ts"
);
const { registeredPlatforms } = await import("../lib/ingestion/documents/registry.ts");
const { finishProcess } = await import("../lib/ingestion/utils/exit.ts");

const limitArg = flag("limit");
const limit = limitArg === null || limitArg === "0" ? null : Number.parseInt(limitArg, 10);
const concurrency = Number.parseInt(
  flag("concurrency") ?? String(ingestionEnv.documents.concurrency),
  10,
);
const host = flag("host") ?? undefined;

let exitCode = 0;

try {
  await ensureDocumentIndexes();

  if (has("status")) {
    await showStatus();
  } else if (has("retry-failed")) {
    await retryFailed();
  } else if (has("backfill-rows")) {
    const result = await backfillDocumentRows();
    console.log(
      `Scanned ${result.scanned} tender(s) with documents, created ${result.created} row(s).`,
    );
    await showStatus();
  } else {
    await fetchDocuments();
  }
} catch (error) {
  exitCode = 1;
  console.error(`\nDocument fetch failed: ${String(error)}`);
} finally {
  await closeIngestionClient();
}

finishProcess(exitCode);

async function fetchDocuments(): Promise<void> {
  assertS3Configured();

  const backfilled = await backfillDocumentRows();
  if (backfilled.created) {
    console.log(`Created ${backfilled.created} document row(s) for previously seeded tenders.`);
  }

  const promoted = await requeueNowBiddable();
  if (promoted) console.log(`Promoted ${promoted} document(s) whose tender became biddable.`);

  await releaseStaleLeases();

  const store = await documentStore();
  const pending = await store.countDocuments({
    status: "PENDING",
    ...(host ? { host } : {}),
  });

  console.log("Document fetch");
  console.log(`  pending      ${pending.toLocaleString()}`);
  console.log(`  limit        ${limit === null ? "drain queue" : limit.toLocaleString()}`);
  console.log(`  concurrency  ${concurrency}`);
  console.log(`  per host     ${ingestionEnv.documents.requestsPerMinutePerHost}/min, ${ingestionEnv.documents.maxConcurrentPerHost} parallel`);
  console.log(`  bucket       ${ingestionEnv.s3.bucket}/${ingestionEnv.documents.prefix}`);
  console.log(`  resolvers    ${registeredPlatforms().join(", ") || "generic only"}`);
  if (host) console.log(`  host filter  ${host}`);

  if (!pending) {
    console.log("\nNothing pending.");
    await showStatus();
    return;
  }

  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log("\nStopping after in-flight documents. Re-run to continue.");
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const counters = emptyDocumentCounters();
  const startedAt = Date.now();
  const progress = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `  [${elapsed}s] claimed ${counters.claimed} · fetched ${counters.fetched} ` +
        `· files ${counters.files} · fileFail ${counters.filesFailed} ` +
        `· skipped ${counters.skipped} · failed ${counters.failed} ` +
        `· ${(counters.bytes / 1_048_576).toFixed(1)} MiB`,
    );
  }, 15_000);

  console.log("\nFetching. Ctrl-C is safe.\n");

  await runDocumentFetch({
    limit,
    concurrency,
    host,
    signal: controller.signal,
    counters,
    // A CLI run finishes when the queue empties rather than idling like the worker.
    exitWhenDrained: true,
  });

  clearInterval(progress);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  console.log("\nFinished");
  console.log(`  claimed  ${counters.claimed.toLocaleString()}`);
  console.log(`  fetched  ${counters.fetched.toLocaleString()}`);
  console.log(`  files    ${counters.files.toLocaleString()}`);
  console.log(`  fileFail ${counters.filesFailed.toLocaleString()}  (individual files that failed)`);
  console.log(`  skipped  ${counters.skipped.toLocaleString()}`);
  console.log(`  failed   ${counters.failed.toLocaleString()}`);
  console.log(`  stored   ${(counters.bytes / 1_048_576).toFixed(1)} MiB`);

  await showStatus();
}

async function retryFailed(): Promise<void> {
  const store = await documentStore();
  const result = await store.updateMany(
    { status: "FAILED", ...(host ? { host } : {}) },
    {
      $set: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), error: null },
    },
  );
  console.log(`Requeued ${result.modifiedCount} failed document(s).`);
}

/**
 * Coverage by host. This is the report that shows which portals need a resolver
 * written and which need an account, ranked by how much volume they represent.
 */
async function showStatus(): Promise<void> {
  const store = await documentStore();

  const byStatus = await store
    .aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();

  const totals = await store
    .aggregate<{ _id: null; files: number; bytes: number; text: number }>([
      { $unwind: "$files" },
      {
        $group: {
          _id: null,
          files: { $sum: 1 },
          bytes: { $sum: "$files.byteLength" },
          text: { $sum: { $cond: [{ $eq: ["$files.textStatus", "DONE"] }, 1, 0] } },
        },
      },
    ])
    .toArray();

  console.log("\nDocument status");
  console.log(
    `  rows        ${byStatus.map((row) => `${row._id}=${row.count.toLocaleString()}`).join(" ") || "none"}`,
  );
  if (totals[0]) {
    console.log(
      `  files       ${totals[0].files.toLocaleString()} · ${(totals[0].bytes / 1_048_576).toFixed(1)} MiB · ${totals[0].text.toLocaleString()} with text`,
    );
  }

  const skips = await store
    .aggregate<{ _id: string; count: number }>([
      { $match: { skipReason: { $ne: null } } },
      { $group: { _id: "$skipReason", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  if (skips.length) {
    console.log(
      `  skips       ${skips.map((row) => `${row._id}=${row.count.toLocaleString()}`).join(" ")}`,
    );
  }

  // Per-file failures, which are invisible in the row status: a row with one good
  // file and four failures still reads FETCHED.
  const fileFailures = await store
    .aggregate<{ _id: string; count: number; retryable: number }>([
      { $unwind: "$failedFiles" },
      {
        $group: {
          _id: "$failedFiles.errorClass",
          count: { $sum: 1 },
          retryable: { $sum: { $cond: ["$failedFiles.retryable", 1, 0] } },
        },
      },
      { $sort: { count: -1 } },
    ])
    .toArray();

  if (fileFailures.length) {
    const total = fileFailures.reduce((sum, row) => sum + row.count, 0);
    console.log(`\n  File-level failures (${total} total, not visible in row status):`);
    for (const row of fileFailures) {
      console.log(
        `    ${String(row.count).padStart(5)}  ${row._id.padEnd(22)} ${row.retryable} retryable`,
      );
    }
  }

  const textFailures = await store
    .aggregate<{ _id: string; count: number }>([
      { $unwind: "$files" },
      { $match: { "files.textStatus": { $in: ["FAILED", "UNSUPPORTED"] } } },
      { $group: { _id: { $concat: ["$files.textStatus", ": ", { $ifNull: ["$files.textError", "no extractor"] }] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 6 },
    ])
    .toArray();

  if (textFailures.length) {
    console.log("\n  Text extraction gaps (file is stored; only its text is missing):");
    for (const row of textFailures) {
      console.log(`    ${String(row.count).padStart(5)}  ${row._id.slice(0, 70)}`);
    }
  }

  const hosts = await store
    .aggregate<{
      _id: string;
      total: number;
      fetched: number;
      pending: number;
      unsupported: number;
    }>([
      {
        $group: {
          _id: "$host",
          total: { $sum: 1 },
          fetched: { $sum: { $cond: [{ $eq: ["$status", "FETCHED"] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, 1, 0] } },
          unsupported: {
            $sum: { $cond: [{ $eq: ["$skipReason", "UNSUPPORTED_PLATFORM"] }, 1, 0] },
          },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 20 },
    ])
    .toArray();

  if (hosts.length) {
    console.log("\n  Top hosts (total / fetched / pending / needs-resolver)");
    for (const row of hosts) {
      console.log(
        `    ${String(row.total).padStart(5)} ${String(row.fetched).padStart(5)} ` +
          `${String(row.pending).padStart(5)} ${String(row.unsupported).padStart(5)}  ${row._id}`,
      );
    }
  }
}
