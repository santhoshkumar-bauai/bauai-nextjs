import type { Collection } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import type {
  AiIndexStateDocument,
  ChatAttachmentDocument,
  ChatMessageDocument,
  ChatThreadDocument,
  ChunkDocument,
  CompanyMatchProfileDocument,
  CompanyMatchRunDocument,
  DocumentBriefDocument,
  DocumentBriefRunDocument,
  DocumentClassificationDocument,
  ExtractionDocument,
  TenderFitRecommendationDocument,
  TenderMatchScoreDocument,
  TenderOverviewDocument,
  TenderReportDocument,
  TenderReportRunDocument,
  TenderSearchDocument,
  TenderVerdictDocument,
  WorkspaceDocumentTextDocument,
} from "../types.ts";
import type { DocumentFillRunDocument } from "../dora/fill/types.ts";

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
  chatAttachments: "chat_attachments",
  tenderVerdicts: "tender_verdicts",
  tenderReports: "tender_reports",
  tenderReportRuns: "tender_report_runs",
  companyMatchProfiles: "company_match_profiles",
  tenderMatchScores: "tender_match_scores",
  companyMatchRuns: "company_match_runs",
  documentBriefs: "document_briefs",
  documentBriefRuns: "document_brief_runs",
  workspaceDocumentTexts: "workspace_document_texts",
  documentFillRuns: "document_fill_runs",
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
  chatAttachments: Collection<ChatAttachmentDocument>;
  tenderVerdicts: Collection<TenderVerdictDocument>;
  tenderReports: Collection<TenderReportDocument>;
  tenderReportRuns: Collection<TenderReportRunDocument>;
  companyMatchProfiles: Collection<CompanyMatchProfileDocument>;
  tenderMatchScores: Collection<TenderMatchScoreDocument>;
  companyMatchRuns: Collection<CompanyMatchRunDocument>;
  documentBriefs: Collection<DocumentBriefDocument>;
  documentBriefRuns: Collection<DocumentBriefRunDocument>;
  workspaceDocumentTexts: Collection<WorkspaceDocumentTextDocument>;
  documentFillRuns: Collection<DocumentFillRunDocument>;
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
    chatAttachments: db.collection(aiCollectionNames.chatAttachments),
    tenderVerdicts: db.collection(aiCollectionNames.tenderVerdicts),
    tenderReports: db.collection(aiCollectionNames.tenderReports),
    tenderReportRuns: db.collection(aiCollectionNames.tenderReportRuns),
    companyMatchProfiles: db.collection(aiCollectionNames.companyMatchProfiles),
    tenderMatchScores: db.collection(aiCollectionNames.tenderMatchScores),
    companyMatchRuns: db.collection(aiCollectionNames.companyMatchRuns),
    documentBriefs: db.collection(aiCollectionNames.documentBriefs),
    documentBriefRuns: db.collection(aiCollectionNames.documentBriefRuns),
    workspaceDocumentTexts: db.collection(aiCollectionNames.workspaceDocumentTexts),
    documentFillRuns: db.collection(aiCollectionNames.documentFillRuns),
  };
}
