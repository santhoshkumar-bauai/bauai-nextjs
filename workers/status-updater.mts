/**
 * Status updater: moves tenders into CLOSING_SOON and CLOSED as deadlines pass.
 * Updates status only and never redownloads a notice (§7).
 *
 *   npm run worker:status
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { ingestionEnv } = await import("../lib/ingestion/config/env.ts");
const { logger, describeError } = await import("../lib/ingestion/observability/logger.ts");
const { updateExpiredStatuses } = await import(
  "../lib/ingestion/pipeline/status-updater.ts"
);
const { pruneDeliveredOutboxEvents } = await import("../lib/ingestion/outbox/relay.ts");
const { sleep } = await import("../lib/ingestion/utils/time.ts");
const { runWorker } = await import("../lib/ingestion/worker/runtime.ts");

const log = logger.child("status-worker");

let lastSweepAt = Date.now();
let sweeps = 0;

await runWorker({
  name: "status-updater",
  isHealthy: () => Date.now() - lastSweepAt < ingestionEnv.status.intervalMs * 3,
  run: async (signal) => {
    while (!signal.aborted) {
      try {
        const result = await updateExpiredStatuses();
        lastSweepAt = Date.now();
        sweeps += 1;

        // Outbox pruning is cheap and shares this worker's slow cadence rather
        // than needing a process of its own.
        if (sweeps % 12 === 0) {
          const pruned = await pruneDeliveredOutboxEvents();
          if (pruned) log.info("pruned delivered outbox events", { pruned });
        }

        if (result.changed) log.info("status sweep", result);
      } catch (error) {
        log.error("status sweep failed", describeError(error));
      }
      await sleep(ingestionEnv.status.intervalMs, signal);
    }
  },
});
