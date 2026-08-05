/**
 * Seeds historical tenders straight into MongoDB. No Redis, no Docker.
 *
 * Defaults to everything published in 2026 from every enabled source. Resumable:
 * progress is recorded per month partition, so Ctrl-C and re-run continues where it
 * stopped. Idempotent: re-running never creates a duplicate tender.
 *
 *   npm run seed:tenders                        # all of 2026, all sources
 *   npm run seed:tenders -- --dry-run           # show the plan and real volumes
 *   npm run seed:tenders -- --limit 2026        # stop after 2026 notices
 *   npm run seed:tenders -- --source DE_BUND    # one source
 *   npm run seed:tenders -- --from 2026-06-01 --to 2026-08-01
 *   npm run seed:tenders -- --concurrency 16 --rate 60
 *   npm run seed:tenders -- --status            # progress of a previous run
 *   npm run seed:tenders -- --reset             # clear progress, keep tenders
 */
import nextEnv from "@next/env";

// Type-only, so it is erased and cannot read env before loadEnvConfig runs. Every
// runtime import below is deliberately dynamic for that reason.
import type { TenderSourceCode } from "../lib/ingestion/types.ts";

nextEnv.loadEnvConfig(process.cwd());

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseDate(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    console.error(`Invalid date: ${value}. Use YYYY-MM-DD.`);
    process.exit(1);
  }
  return parsed;
}

const { assertReplicaSet, closeIngestionClient } = await import(
  "../lib/ingestion/db/client.ts"
);
const { getCollections } = await import("../lib/ingestion/db/collections.ts");
const { ensureIngestionIndexes } = await import("../lib/ingestion/db/indexes.ts");
const { assertS3Configured, ingestionEnv } = await import(
  "../lib/ingestion/config/env.ts"
);
const { ensureRawStoreIndexes } = await import(
  "../lib/ingestion/storage/raw-payload-store.ts"
);
const { seedSourceConfigs, loadEnabledConfigs } = await import(
  "../lib/ingestion/scheduler/source-configs.ts"
);
const { hasAdapter, createAdapter } = await import("../lib/ingestion/sources/registry.ts");
const { runSeed } = await import("../lib/ingestion/seed/seed-runner.ts");
const {
  ensureSeedIndexes,
  partitionProgress,
  planMonthPartitions,
  resetPartitions,
  partitionStore,
} = await import("../lib/ingestion/seed/partitions.ts");
const { finishProcess } = await import("../lib/ingestion/utils/exit.ts");

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

const year = Number.parseInt(flag("year") ?? "2026", 10);
const from = parseDate(flag("from"), new Date(Date.UTC(year, 0, 1)));
// Exclusive upper bound. Defaults to tomorrow so today's partial month is included.
const to = parseDate(
  flag("to"),
  new Date(Math.min(Date.UTC(year + 1, 0, 1), Date.now() + 86_400_000)),
);

const rawLimit = flag("limit");
// `--limit 0` and no flag both mean uncapped; any positive value caps the run.
const limit = rawLimit === null || rawLimit === "0" ? null : Number.parseInt(rawLimit, 10);
const concurrency = Number.parseInt(flag("concurrency") ?? "8", 10);
const rateOverride = flag("rate") ? Number.parseInt(flag("rate")!, 10) : null;
const dryRun = has("dry-run");
const statusOnly = has("status");
const doReset = has("reset");

const rawSource = flag("source");
if (rawSource !== null && !hasAdapter(rawSource)) {
  console.error(`Unknown source ${rawSource}. Known: DE_BUND, TED`);
  process.exit(1);
}
const sourceArg = rawSource === null ? undefined : rawSource;

let exitCode = 0;

try {
  if (statusOnly) {
    await showStatus();
  } else if (doReset) {
    await ensureSeedIndexes();
    const removed = await resetPartitions(sourceArg);
    console.log(`Cleared progress for ${removed} partition(s). Tenders were not deleted.`);
  } else {
    await seed();
  }
} catch (error) {
  exitCode = 1;
  console.error(`\nSeed failed: ${String(error)}`);
} finally {
  await closeIngestionClient();
}

finishProcess(exitCode);

/* -------------------------------------------------------------------------- */

async function seed(): Promise<void> {
  await assertReplicaSet().catch((error) => {
    console.error(
      `\n${String(error)}\n\n` +
        "The writer needs a replica set for transactions and change streams.\n" +
        "Without Docker, start a single-node set with:\n\n" +
        "  npm run mongo:dev\n\n" +
        "then point MONGODB_URI at it, for example:\n" +
        "  MONGODB_URI=mongodb://127.0.0.1:27017/bauai?replicaSet=rs0&directConnection=true\n",
    );
    process.exit(1);
  });

  assertS3Configured();
  await ensureIngestionIndexes();
  await ensureRawStoreIndexes();
  await ensureSeedIndexes();
  await seedSourceConfigs();

  const configs = await loadEnabledConfigs();
  const sources = (sourceArg ? configs.filter((c) => c._id === sourceArg) : configs).map(
    (c) => c._id,
  );

  if (!sources.length) {
    console.error("No enabled sources with a registered adapter. Nothing to seed.");
    process.exit(1);
  }

  console.log("Seed plan");
  console.log(`  window      ${from.toISOString().slice(0, 10)} .. ${to.toISOString().slice(0, 10)} (exclusive)`);
  console.log(`  sources     ${sources.join(", ")}`);
  console.log(`  limit       ${limit === null ? "uncapped" : limit.toLocaleString()}`);
  console.log(`  concurrency ${concurrency}`);
  console.log(`  database    ${ingestionEnv.mongoDb}`);
  console.log(`  raw store   ${ingestionEnv.s3.bucket}/${ingestionEnv.s3.prefix}`);

  const estimate = await estimateVolume(sources);
  if (estimate.total !== null) {
    console.log(`  volume      ~${estimate.total.toLocaleString()} notices (measured where the source reports it)`);
  }
  for (const line of estimate.lines) console.log(`              ${line}`);

  if (dryRun) {
    console.log("\nDry run; nothing written.");
    return;
  }

  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log("\nStopping after in-flight notices. Re-run to resume.");
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.log("\nSeeding. Progress every 15s; Ctrl-C is safe.\n");

  // Read from the runner's own counters. Counting documents cannot separate this
  // run's work from an earlier seed, and would report a bogus rate on resume.
  const live = {
    discovered: 0,
    processed: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
  };

  const startedAt = Date.now();
  let lastProcessed = 0;
  const progress = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    const rate = (live.processed - lastProcessed) / 15;
    lastProcessed = live.processed;

    // An ETA is only honest when every selected source reported its volume;
    // Germany does not, so the remaining count would be unknowable.
    const eta =
      estimate.complete && estimate.total !== null && rate > 0
        ? ` eta ${formatDuration(((estimate.total - live.processed) / rate) * 1000)}`
        : "";

    console.log(
      `  [${formatDuration(elapsedMs)}] processed ${live.processed.toLocaleString()}` +
        ` · new ${live.inserted.toLocaleString()}` +
        ` · seen ${live.unchanged.toLocaleString()}` +
        ` · failed ${live.failed.toLocaleString()}` +
        ` · ${rate.toFixed(1)}/s${eta}`,
    );
  }, 15_000);

  const result = await runSeed({
    sources,
    from,
    to,
    limit,
    concurrency,
    rateLimitPerMinute: rateOverride,
    signal: controller.signal,
    counters: live,
  });

  clearInterval(progress);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  const elapsedMs = result.finishedAt.getTime() - result.startedAt.getTime();
  console.log("\nSeed finished");
  console.log(`  elapsed     ${formatDuration(elapsedMs)}`);
  console.log(`  discovered  ${result.discovered.toLocaleString()}`);
  console.log(`  inserted    ${result.inserted.toLocaleString()}`);
  console.log(`  updated     ${result.updated.toLocaleString()}`);
  console.log(`  unchanged   ${result.unchanged.toLocaleString()}`);
  console.log(`  failed      ${result.failed.toLocaleString()}`);
  console.log(
    `  partitions  ${result.partitionsCompleted} done, ${result.partitionsFailed} failed, ${result.partitionsSkipped} already done`,
  );

  if (result.stoppedEarly) {
    console.log("\nStopped early. Re-run the same command to resume.");
  }
  if (result.failed) {
    console.log(
      `\n${result.failed} notice(s) were dead-lettered. Inspect with:\n` +
        "  npm run ingestion:replay -- --dry-run",
    );
  }

  await showStatus();
}

/**
 * Real volumes where the source reports them. TED returns `totalNoticeCount` for a
 * query, so its months are exact; Germany only reveals its count by downloading the
 * archive, so it is left unknown rather than guessed at.
 */
async function estimateVolume(
  sources: TenderSourceCode[],
): Promise<{ total: number | null; complete: boolean; lines: string[] }> {
  const lines: string[] = [];
  let total: number | null = null;
  // False as soon as one source cannot report its volume, which disables the ETA.
  let complete = true;

  for (const source of sources) {
    const partitions = planMonthPartitions(source, from, to);

    if (source !== "TED") {
      complete = false;
      lines.push(
        `${source}: ${partitions.length} monthly archive(s) — count known only after download`,
      );
      continue;
    }

    const configs = await loadEnabledConfigs();
    const config = configs.find((c) => c._id === source);
    if (!config) continue;

    const adapter = createAdapter(config);
    // `checkAccess` doubles as a reachability probe before a multi-hour run.
    const access = await adapter.checkAccess();
    if (!access.reachable) {
      complete = false;
      lines.push(`${source}: UNREACHABLE — ${access.detail}`);
      continue;
    }

    let sourceTotal = 0;
    const perMonth: string[] = [];
    for (const partition of partitions) {
      const count = await countTedPartition(partition.windowFrom, partition.windowTo);
      sourceTotal += count;
      perMonth.push(`${partition.label}=${count.toLocaleString()}`);
    }
    total = (total ?? 0) + sourceTotal;
    lines.push(`${source}: ${sourceTotal.toLocaleString()} notices (${perMonth.join(" ")})`);
  }

  return { total, complete, lines };
}

async function countTedPartition(windowFrom: Date, windowTo: Date): Promise<number> {
  const compact = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, "");

  // Mirrors the adapter exactly: `windowTo` is exclusive, TED's `<=` is inclusive.
  // Without this the estimate counts each month-boundary day twice and reports a
  // total the seed will never reach.
  const inclusiveTo = new Date(windowTo.getTime() - 86_400_000);
  const upperBound = inclusiveTo.getTime() < windowFrom.getTime() ? windowFrom : inclusiveTo;

  const response = await fetch("https://api.ted.europa.eu/v3/notices/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `publication-date>=${compact(windowFrom)} AND publication-date<=${compact(upperBound)}`,
      fields: ["publication-number"],
      limit: 1,
      paginationMode: "ITERATION",
    }),
  });
  if (!response.ok) return 0;
  const data = (await response.json()) as { totalNoticeCount?: number };
  return data.totalNoticeCount ?? 0;
}

async function showStatus(): Promise<void> {
  await ensureSeedIndexes();
  const summary = await partitionProgress();
  const store = await partitionStore();
  const collections = await getCollections();

  const [notices, tenders, deadLetters] = await Promise.all([
    collections.tenderNotices.estimatedDocumentCount(),
    collections.tenders.estimatedDocumentCount(),
    collections.deadLetterEvents.countDocuments({ replayStatus: "PENDING" }),
  ]);

  console.log("\nSeed status");
  console.log(
    `  partitions  ${summary.DONE} done · ${summary.RUNNING} running · ${summary.PENDING} pending · ${summary.FAILED} failed`,
  );
  console.log(`  notices     ${notices.toLocaleString()}`);
  console.log(`  tenders     ${tenders.toLocaleString()}`);
  console.log(`  dead letters ${deadLetters.toLocaleString()}`);

  const failed = await store.find({ status: "FAILED" }).limit(10).toArray();
  for (const partition of failed) {
    console.log(`  ! ${partition._id}: ${(partition.error ?? "").slice(0, 120)}`);
  }

  const byStatus = await collections.tenders
    .aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  if (byStatus.length) {
    console.log(
      `  statuses    ${byStatus.map((row) => `${row._id}=${row.count.toLocaleString()}`).join(" ")}`,
    );
  }

  const byCategory = await collections.tenders
    .aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$businessCategory", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  if (byCategory.length) {
    console.log(
      `  categories  ${byCategory.map((row) => `${row._id}=${row.count.toLocaleString()}`).join(" ")}`,
    );
  }

  const months = await collections.tenders
    .aggregate<{ _id: string; count: number }>([
      { $match: { publicationDate: { $ne: null } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$publicationDate" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  if (months.length) {
    console.log(
      `  by month    ${months.map((row) => `${row._id}=${row.count.toLocaleString()}`).join(" ")}`,
    );
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}
