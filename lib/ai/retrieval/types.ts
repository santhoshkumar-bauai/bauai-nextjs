import type { ObjectId } from "mongodb";

import type { ChunkAnchor } from "../types.ts";

/**
 * Hybrid retrieval contracts (roadmap §17.3/§17.4). Every query is
 * mandatorily tender-scoped for chunk search; the tenant filter always
 * resolves to `tenantId ∈ {null, currentTenant}` — shared corpus plus the
 * caller's own material, never another tenant's.
 */

export interface RetrievalFilters {
  /** Injected server-side; never accepted from a client. */
  tenantId: ObjectId | null;
  tenderId: ObjectId;
  documentRecordId?: string;
  docClass?: string;
  language?: string;
}

export type RetrievalMode = "keyword" | "vector" | "hybrid";

export interface RetrievalQuery {
  text: string;
  filters: RetrievalFilters;
  /** Final result count after fusion/reranking (roadmap: 8–12). */
  k: number;
  mode: RetrievalMode;
}

export interface RetrievedChunk {
  chunkId: ObjectId;
  tenderId: ObjectId;
  documentRecordId: string;
  fileSha256: string;
  fileName: string;
  sectionPath: string[];
  text: string;
  legalRefs: string[];
  anchor: ChunkAnchor;
  scores: {
    vector?: number;
    keyword?: number;
    fused: number;
  };
  rank: number;
}

/** How many candidates each arm contributes before fusion (§17.3: top 40). */
export const CANDIDATES_PER_ARM = 40;
