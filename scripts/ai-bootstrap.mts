/**
 * AI subsystem bootstrap: creates the AI collections, their plain indexes, and
 * the Atlas Search / Vector Search indexes, then waits until they are
 * queryable. Idempotent — safe to run at every deploy.
 *
 *   npm run ai:bootstrap
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { ensureAiIndexes } = await import("../lib/ai/db/indexes.ts");
const { ensureAiSearchIndexes } = await import("../lib/ai/db/search-indexes.ts");
const { closeIngestionClient } = await import("../lib/ingestion/db/client.ts");

const log = (message: string) => console.log(`[ai-bootstrap] ${message}`);

try {
  log("ensuring collections and plain indexes");
  await ensureAiIndexes();
  log("ensuring search indexes");
  await ensureAiSearchIndexes({ log });
  log("done");
} finally {
  await closeIngestionClient();
}
