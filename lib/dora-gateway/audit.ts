import type { ObjectId } from "mongodb";

import { getIngestionDb } from "@/lib/ingestion/db/client";

import type { DoraEditOpType } from "./edit-ops";

/**
 * Terminal-state audit trail for edit ops: what the panel actually did with
 * each proposal (applied / accepted / rejected / stale / failed). Written by
 * the gateway ops route; one row per (opId, state transition report). Uses
 * the pooled ingestion client directly — the op records are gateway-owned
 * and deliberately outside the typed AI collection registry.
 */

export type DoraEditOpState =
  | "applied"
  | "accepted"
  | "rejected"
  | "dismissed"
  | "stale"
  | "failed";

export interface DoraEditOpAudit {
  tenantId: ObjectId | string;
  documentId: string;
  userId: string;
  opId: string;
  type: DoraEditOpType;
  state: DoraEditOpState;
  failureCode: string | null;
  reportedAt: Date;
}

export async function recordEditOpState(entry: Omit<DoraEditOpAudit, "reportedAt">) {
  const db = await getIngestionDb();
  await db.collection<DoraEditOpAudit>("dora_edit_ops").insertOne({
    ...entry,
    reportedAt: new Date(),
  });
}
