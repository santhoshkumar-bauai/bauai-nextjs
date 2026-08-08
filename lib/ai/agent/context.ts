import { ObjectId } from "mongodb";

import type { CompanyContext } from "../../company/context.ts";
import { mongoDatabase } from "../../db/mongodb.ts";
import type { TenderDocument } from "../../ingestion/types.ts";
import {
  serializeTenderDetail,
  type SerializedTenderDetail,
} from "../../tenders/detail.ts";
import { forCompanyContext } from "../tenant/repository.ts";
import { CitationCollector } from "./citations.ts";

/**
 * Everything a Dora run needs, derived SERVER-SIDE from the authenticated
 * request. Tools close over this — their inputs never carry tenant or tender
 * identifiers, so a prompt-injected tool call cannot change scope (§6.5).
 */
export interface AgentRunContext {
  tenantId: ObjectId;
  tenderId: ObjectId;
  userId: string;
  locale: "en" | "de";
  tenderDetail: SerializedTenderDetail;
  companyContext: CompanyContext;
  citations: CitationCollector;
}

export async function buildAgentRunContext(input: {
  companyContext: CompanyContext;
  tenderIdHex: string;
  locale: "en" | "de";
}): Promise<AgentRunContext | null> {
  if (!ObjectId.isValid(input.tenderIdHex)) return null;
  const tenderId = new ObjectId(input.tenderIdHex);

  const doc = await mongoDatabase
    .collection<TenderDocument>("tenders")
    .findOne({ _id: tenderId });
  if (!doc || doc.isVisible === false) return null;

  return {
    tenantId: forCompanyContext(input.companyContext).value,
    tenderId,
    userId: input.companyContext.userId,
    locale: input.locale,
    tenderDetail: serializeTenderDetail(doc),
    companyContext: input.companyContext,
    citations: new CitationCollector(),
  };
}
