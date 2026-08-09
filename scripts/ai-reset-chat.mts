/**
 * Wipes ALL Clara chat and agent state: threads, messages, attachments (plus
 * their S3 objects), verdicts, and the LangGraph checkpoints. Everything else —
 * chunks, embeddings, extractions, classifications, overviews, fit
 * recommendations — is left alone, because re-deriving it costs hours of model
 * spend.
 *
 * The companion to `ai:bootstrap`: any change to the thread-key format, the
 * graph shape, or the checkpoint schema needs this same wipe.
 *
 *   npm run ai:reset:chat -- --dry-run
 *   npm run ai:reset:chat -- --yes
 *   npm run ai:reset:chat -- --yes --keep-s3 --no-recreate
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { aiCollectionNames } = await import("../lib/ai/db/collections.ts");
const { ensureAiIndexes } = await import("../lib/ai/db/indexes.ts");
const { ingestionEnv } = await import("../lib/ingestion/config/env.ts");
const { getIngestionDb, closeIngestionClient } = await import(
  "../lib/ingestion/db/client.ts"
);
const s3 = await import("../lib/storage/s3.ts");
const { deleteObject } = s3;
// An assertion signature can't survive a destructured dynamic import (TS2775),
// and here we only need it to throw — never to narrow anything.
const requireS3Config: () => void = s3.assertS3Configured;

const log = (message: string) => console.log(`[ai-reset-chat] ${message}`);

const confirmed = process.argv.includes("--yes");
const keepS3 = process.argv.includes("--keep-s3");
const recreate = !process.argv.includes("--no-recreate");
const allowRemote = process.argv.includes("--i-know-this-is-remote");

/**
 * The chat/agent slice of the AI subsystem. The first four are registry
 * entries; the two checkpoint collections are owned by MongoDBSaver and live
 * outside the registry — see lib/ai/agent/checkpointer.ts.
 */
const TARGETS = [
  aiCollectionNames.chatThreads,
  aiCollectionNames.chatMessages,
  aiCollectionNames.chatAttachments,
  aiCollectionNames.tenderVerdicts,
  "agent_checkpoints",
  "agent_checkpoint_writes",
] as const;

/** Hides the password before a URI ever reaches the console or a CI log. */
function redact(uri: string): string {
  return uri.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}

/**
 * Guard against wiping a shared cluster. `.env.local` keeps a commented-out
 * Atlas URI one character away from the active localhost one, so "the env said
 * so" is not a safe basis for a destructive drop.
 */
function assertLocalTarget(uri: string): void {
  if (allowRemote) {
    log("WARNING: --i-know-this-is-remote given; skipping the localhost guard");
    return;
  }
  const local = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const isLocal =
    !uri.startsWith("mongodb+srv:") &&
    uri
      .replace(/^mongodb:\/\//, "")
      .split("/")[0]!
      .split("@")
      .pop()!
      .split(",")
      .every((host) => local.has(host.split(":")[0]!.replace(/^\[|\]$/g, "")));
  if (!isLocal) {
    console.error(
      `[ai-reset-chat] Refusing to drop chat data on a non-local MongoDB: ${redact(uri)}\n` +
        "Pass --i-know-this-is-remote if that is genuinely what you want.",
    );
    process.exit(1);
  }
}

try {
  assertLocalTarget(ingestionEnv.mongoUri);
  const db = await getIngestionDb();

  log(`target: ${redact(ingestionEnv.mongoUri)} (db "${ingestionEnv.mongoDb}")`);
  let total = 0;
  for (const name of TARGETS) {
    const count = await db.collection(name).countDocuments();
    total += count;
    log(`  ${name}: ${count} document(s)`);
  }

  if (!confirmed) {
    log(`dry run — ${total} document(s) would be deleted. Re-run with --yes.`);
  } else {
    if (keepS3) {
      log("--keep-s3 given; leaving chat attachment objects in the bucket");
    } else {
      // Nothing else references these objects once the metadata rows are gone,
      // and there is no reaper — so they have to go first, while the keys are
      // still readable.
      try {
        requireS3Config();
        const cursor = db
          .collection(aiCollectionNames.chatAttachments)
          .find({ s3Key: { $ne: null } }, { projection: { s3Key: 1 } });
        let deleted = 0;
        let failed = 0;
        for await (const doc of cursor) {
          const key = (doc as { s3Key?: string }).s3Key;
          if (!key) continue;
          try {
            await deleteObject(key);
            deleted += 1;
          } catch (error) {
            failed += 1;
            log(`  failed to delete s3://${key}: ${(error as Error).message}`);
          }
        }
        log(`deleted ${deleted} attachment object(s) from S3 (${failed} failed)`);
      } catch (error) {
        log(`skipping S3 cleanup: ${(error as Error).message}`);
      }
    }

    for (const name of TARGETS) {
      try {
        await db.collection(name).drop();
        log(`dropped ${name}`);
      } catch (error) {
        // Idempotent: a collection that was never created is already in the
        // state we want.
        if ((error as { code?: number }).code === 26) log(`${name} did not exist`);
        else throw error;
      }
    }

    if (recreate) {
      // Not optional housekeeping: the chat_attachments TTL is the only thing
      // expiring unclaimed uploads, and agent_checkpoints.ix_thread is created
      // nowhere else.
      log("recreating collections and indexes");
      await ensureAiIndexes();
    } else {
      log("--no-recreate given; run `npm run ai:bootstrap` before using chat");
    }
    log("done");
  }
} finally {
  await closeIngestionClient();
}
