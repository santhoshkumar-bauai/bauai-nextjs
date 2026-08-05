/**
 * Dead-letter replay (§11.3). Selects by id, source, date range, parser version,
 * failure category, or ingestion run, and pushes the jobs back through the normal
 * idempotent pipeline — validation and unique indexes are never bypassed.
 *
 *   npm run ingestion:replay -- --source DE_BUND --error-class MALFORMED_PAYLOAD
 *   npm run ingestion:replay -- --parser-version eforms-de-1.0.0 --limit 100
 *   npm run ingestion:replay -- --id 66b1... --dry-run
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { closeIngestionClient } = await import("../lib/ingestion/db/client.ts");
const { closeRedisConnections } = await import("../lib/ingestion/queue/client.ts");
const { StreamQueue } = await import("../lib/ingestion/queue/stream-queue.ts");
const { findReplayableDeadLetters, markReplayStatus } = await import(
  "../lib/ingestion/pipeline/dead-letter.ts"
);
const { hasAdapter } = await import("../lib/ingestion/sources/registry.ts");

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function date(name: string): Date | undefined {
  const raw = flag(name);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    console.error(`--${name} is not a valid date: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

const rawSource = flag("source");
if (rawSource !== null && !hasAdapter(rawSource)) {
  console.error(`Unknown source ${rawSource}`);
  process.exit(1);
}
const sourceArg = rawSource === null ? undefined : rawSource;

const dryRun = process.argv.includes("--dry-run");
const queue = new StreamQueue("replay-cli");

try {
  const candidates = await findReplayableDeadLetters({
    id: flag("id") ?? undefined,
    source: sourceArg,
    from: date("from"),
    to: date("to"),
    parserVersion: flag("parser-version") ?? undefined,
    errorClass: flag("error-class") ?? undefined,
    runId: flag("run-id") ?? undefined,
    limit: flag("limit") ? Number.parseInt(flag("limit")!, 10) : undefined,
  });

  console.log(`Selected ${candidates.length} dead-letter record(s).`);
  const byClass = new Map<string, number>();
  for (const candidate of candidates) {
    byClass.set(candidate.errorClass, (byClass.get(candidate.errorClass) ?? 0) + 1);
  }
  for (const [errorClass, count] of byClass) {
    console.log(`  ${errorClass}: ${count}`);
  }

  if (dryRun) {
    console.log("\nDry run; nothing enqueued.");
  } else {
    const replayed: typeof candidates = [];

    for (const candidate of candidates) {
      const targetQueue = candidate.mode === "backfill" ? "backfill" : "reconciliation";

      // The dedupe key must be cleared or the replay would be dropped as a
      // duplicate of the delivery that originally failed.
      await queue.forget(targetQueue, candidate.jobKey);

      const job = {
        ...candidate.job,
        attempt: 0,
        // The staged payload is reattached so a parser fix can be validated
        // against the exact bytes that failed, without refetching the source.
        ...(candidate.job.kind === "notice" && candidate.rawPayload
          ? { stagedPayload: candidate.rawPayload }
          : {}),
      };

      if (await queue.enqueue(targetQueue, job)) replayed.push(candidate);
    }

    await markReplayStatus(
      replayed.map((candidate) => candidate._id),
      "REPLAYING",
    );
    console.log(`\nRe-enqueued ${replayed.length} job(s) for replay.`);
  }
} finally {
  await queue.close();
  await closeRedisConnections();
  await closeIngestionClient();
}
