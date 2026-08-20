import type { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { deleteThread } from "../agent/threads.ts";
import { getAiCollections } from "../db/collections.ts";
import type { ChatThreadDocument } from "../types.ts";

export const DORA_GRAPH_VERSION = "dora-chat-v1";

/**
 * Dora's LangGraph thread id — server-derived only, never client input.
 * FROZEN like Clara's for generation 0: checkpoints in `agent_checkpoints`
 * are keyed by this exact string, so any change orphans every ongoing
 * document conversation. `npm run ai:reset:chat` is the only sanctioned
 * break. A unit test pins the format. "New chat" generations (1+) append a
 * `:{generation}` suffix — a NEW namespace, so the frozen base is untouched.
 */
export function documentThreadKey(
  tenantId: ObjectId,
  documentId: ObjectId,
  generation = 0,
): string {
  const base = `dora:${tenantId.toHexString()}:${documentId.toHexString()}`;
  return generation > 0 ? `${base}:${generation}` : base;
}

/** The active conversation = highest generation (legacy docs have one
 * generation-less thread, which sorts last and stays active until the first
 * "new chat"). */
async function findActiveThread(
  tenantId: ObjectId,
  documentId: ObjectId,
): Promise<ChatThreadDocument | null> {
  const { chatThreads } = await getAiCollections();
  return (await chatThreads
    .find({ tenantId, documentId, agent: "dora" })
    .sort({ generation: -1, createdAt: -1 })
    .limit(1)
    .next()) as ChatThreadDocument | null;
}

/**
 * The Dora thread for a turn: an explicitly selected chat (panel history
 * switch — validated against tenant+document), else the active conversation,
 * created on first use. Company-shared like before.
 */
export async function ensureDocumentThread(input: {
  tenantId: ObjectId;
  documentId: ObjectId;
  userId: string;
  threadId?: ObjectId | null;
}): Promise<ChatThreadDocument> {
  const { chatThreads } = await getAiCollections();
  if (input.threadId) {
    const selected = await chatThreads.findOne({
      _id: input.threadId,
      tenantId: input.tenantId,
      documentId: input.documentId,
      agent: "dora",
    });
    if (selected) return selected as ChatThreadDocument;
    // Unknown/foreign id → fall through to the active thread rather than 404:
    // the panel may hold a stale id after a purge.
  }
  const active = await findActiveThread(input.tenantId, input.documentId);
  if (active?._id) {
    // Derived fields refreshed on every open (same reasoning as Clara's
    // ensureTenderThread). threadKey is per-generation.
    await chatThreads.updateOne(
      { _id: active._id, tenantId: input.tenantId },
      {
        $set: {
          kind: "document" as const,
          tenderId: null,
          ownerUserId: null,
          generation: active.generation ?? 0,
          threadKey: documentThreadKey(
            input.tenantId,
            input.documentId,
            active.generation ?? 0,
          ),
        },
      },
    );
    return (await chatThreads.findOne({ _id: active._id })) as ChatThreadDocument;
  }
  const now = new Date();
  const created = {
    tenantId: input.tenantId,
    kind: "document" as const,
    tenderId: null,
    documentId: input.documentId,
    ownerUserId: null,
    threadKey: documentThreadKey(input.tenantId, input.documentId, 0),
    title: null,
    generation: 0,
    agent: "dora" as const,
    createdBy: input.userId,
    graphVersion: DORA_GRAPH_VERSION,
    lastMessageAt: now,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await chatThreads.insertOne(created as ChatThreadDocument);
  return { ...created, _id: inserted.insertedId } as ChatThreadDocument;
}

/**
 * "New chat": open the next-generation thread for the document. Reuses the
 * active thread when it is still empty — mashing the button never piles up
 * blank conversations.
 */
export async function startNewDocumentThread(input: {
  tenantId: ObjectId;
  documentId: ObjectId;
  userId: string;
}): Promise<ChatThreadDocument> {
  const { chatThreads } = await getAiCollections();
  const active = await findActiveThread(input.tenantId, input.documentId);
  if (active && active.messageCount === 0) return active;
  const generation = (active?.generation ?? 0) + 1;
  const now = new Date();
  const created = {
    tenantId: input.tenantId,
    kind: "document" as const,
    tenderId: null,
    documentId: input.documentId,
    ownerUserId: null,
    threadKey: documentThreadKey(input.tenantId, input.documentId, generation),
    title: null,
    generation,
    agent: "dora" as const,
    createdBy: input.userId,
    graphVersion: DORA_GRAPH_VERSION,
    lastMessageAt: now,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await chatThreads.insertOne(created as ChatThreadDocument);
  return { ...created, _id: inserted.insertedId } as ChatThreadDocument;
}

/**
 * Chat list for the panel switcher: newest first, titled by the thread title
 * or its first user message.
 */
export async function listDocumentThreads(
  tenantId: ObjectId,
  documentId: ObjectId,
  limit = 20,
): Promise<Array<{ thread: ChatThreadDocument; title: string | null }>> {
  const { chatThreads, chatMessages } = await getAiCollections();
  const threads = (await chatThreads
    .find({ tenantId, documentId, agent: "dora" })
    .sort({ generation: -1, createdAt: -1 })
    .limit(limit)
    .toArray()) as ChatThreadDocument[];
  if (!threads.length) return [];
  const firsts = await chatMessages
    .aggregate<{ _id: ObjectId; first: string }>([
      {
        $match: {
          tenantId,
          threadId: { $in: threads.map((thread) => thread._id) },
          role: "user",
        },
      },
      { $sort: { createdAt: 1 } },
      { $group: { _id: "$threadId", first: { $first: "$content" } } },
    ])
    .toArray();
  const titleByThread = new Map(firsts.map((row) => [String(row._id), row.first]));
  return threads.map((thread) => ({
    thread,
    title: thread.title ?? titleByThread.get(String(thread._id))?.slice(0, 80) ?? null,
  }));
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
  const thread = await findActiveThread(tenantId, documentId);
  if (!thread?._id) return;
  await deleteThread(thread);
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

  // Every generation of the document's chats, not just the active one.
  const threads = (await chatThreads
    .find({ tenantId, documentId, agent: "dora" })
    .toArray()) as ChatThreadDocument[];
  if (threads.length) {
    const db = await getIngestionDb();
    for (const thread of threads) {
      await chatMessages.deleteMany({ tenantId, threadId: thread._id });
      const key =
        thread.threadKey ??
        documentThreadKey(tenantId, documentId, thread.generation ?? 0);
      await db.collection("agent_checkpoints").deleteMany({ thread_id: key });
      await db.collection("agent_checkpoint_writes").deleteMany({ thread_id: key });
    }
    await chatThreads.deleteMany({ tenantId, documentId, agent: "dora" });
  }

  await documentBriefs.deleteMany({ tenantId, documentId });
  await documentBriefRuns.deleteMany({ tenantId, documentId });
  await workspaceDocumentTexts.deleteMany({ tenantId, documentId });
}
