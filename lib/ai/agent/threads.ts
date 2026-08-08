import type { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { getAiCollections } from "../db/collections.ts";
import type { ChatThreadDocument } from "../types.ts";

export const DORA_GRAPH_VERSION = "dora-chat-v1";

/** The LangGraph thread id — server-derived only, never client input. */
export function threadKey(tenantId: ObjectId, tenderId: ObjectId): string {
  return `dora:${tenantId.toHexString()}:${tenderId.toHexString()}`;
}

/** One thread per (tenant, tender, agent); upsert-and-return. */
export async function ensureThread(input: {
  tenantId: ObjectId;
  tenderId: ObjectId;
  userId: string;
}): Promise<ChatThreadDocument> {
  const { chatThreads } = await getAiCollections();
  const now = new Date();
  await chatThreads.updateOne(
    { tenantId: input.tenantId, tenderId: input.tenderId, agent: "dora" },
    {
      $setOnInsert: {
        tenantId: input.tenantId,
        tenderId: input.tenderId,
        agent: "dora",
        createdBy: input.userId,
        graphVersion: DORA_GRAPH_VERSION,
        lastMessageAt: now,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
  const thread = await chatThreads.findOne({
    tenantId: input.tenantId,
    tenderId: input.tenderId,
    agent: "dora",
  });
  return thread as ChatThreadDocument;
}

export async function bumpThread(
  tenantId: ObjectId,
  threadId: ObjectId,
  by: number,
): Promise<void> {
  const { chatThreads } = await getAiCollections();
  await chatThreads.updateOne(
    { _id: threadId, tenantId },
    { $set: { lastMessageAt: new Date(), updatedAt: new Date() }, $inc: { messageCount: by } },
  );
}

/** Full reset: messages, thread counters and LangGraph checkpoints. */
export async function clearThread(
  tenantId: ObjectId,
  tenderId: ObjectId,
): Promise<void> {
  const { chatThreads, chatMessages } = await getAiCollections();
  const thread = await chatThreads.findOne({ tenantId, tenderId, agent: "dora" });
  if (!thread?._id) return;
  await chatMessages.deleteMany({ tenantId, threadId: thread._id });
  await chatThreads.updateOne(
    { _id: thread._id, tenantId },
    { $set: { messageCount: 0, updatedAt: new Date() } },
  );

  const db = await getIngestionDb();
  const key = threadKey(tenantId, tenderId);
  await db.collection("agent_checkpoints").deleteMany({ thread_id: key });
  await db.collection("agent_checkpoint_writes").deleteMany({ thread_id: key });
}
