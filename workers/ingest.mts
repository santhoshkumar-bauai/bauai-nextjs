/**
 * Ingest worker: fetches, parses, and persists notices from the durable queues.
 * Scale this deployment horizontally; leases and idempotent writes make replicas
 * safe (§5.1).
 *
 *   npm run worker:ingest
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { IngestWorker } = await import("../lib/ingestion/worker/ingest-worker.ts");
const { runWorker } = await import("../lib/ingestion/worker/runtime.ts");

const worker = new IngestWorker();

await runWorker({
  name: "ingest",
  run: (signal) => worker.start(signal),
  isHealthy: () => worker.isHealthy(),
  cleanup: async () => {
    worker.stop();
    await worker.close();
  },
});
