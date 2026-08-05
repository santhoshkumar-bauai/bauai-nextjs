/**
 * End-to-end smoke test for one source.
 *
 * Two modes:
 *   --adapter-only   exercise access, discovery, and parsing against the live
 *                    source with no MongoDB, Redis, or S3. Use this to verify an
 *                    adapter in isolation, or when infrastructure is not up yet.
 *   (default)        the full path: discover, enqueue, dequeue, fetch, parse,
 *                    store, and commit, then report what landed in MongoDB.
 *
 *   npm run ingestion:smoke -- --source DE_BUND --adapter-only
 *   npm run ingestion:smoke -- --source TED --limit 25
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const sourceArg = flag("source") ?? "DE_BUND";
const limit = Number.parseInt(flag("limit") ?? "10", 10);
const adapterOnly = process.argv.includes("--adapter-only");

const { hasAdapter, createAdapter } = await import("../lib/ingestion/sources/registry.ts");
if (!hasAdapter(sourceArg)) {
  console.error(`Unknown source ${sourceArg}. Known: DE_BUND, TED`);
  process.exit(1);
}

const { sourceDefaults } = await import("../lib/ingestion/config/source-defaults.ts");

if (adapterOnly) {
  await runAdapterOnly();
} else {
  await runFullPipeline();
}

/**
 * Verifies the adapter contract against the live source: access, discovery
 * identity, and parsing. Touches no infrastructure, so a failure here is
 * unambiguously the adapter or the source.
 */
async function runAdapterOnly(): Promise<void> {
  const defaults = sourceDefaults[sourceArg as keyof typeof sourceDefaults];
  if (!defaults) {
    console.error(`No default config for ${sourceArg}`);
    process.exit(1);
  }

  const adapter = createAdapter({
    _id: sourceArg as never,
    ...defaults,
    updatedAt: new Date(),
  });

  console.log(`\n== ${sourceArg}: access check ==`);
  const access = await adapter.checkAccess();
  console.log(access.reachable ? `[ok] ${access.detail}` : `[fail] ${access.detail}`);
  if (!access.reachable) process.exit(1);

  console.log(`\n== ${sourceArg}: live discovery (first ${limit} notices) ==`);
  const cursor = {
    source: sourceArg as never,
    mode: "live" as const,
    watermark: null,
    pageOrToken: null,
    lastOfficialId: null,
    windowFrom: null,
    windowTo: null,
    etag: null,
    lastModified: null,
  };

  const collected: Awaited<ReturnType<typeof adapter.fetch>>[] = [];
  const typeCounts = new Map<string, number>();
  const warningCounts = new Map<string, number>();
  const canonicalKeys = new Set<string>();
  let discovered = 0;
  let parsed = 0;
  let failed = 0;

  const { computeCanonicalKey } = await import("../lib/ingestion/pipeline/projection.ts");
  const { deriveStatusFromNotice } = await import("../lib/ingestion/pipeline/status.ts");

  outer: for await (const batch of adapter.discover(cursor)) {
    discovered += batch.notices.length;
    if (batch.archive) {
      console.log(
        `[ok] archive ${batch.archive.entryCount} entries, ${(batch.archive.byteLength / 1_048_576).toFixed(1)} MiB, sha256 ${batch.archive.checksum.slice(0, 16)}...`,
      );
    }

    for (const notice of batch.notices) {
      if (collected.length >= limit) break outer;

      try {
        const raw = await adapter.fetch(notice);
        const parsedNotice = await adapter.parse(raw, notice);
        collected.push(raw);
        parsed += 1;

        typeCounts.set(
          parsedNotice.notice.typeCode,
          (typeCounts.get(parsedNotice.notice.typeCode) ?? 0) + 1,
        );
        for (const warning of parsedNotice.processing.warnings) {
          const key = warning.split(":")[0];
          warningCounts.set(key, (warningCounts.get(key) ?? 0) + 1);
        }
        canonicalKeys.add(computeCanonicalKey(parsedNotice));

        if (collected.length <= 3) {
          console.log(
            `  - ${parsedNotice.notice.typeCode} / ${deriveStatusFromNotice(parsedNotice)} / ${
              parsedNotice.snapshot.countries.join(",") || "??"
            } / ${(parsedNotice.snapshot.title.original ?? "(no title)").slice(0, 70)}`,
          );
        }
      } catch (error) {
        failed += 1;
        console.error(`  ! ${notice.sourceNoticeId}: ${String(error).slice(0, 160)}`);
      }
    }
  }

  console.log(
    `\n[ok] discovered ${discovered}, parsed ${parsed}, failed ${failed}, distinct canonical keys ${canonicalKeys.size}`,
  );
  console.log(`     notice types: ${JSON.stringify(Object.fromEntries(typeCounts))}`);
  console.log(`     warnings:     ${JSON.stringify(Object.fromEntries(warningCounts))}`);

  if (failed) process.exit(1);
}

/** The real pipeline, including MongoDB, Redis, and S3. */
async function runFullPipeline(): Promise<void> {
  const { assertReplicaSet, closeIngestionClient } = await import(
    "../lib/ingestion/db/client.ts"
  );
  const { getCollections } = await import("../lib/ingestion/db/collections.ts");
  const { ensureIngestionIndexes } = await import("../lib/ingestion/db/indexes.ts");
  const { ensureRawStoreIndexes } = await import(
    "../lib/ingestion/storage/raw-payload-store.ts"
  );
  const { closeRedisConnections } = await import("../lib/ingestion/queue/client.ts");
  const { StreamQueue } = await import("../lib/ingestion/queue/stream-queue.ts");
  const { seedSourceConfigs, getSourceConfig } = await import(
    "../lib/ingestion/scheduler/source-configs.ts"
  );
  const { loadCheckpoint, toCursor } = await import(
    "../lib/ingestion/scheduler/checkpoints.ts"
  );
  const { runDiscovery } = await import("../lib/ingestion/scheduler/discovery.ts");
  const { startRun } = await import("../lib/ingestion/pipeline/runs.ts");
  const { processNoticeJob } = await import("../lib/ingestion/pipeline/process-notice.ts");

  const queue = new StreamQueue("smoke");

  try {
    await assertReplicaSet();
    console.log("[ok] MongoDB replica set reachable");

    await ensureIngestionIndexes();
    await ensureRawStoreIndexes();
    await seedSourceConfigs();

    const config = await getSourceConfig(sourceArg as never);
    if (!config) throw new Error(`No source config for ${sourceArg}`);

    const checkpoint = await loadCheckpoint(config._id, "live");
    const run = await startRun({
      source: config._id,
      mode: "live",
      parserVersion: config.parserVersion,
    });

    console.log(`\n== discovery: ${sourceArg} ==`);
    const outcome = await runDiscovery({
      config,
      mode: "live",
      cursor: toCursor(checkpoint, config.overlapSeconds),
      queue,
      targetQueue: "live",
      run,
    });
    await run.succeed({ httpStatus: outcome.httpStatus });
    console.log(
      `[ok] discovered ${outcome.discovered}, newly queued ${outcome.accepted}, unchanged=${outcome.unchanged}`,
    );

    console.log(`\n== processing up to ${limit} queued notices ==`);
    const counts = new Map<string, number>();
    let processed = 0;

    while (processed < limit) {
      const messages = await queue.reserve("live", Math.min(5, limit - processed), 2_000);
      if (!messages.length) break;

      for (const message of messages) {
        if (message.job.kind !== "notice") {
          await queue.ack(message.queue, message.id);
          continue;
        }
        const result = await processNoticeJob(message.job, config);
        counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
        await queue.ack(message.queue, message.id);
        processed += 1;
      }
    }

    console.log(`[ok] processed ${processed}: ${JSON.stringify(Object.fromEntries(counts))}`);

    const collections = await getCollections();
    const [notices, tenders, outbox, deadLetters] = await Promise.all([
      collections.tenderNotices.countDocuments(),
      collections.tenders.countDocuments(),
      collections.outboxEvents.countDocuments(),
      collections.deadLetterEvents.countDocuments(),
    ]);

    console.log(
      `\n[ok] tender_notices=${notices} tenders=${tenders} outbox_events=${outbox} dead_letters=${deadLetters}`,
    );

    const statuses = await collections.tenders
      .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { count: -1 } }])
      .toArray();
    console.log(`     statuses: ${JSON.stringify(statuses)}`);

    const sample = await collections.tenders.findOne({}, { sort: { updatedAt: -1 } });
    if (sample) {
      console.log(
        `     newest: ${sample.canonicalKey} [${sample.status}/${sample.businessCategory}] ${(sample.title ?? "").slice(0, 60)}`,
      );
    }
  } finally {
    await queue.close();
    await closeRedisConnections();
    await closeIngestionClient();
  }
}
