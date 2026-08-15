import type { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { getAiCollections } from "../db/collections.ts";
import type { ChatThreadDocument } from "../types.ts";

export const OTTO_GRAPH_VERSION = "otto-onboarding-v1";

/**
 * Otto's LangGraph thread id — server-derived only, never client input.
 * FROZEN like Clara's and Dora's: checkpoints in `agent_checkpoints` are keyed
 * by this exact string, so changing the format orphans every in-progress
 * onboarding. A unit test pins it.
 *
 * Per USER, not per company: onboarding is a personal experience, and two
 * colleagues in the same company must not share one tour.
 */
export function onboardingThreadKey(tenantId: ObjectId, userId: string): string {
  return `otto:${tenantId.toHexString()}:${userId}`;
}

/** One Otto thread per (tenant, user); private to that user. */
export async function ensureOnboardingThread(input: {
  tenantId: ObjectId;
  userId: string;
}): Promise<ChatThreadDocument> {
  const { chatThreads } = await getAiCollections();
  const now = new Date();
  await chatThreads.updateOne(
    { tenantId: input.tenantId, ownerUserId: input.userId, agent: "otto" },
    {
      // Derived fields refreshed on every open (same reasoning as Clara's
      // ensureTenderThread); disjoint from $setOnInsert per Mongo rules.
      $set: {
        kind: "onboarding" as const,
        tenderId: null,
        documentId: null,
        threadKey: onboardingThreadKey(input.tenantId, input.userId),
      },
      $setOnInsert: {
        tenantId: input.tenantId,
        ownerUserId: input.userId,
        title: null,
        agent: "otto",
        createdBy: input.userId,
        graphVersion: OTTO_GRAPH_VERSION,
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
    ownerUserId: input.userId,
    agent: "otto",
  });
  return thread as ChatThreadDocument;
}

/**
 * Wipe a user's onboarding conversation AND its graph checkpoint, so the next
 * turn starts from `profiling` again.
 *
 * Both halves matter: deleting the messages alone leaves the checkpoint
 * holding the old plan and profile, and the user would resume mid-tour with no
 * visible history explaining why.
 */
export async function resetOnboardingThread(input: {
  tenantId: ObjectId;
  userId: string;
}): Promise<void> {
  const { chatThreads, chatMessages } = await getAiCollections();
  const threadKey = onboardingThreadKey(input.tenantId, input.userId);

  const thread = await chatThreads.findOne({
    tenantId: input.tenantId,
    ownerUserId: input.userId,
    agent: "otto",
  });
  if (thread?._id) {
    await chatMessages.deleteMany({ tenantId: input.tenantId, threadId: thread._id });
    await chatThreads.updateOne(
      { _id: thread._id },
      { $set: { messageCount: 0, updatedAt: new Date() } },
    );
  }

  const db = await getIngestionDb();
  await db.collection("agent_checkpoints").deleteMany({ thread_id: threadKey });
  await db.collection("agent_checkpoint_writes").deleteMany({ thread_id: threadKey });
}
