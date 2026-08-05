/**
 * Source scheduler: drives live discovery and nightly reconciliation for every
 * enabled source. Run exactly one replica per environment for predictable
 * intervals — leases make extra replicas safe, but they add nothing (§4.1).
 *
 *   npm run worker:scheduler
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

// Imported after env loading so `lib/ingestion/config/env.ts` sees the variables.
const { SourceScheduler } = await import("../lib/ingestion/scheduler/scheduler.ts");
const { runWorker } = await import("../lib/ingestion/worker/runtime.ts");

const scheduler = new SourceScheduler();

await runWorker({
  name: "scheduler",
  run: (signal) => scheduler.start(signal),
  isHealthy: () => scheduler.isHealthy(),
  cleanup: async () => {
    scheduler.stop();
    await scheduler.close();
  },
});
