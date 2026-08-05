/**
 * Outbox relay: watches `outbox_events` with a MongoDB change stream and publishes
 * majority-committed tender changes to the application over Redis pub/sub (§5.1).
 *
 * Run a single replica: a second one would duplicate every push without improving
 * durability, since the change stream already resumes from a stored token.
 *
 *   npm run worker:outbox
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { OutboxRelay } = await import("../lib/ingestion/outbox/relay.ts");
const { runWorker } = await import("../lib/ingestion/worker/runtime.ts");

const relay = new OutboxRelay();

await runWorker({
  name: "outbox-relay",
  run: (signal) => relay.start(signal),
  isHealthy: () => relay.isHealthy(),
  cleanup: () => relay.stop(),
});
