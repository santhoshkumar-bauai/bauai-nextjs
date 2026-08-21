import type { ObjectId } from "mongodb";

export type DocumentFillFieldState =
  | "ready"
  | "needs_review"
  | "missing"
  | "manual"
  | "not_applicable";

export type DocumentFillLocator =
  | { strategy: "form_key"; nodeId: string; path: string; formKey: string }
  | {
      strategy: "unique_text";
      nodeId: string;
      path: string;
      searchText: string;
      occurrence: 1;
    };

export interface DocumentFillEvidence {
  source: "company_profile" | "company_document" | "tender" | "user";
  reference: string;
  excerpt: string;
}

export interface DocumentFillField {
  id: string;
  label: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  value: string | null;
  confidence: number;
  state: DocumentFillFieldState;
  locator: DocumentFillLocator | null;
  evidence: DocumentFillEvidence[];
  reason: string;
  updatedBy: "ai" | "user";
}

export interface DocumentFillRunDocument {
  _id: ObjectId;
  tenantId: ObjectId;
  documentId: ObjectId;
  sourceVersionId: ObjectId;
  sourceStorageRevision: number;
  sourceSha256: string;
  snapshotId: string;
  snapshotHash: string;
  status:
    | "queued"
    | "analyzing"
    | "review"
    | "generating"
    | "completed"
    | "failed"
    | "cancelled";
  stage:
    | "queued"
    | "discovering"
    | "grounding"
    | "validating"
    | "review"
    | "building"
    | "storing"
    | "done";
  fields: DocumentFillField[];
  generatedDocumentId: ObjectId | null;
  error: string | null;
  startedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}
