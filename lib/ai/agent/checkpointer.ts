import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";

import { getIngestionClient } from "../../ingestion/db/client.ts";
import { ingestionEnv } from "../../ingestion/config/env.ts";

/**
 * LangGraph checkpointer: serialized graph state (model-context memory) per
 * thread. The collections are global, but `thread_id` is ALWAYS derived
 * server-side (`dora:{tenantId}:{tenderId}` — see threads.ts), never accepted
 * from a client, so cross-tenant checkpoint access is inexpressible via the
 * API surface.
 */
let saver: MongoDBSaver | null = null;

export async function getDoraCheckpointer(): Promise<MongoDBSaver> {
  if (saver) return saver;
  const client = await getIngestionClient();
  saver = new MongoDBSaver({
    // The checkpoint package bundles its own mongodb type declarations that
    // lag the app's driver — runtime-compatible, type-incompatible (same
    // class of clash as BullMQ/ioredis).
    client: client as never,
    dbName: ingestionEnv.mongoDb,
    checkpointCollectionName: "agent_checkpoints",
    checkpointWritesCollectionName: "agent_checkpoint_writes",
  });
  return saver;
}
