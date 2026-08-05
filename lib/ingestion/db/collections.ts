import type { Collection } from "mongodb";

import { getIngestionDb } from "./client.ts";
import type {
  DeadLetterDocument,
  IngestionRunDocument,
  OutboxEventDocument,
  RelayStateDocument,
  SourceCheckpointDocument,
  SourceConfigDocument,
  TenderDocument,
  TenderNoticeDocument,
} from "../types.ts";

export const collectionNames = {
  sourceConfigs: "source_configs",
  sourceCheckpoints: "source_checkpoints",
  ingestionRuns: "ingestion_runs",
  tenderNotices: "tender_notices",
  tenders: "tenders",
  outboxEvents: "outbox_events",
  deadLetterEvents: "dead_letter_events",
  relayState: "ingestion_relay_state",
} as const;

export interface IngestionCollections {
  sourceConfigs: Collection<SourceConfigDocument>;
  sourceCheckpoints: Collection<SourceCheckpointDocument>;
  ingestionRuns: Collection<IngestionRunDocument>;
  tenderNotices: Collection<TenderNoticeDocument>;
  tenders: Collection<TenderDocument>;
  outboxEvents: Collection<OutboxEventDocument>;
  deadLetterEvents: Collection<DeadLetterDocument>;
  relayState: Collection<RelayStateDocument>;
}

export async function getCollections(): Promise<IngestionCollections> {
  const db = await getIngestionDb();
  return {
    sourceConfigs: db.collection(collectionNames.sourceConfigs),
    sourceCheckpoints: db.collection(collectionNames.sourceCheckpoints),
    ingestionRuns: db.collection(collectionNames.ingestionRuns),
    tenderNotices: db.collection(collectionNames.tenderNotices),
    tenders: db.collection(collectionNames.tenders),
    outboxEvents: db.collection(collectionNames.outboxEvents),
    deadLetterEvents: db.collection(collectionNames.deadLetterEvents),
    relayState: db.collection(collectionNames.relayState),
  };
}
