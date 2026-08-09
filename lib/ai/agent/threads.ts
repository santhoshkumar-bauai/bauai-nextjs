import { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { getAiCollections } from "../db/collections.ts";
import type { ChatThreadDocument } from "../types.ts";

export const CLARA_GRAPH_VERSION = "clara-chat-v1";

/**
 * LangGraph thread ids — server-derived only, never client input.
 * The tender format is FROZEN going forward: checkpoints in `agent_checkpoints`
 * are keyed by this exact string, so any change orphans every ongoing tender
 * conversation. The one deliberate break so far (the Clara rebrand) was paired
 * with a full wipe via `npm run ai:reset:chat`; any future change needs the
 * same. A unit test pins the format.
 */
export function tenderThreadKey(tenantId: ObjectId, tenderId: ObjectId): string {
  return `clara:${tenantId.toHexString()}:${tenderId.toHexString()}`;
}

/** Global (non-tender) threads are keyed by their own _id. */
export function globalThreadKey(threadId: ObjectId): string {
  return `clarag:${threadId.toHexString()}`;
}

/** One tender thread per (tenant, tender, agent); upsert-and-return. */
export async function ensureTenderThread(input: {
  tenantId: ObjectId;
  tenderId: ObjectId;
  userId: string;
}): Promise<ChatThreadDocument> {
  const { chatThreads } = await getAiCollections();
  const now = new Date();
  await chatThreads.updateOne(
    { tenantId: input.tenantId, tenderId: input.tenderId, agent: "clara" },
    {
      // Keep the derived fields current on every open, so a threadKey format
      // change only needs a wipe of the checkpoints, not of the thread docs.
      // Disjoint from $setOnInsert per Mongo rules.
      $set: {
        kind: "tender" as const,
        ownerUserId: null,
        threadKey: tenderThreadKey(input.tenantId, input.tenderId),
      },
      $setOnInsert: {
        tenantId: input.tenantId,
        tenderId: input.tenderId,
        title: null,
        agent: "clara",
        createdBy: input.userId,
        graphVersion: CLARA_GRAPH_VERSION,
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
    agent: "clara",
  });
  return thread as ChatThreadDocument;
}

/**
 * Private per-user global thread; many per user, keyed by _id. Repeated
 * "New chat" clicks reuse the user's newest still-empty thread instead of
 * piling up shells.
 */
export async function createGlobalThread(input: {
  tenantId: ObjectId;
  userId: string;
}): Promise<ChatThreadDocument> {
  const { chatThreads } = await getAiCollections();
  const empty = await chatThreads.findOne(
    {
      tenantId: input.tenantId,
      kind: "global",
      ownerUserId: input.userId,
      agent: "clara",
      messageCount: 0,
      title: null,
    },
    { sort: { createdAt: -1 } },
  );
  if (empty) return empty as ChatThreadDocument;

  const now = new Date();
  const _id = new ObjectId();
  const doc: ChatThreadDocument = {
    _id,
    tenantId: input.tenantId,
    kind: "global",
    tenderId: null,
    ownerUserId: input.userId,
    threadKey: globalThreadKey(_id),
    title: null,
    agent: "clara",
    createdBy: input.userId,
    graphVersion: CLARA_GRAPH_VERSION,
    lastMessageAt: now,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await chatThreads.insertOne(doc as never);
  return doc;
}

/**
 * Load a thread the caller may access: tenant must match, and global threads
 * are visible only to their owner (tender threads are company-shared).
 */
export async function getOwnedThread(input: {
  tenantId: ObjectId;
  userId: string;
  threadId: ObjectId;
}): Promise<ChatThreadDocument | null> {
  const { chatThreads } = await getAiCollections();
  const thread = await chatThreads.findOne({
    _id: input.threadId,
    tenantId: input.tenantId,
  });
  if (!thread) return null;
  if (thread.kind === "global" && thread.ownerUserId !== input.userId) return null;
  return thread as ChatThreadDocument;
}

/**
 * Sidebar listing: the user's own global threads plus the company's active
 * tender threads (company-shared, so no owner filter there).
 */
export async function listThreads(input: {
  tenantId: ObjectId;
  userId: string;
}): Promise<ChatThreadDocument[]> {
  const { chatThreads } = await getAiCollections();
  const [globalThreads, tenderThreads] = await Promise.all([
    chatThreads
      .find({
        tenantId: input.tenantId,
        kind: "global",
        ownerUserId: input.userId,
        agent: "clara",
      })
      .sort({ lastMessageAt: -1 })
      .limit(50)
      .toArray(),
    chatThreads
      .find({
        tenantId: input.tenantId,
        kind: "tender",
        agent: "clara",
        messageCount: { $gt: 0 },
      })
      .sort({ lastMessageAt: -1 })
      .limit(20)
      .toArray(),
  ]);
  return [...globalThreads, ...tenderThreads] as ChatThreadDocument[];
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

/** First-message title for untitled global threads (word-boundary truncated). */
export async function setThreadTitleIfEmpty(
  tenantId: ObjectId,
  threadId: ObjectId,
  firstMessage: string,
): Promise<void> {
  const { chatThreads } = await getAiCollections();
  let title = firstMessage.trim().replace(/\s+/g, " ");
  if (title.length > 60) {
    const cut = title.slice(0, 60);
    const lastSpace = cut.lastIndexOf(" ");
    title = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
  }
  await chatThreads.updateOne(
    { _id: threadId, tenantId, kind: "global", title: null },
    { $set: { title, updatedAt: new Date() } },
  );
}

export async function renameThread(
  tenantId: ObjectId,
  threadId: ObjectId,
  title: string,
): Promise<void> {
  const { chatThreads } = await getAiCollections();
  await chatThreads.updateOne(
    { _id: threadId, tenantId, kind: "global" },
    { $set: { title, updatedAt: new Date() } },
  );
}

async function deleteCheckpoints(threadKey: string): Promise<void> {
  const db = await getIngestionDb();
  await db.collection("agent_checkpoints").deleteMany({ thread_id: threadKey });
  await db.collection("agent_checkpoint_writes").deleteMany({ thread_id: threadKey });
}

/**
 * Delete a thread's conversation. Tender threads keep the thread doc (reset
 * counters — today's clear semantics); global threads are removed entirely.
 */
export async function deleteThread(thread: ChatThreadDocument): Promise<void> {
  const { chatThreads, chatMessages } = await getAiCollections();
  if (!thread._id) return;
  await chatMessages.deleteMany({ tenantId: thread.tenantId, threadId: thread._id });
  if (thread.kind === "global") {
    await chatThreads.deleteOne({ _id: thread._id, tenantId: thread.tenantId });
  } else {
    await chatThreads.updateOne(
      { _id: thread._id, tenantId: thread.tenantId },
      { $set: { messageCount: 0, updatedAt: new Date() } },
    );
  }
  const key =
    thread.threadKey ??
    (thread.tenderId ? tenderThreadKey(thread.tenantId, thread.tenderId) : null);
  if (key) await deleteCheckpoints(key);
}

/** Full reset of a tender conversation (legacy entry point, tender route). */
export async function clearThread(
  tenantId: ObjectId,
  tenderId: ObjectId,
): Promise<void> {
  const { chatThreads } = await getAiCollections();
  const thread = await chatThreads.findOne({ tenantId, tenderId, agent: "clara" });
  if (!thread?._id) return;
  await deleteThread(thread as ChatThreadDocument);
}
