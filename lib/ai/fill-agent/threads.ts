import type { ObjectId } from "mongodb";

import { deleteThread } from "../agent/threads.ts";
import { getAiCollections } from "../db/collections.ts";
import type { ChatThreadDocument } from "../types.ts";

export const FILL_AGENT_GRAPH_VERSION = "fill-agent-v1";

/**
 * The fill agent's LangGraph thread id — server-derived only, never client
 * input (same tenant-isolation boundary as Clara/Dora/Otto). FROZEN:
 * checkpoints in `agent_checkpoints` are keyed by this exact string. A unit
 * test pins the format.
 */
export function fillSessionThreadKey(
  tenantId: ObjectId,
  sessionId: ObjectId,
): string {
  return `fillagent:${tenantId.toHexString()}:${sessionId.toHexString()}`;
}

/**
 * One thread per fill session, owner-scoped, created on first use. Every
 * existing thread listing filters by agent/kind, so these never leak into
 * Clara/Dora/Otto session lists.
 */
export async function ensureFillSessionThread(input: {
  tenantId: ObjectId;
  sessionId: ObjectId;
  userId: string;
}): Promise<ChatThreadDocument> {
  const { chatThreads } = await getAiCollections();
  const threadKey = fillSessionThreadKey(input.tenantId, input.sessionId);
  const existing = await chatThreads.findOne({ tenantId: input.tenantId, threadKey });
  if (existing) return existing as ChatThreadDocument;

  const now = new Date();
  const created = {
    tenantId: input.tenantId,
    kind: "fill_session" as const,
    tenderId: null,
    documentId: null,
    ownerUserId: input.userId,
    threadKey,
    title: null,
    agent: "fill_agent" as const,
    createdBy: input.userId,
    graphVersion: FILL_AGENT_GRAPH_VERSION,
    lastMessageAt: now,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await chatThreads.insertOne(created as ChatThreadDocument);
  return { ...created, _id: inserted.insertedId } as ChatThreadDocument;
}

/** Session teardown: thread + messages + checkpoints. */
export async function purgeFillSessionThread(
  tenantId: ObjectId,
  sessionId: ObjectId,
): Promise<void> {
  const { chatThreads } = await getAiCollections();
  const threadKey = fillSessionThreadKey(tenantId, sessionId);
  const thread = await chatThreads.findOne({ tenantId, threadKey });
  if (thread) {
    // deleteThread clears messages + checkpoints; fill_session threads are
    // not "global", so it resets rather than deletes the row — remove it.
    await deleteThread(thread as ChatThreadDocument);
    await chatThreads.deleteOne({ _id: thread._id, tenantId });
  }
}
