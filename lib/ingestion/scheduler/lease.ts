import { ingestionEnv } from "../config/env.ts";
import { getCollections } from "../db/collections.ts";
import { logger } from "../observability/logger.ts";
import type { IngestionMode, TenderSourceCode } from "../types.ts";
import { checkpointId } from "./checkpoints.ts";

const log = logger.child("lease");

/**
 * Renewable MongoDB lease so only one replica polls a source at a time (§4.1).
 *
 * The lease is held on the checkpoint document itself, which means acquiring it
 * and reading the cursor are the same round trip, and a crashed holder is
 * recovered automatically once `leaseUntil` passes.
 */
export interface Lease {
  release(): Promise<void>;
  renew(): Promise<boolean>;
}

export async function acquireLease(
  source: TenderSourceCode,
  mode: IngestionMode,
  ttlMs = ingestionEnv.scheduler.leaseTtlMs,
): Promise<Lease | null> {
  const collections = await getCollections();
  const _id = checkpointId(source, mode);
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + ttlMs);

  const claimed = await collections.sourceCheckpoints.findOneAndUpdate(
    {
      _id,
      // Free, expired, or already ours — the last case makes a restarted worker
      // able to resume its own interrupted run instead of waiting out the TTL.
      $or: [
        { leaseOwner: null },
        { leaseUntil: { $lt: now } },
        { leaseOwner: ingestionEnv.workerId },
      ],
    },
    { $set: { leaseOwner: ingestionEnv.workerId, leaseUntil, updatedAt: now } },
    { returnDocument: "after" },
  );

  if (!claimed) return null;

  return {
    renew: async () => {
      const renewed = await collections.sourceCheckpoints.updateOne(
        { _id, leaseOwner: ingestionEnv.workerId },
        { $set: { leaseUntil: new Date(Date.now() + ttlMs), updatedAt: new Date() } },
      );
      if (!renewed.matchedCount) {
        log.warn("lease lost while running", { source, mode });
        return false;
      }
      return true;
    },
    release: async () => {
      await collections.sourceCheckpoints.updateOne(
        { _id, leaseOwner: ingestionEnv.workerId },
        { $set: { leaseOwner: null, leaseUntil: null, updatedAt: new Date() } },
      );
    },
  };
}

/**
 * Runs `task` while holding the lease, renewing it in the background so a long
 * archive download cannot let a second replica start the same poll.
 */
export async function withLease<T>(
  source: TenderSourceCode,
  mode: IngestionMode,
  task: () => Promise<T>,
): Promise<T | null> {
  const lease = await acquireLease(source, mode);
  if (!lease) return null;

  const renewer = setInterval(() => {
    void lease.renew();
  }, Math.max(5_000, Math.floor(ingestionEnv.scheduler.leaseTtlMs / 3)));

  try {
    return await task();
  } finally {
    clearInterval(renewer);
    await lease.release().catch((error) =>
      log.error("failed to release lease", { source, mode, error: String(error) }),
    );
  }
}
