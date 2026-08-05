import { MongoClient, type Db } from "mongodb";

import { ingestionEnv } from "../config/env.ts";

/**
 * Workers are long-lived processes, not serverless invocations, so they own a
 * single pooled client for the process lifetime instead of the `globalThis`
 * cache used by `lib/db/mongodb.ts`.
 */
let client: MongoClient | null = null;
let connecting: Promise<MongoClient> | null = null;

export async function getIngestionClient(): Promise<MongoClient> {
  if (client) return client;

  connecting ??= new MongoClient(ingestionEnv.mongoUri, {
    // The writer relies on transactions and the relay on change streams, so a
    // majority write concern is a deployment requirement, not a preference (§6.1).
    writeConcern: { w: "majority" },
    readConcern: { level: "majority" },
    retryWrites: true,
    maxPoolSize: Math.max(16, ingestionEnv.worker.concurrency * 2),
    appName: `bauai-ingestion/${ingestionEnv.workerId}`,
  }).connect();

  try {
    client = await connecting;
  } catch (error) {
    connecting = null;
    throw error;
  }

  return client;
}

export async function getIngestionDb(): Promise<Db> {
  const connected = await getIngestionClient();
  return connected.db(ingestionEnv.mongoDb);
}

export async function closeIngestionClient(): Promise<void> {
  if (!client) return;
  const closing = client;
  client = null;
  connecting = null;
  await closing.close();
}

/**
 * Transactions and change streams both require a replica set. Failing loudly at
 * startup is far cheaper than discovering it on the first commit.
 */
export async function assertReplicaSet(): Promise<void> {
  const connected = await getIngestionClient();
  const info = await connected.db("admin").command({ hello: 1 });
  if (!info.setName && !info.msg) {
    throw new Error(
      "MongoDB is running as a standalone. Ingestion requires a replica set or sharded cluster for transactions and change streams.",
    );
  }
}
