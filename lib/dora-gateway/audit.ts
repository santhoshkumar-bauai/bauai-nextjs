import type { ObjectId } from "mongodb";

import { getIngestionDb } from "@/lib/ingestion/db/client";

import type { DoraEditOpType } from "./edit-ops";
import type { WireDoraMutationType, WireDoraSurface } from "@/lib/ai/dora/edit-wire";

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

export type DoraTransactionState =
  | "planned"
  | "applying"
  | "applied"
  | "accepted"
  | "rejected"
  | "stale"
  | "rolled_back"
  | "failed";

export interface DoraEditTransactionAudit {
  tenantId: ObjectId | string;
  documentId: string;
  userId: string;
  transactionId: string;
  snapshotId: string;
  opId: string | null;
  type: WireDoraMutationType | null;
  surface: WireDoraSurface | null;
  state: DoraTransactionState;
  failureCode: string | null;
  failureDetail?: string | null;
  schemaVersion: string;
  promptVersion: string | null;
  provider: string | null;
  providerModel: string | null;
  latencyMs: number | null;
  createdAt: Date;
}

export async function recordEditTransactionState(
  entry: Omit<DoraEditTransactionAudit, "createdAt">,
) {
  const db = await getIngestionDb();
  await db.collection<DoraEditTransactionAudit>("dora_edit_transactions").insertOne({
    ...entry,
    createdAt: new Date(),
  });
}
