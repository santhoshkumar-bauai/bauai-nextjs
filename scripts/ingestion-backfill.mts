/**
 * Enqueues historical backfill partitions on the low-priority queue (§9).
 *
 * Live discovery should already be running so nothing published during the seed is
 * missed — that ordering is a requirement of the seed workflow, not a preference.
 *
 *   npm run ingestion:backfill -- --source DE_BUND
 *   npm run ingestion:backfill -- --source TED --months 6
 *   npm run ingestion:backfill -- --source DE_BUND --dry-run
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { closeIngestionClient } = await import("../lib/ingestion/db/client.ts");
const { closeRedisConnections } = await import("../lib/ingestion/queue/client.ts");
const { StreamQueue } = await import("../lib/ingestion/queue/stream-queue.ts");
const { enqueueBackfill, planBackfillPartitions } = await import(
  "../lib/ingestion/scheduler/backfill.ts"
);
const { getSourceConfig } = await import("../lib/ingestion/scheduler/source-configs.ts");
const { hasAdapter } = await import("../lib/ingestion/sources/registry.ts");

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const sourceArg = flag("source");
const monthsArg = flag("months");
const dryRun = process.argv.includes("--dry-run");

if (!sourceArg || !hasAdapter(sourceArg)) {
  console.error(
    `Usage: npm run ingestion:backfill -- --source <DE_BUND|TED> [--months N] [--dry-run]`,
  );
  process.exit(1);
}

const queue = new StreamQueue("backfill-cli");

try {
  const config = await getSourceConfig(sourceArg);
  if (!config) {
    console.error(`No source config for ${sourceArg}. Run ingestion:bootstrap first.`);
    process.exit(1);
  }

  const horizonMonths = monthsArg ? Number.parseInt(monthsArg, 10) : undefined;
  const partitions = planBackfillPartitions(config, { horizonMonths });

  console.log(
    `Planned ${partitions.length} partitions for ${sourceArg} (horizon ${horizonMonths ?? config.backfillHorizonMonths} months).`,
  );
  console.log(`  newest: ${partitions[0]?.label}`);
  console.log(`  oldest: ${partitions.at(-1)?.label}`);

  if (dryRun) {
    console.log("\nDry run; nothing enqueued.");
  } else {
    const result = await enqueueBackfill(queue, partitions);
    console.log(
      `\nEnqueued ${result.enqueued} partitions (${result.duplicates} already queued or recently processed).`,
    );
  }
} finally {
  await queue.close();
  await closeRedisConnections();
  await closeIngestionClient();
}
