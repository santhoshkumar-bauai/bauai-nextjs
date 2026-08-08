import type { Collection } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import type {
  AiIndexStateDocument,
  ChatMessageDocument,
  ChatThreadDocument,
  ChunkDocument,
  DocumentClassificationDocument,
  ExtractionDocument,
  TenderFitRecommendationDocument,
  TenderOverviewDocument,
  TenderSearchDocument,
  TenderVerdictDocument,
} from "../types.ts";

export const aiCollectionNames = {
  tenderSearchDocuments: "tender_search_documents",
  chunks: "chunks",
  aiIndexState: "ai_index_state",
  documentClassifications: "document_classifications",
  extractions: "extractions",
  tenderFitRecommendations: "tender_fit_recommendations",
  tenderOverviews: "tender_overviews",
  chatThreads: "chat_threads",
  chatMessages: "chat_messages",
  tenderVerdicts: "tender_verdicts",
} as const;

export interface AiCollections {
  tenderSearchDocuments: Collection<TenderSearchDocument>;
  chunks: Collection<ChunkDocument>;
  aiIndexState: Collection<AiIndexStateDocument>;
  documentClassifications: Collection<DocumentClassificationDocument>;
  extractions: Collection<ExtractionDocument>;
  tenderFitRecommendations: Collection<TenderFitRecommendationDocument>;
  tenderOverviews: Collection<TenderOverviewDocument>;
  chatThreads: Collection<ChatThreadDocument>;
  chatMessages: Collection<ChatMessageDocument>;
  tenderVerdicts: Collection<TenderVerdictDocument>;
}

/** Reuses the ingestion worker's pooled client — same DB, same lifecycle. */
export async function getAiCollections(): Promise<AiCollections> {
  const db = await getIngestionDb();
  return {
    tenderSearchDocuments: db.collection(aiCollectionNames.tenderSearchDocuments),
    chunks: db.collection(aiCollectionNames.chunks),
    aiIndexState: db.collection(aiCollectionNames.aiIndexState),
    documentClassifications: db.collection(aiCollectionNames.documentClassifications),
    extractions: db.collection(aiCollectionNames.extractions),
    tenderFitRecommendations: db.collection(
      aiCollectionNames.tenderFitRecommendations,
    ),
    tenderOverviews: db.collection(aiCollectionNames.tenderOverviews),
    chatThreads: db.collection(aiCollectionNames.chatThreads),
    chatMessages: db.collection(aiCollectionNames.chatMessages),
    tenderVerdicts: db.collection(aiCollectionNames.tenderVerdicts),
  };
}
