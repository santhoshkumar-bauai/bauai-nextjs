import type { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { deleteThread } from "../agent/threads.ts";
import { getAiCollections } from "../db/collections.ts";
import type { ChatThreadDocument } from "../types.ts";

export const DORA_GRAPH_VERSION = "dora-chat-v1";

/**
 * Dora's LangGraph thread id — server-derived only, never client input.
 * FROZEN like Clara's: checkpoints in `agent_checkpoints` are keyed by this
 * exact string, so any change orphans every ongoing document conversation.
 * `npm run ai:reset:chat` is the only sanctioned break. A unit test pins the
 * format.
 */
export function documentThreadKey(tenantId: ObjectId, documentId: ObjectId): string {
  return `dora:${tenantId.toHexString()}:${documentId.toHexString()}`;
}

/** One Dora thread per (tenant, workspace document); company-shared. */
export async function ensureDocumentThread(input: {
  tenantId: ObjectId;
  documentId: ObjectId;
  userId: string;
}): Promise<ChatThreadDocument> {
  const { chatThreads } = await getAiCollections();
  const now = new Date();
  await chatThreads.updateOne(
    { tenantId: input.tenantId, documentId: input.documentId, agent: "dora" },
    {
      // Derived fields refreshed on every open (same reasoning as Clara's
      // ensureTenderThread); disjoint from $setOnInsert per Mongo rules.
      $set: {
        kind: "document" as const,
        tenderId: null,
        ownerUserId: null,
        threadKey: documentThreadKey(input.tenantId, input.documentId),
      },
      $setOnInsert: {
        tenantId: input.tenantId,
        documentId: input.documentId,
        title: null,
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
    documentId: input.documentId,
    agent: "dora",
  });
  return thread as ChatThreadDocument;
}

/**
 * Clear the document conversation (messages + checkpoints); the thread doc
 * itself survives with reset counters — the same "clear chat" semantics as
 * Clara's tender threads, via the same deleteThread.
 */
export async function clearDocumentThread(
  tenantId: ObjectId,
  documentId: ObjectId,
): Promise<void> {
  const { chatThreads } = await getAiCollections();
  const thread = await chatThreads.findOne({ tenantId, documentId, agent: "dora" });
  if (!thread?._id) return;
  await deleteThread(thread as ChatThreadDocument);
}

/**
 * Remove EVERYTHING Dora stored for a workspace document — thread, messages,
 * checkpoints, brief, run, cached text. Called best-effort from the document
 * DELETE route; the document itself is already gone when this runs.
 */
export async function purgeDoraDocumentData(
  tenantId: ObjectId,
  documentId: ObjectId,
): Promise<void> {
  const { chatThreads, chatMessages, documentBriefs, documentBriefRuns, workspaceDocumentTexts } =
    await getAiCollections();

  const thread = await chatThreads.findOne({ tenantId, documentId, agent: "dora" });
  if (thread?._id) {
    await chatMessages.deleteMany({ tenantId, threadId: thread._id });
    const db = await getIngestionDb();
    const key = thread.threadKey ?? documentThreadKey(tenantId, documentId);
    await db.collection("agent_checkpoints").deleteMany({ thread_id: key });
    await db.collection("agent_checkpoint_writes").deleteMany({ thread_id: key });
    await chatThreads.deleteOne({ _id: thread._id, tenantId });
  }

  await documentBriefs.deleteMany({ tenantId, documentId });
  await documentBriefRuns.deleteMany({ tenantId, documentId });
  await workspaceDocumentTexts.deleteMany({ tenantId, documentId });
}
