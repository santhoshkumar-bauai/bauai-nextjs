import { ObjectId } from "mongodb";

import { connectMongoose } from "@/lib/db/mongoose";
import { HIDDEN_STATUSES, TenderDecision } from "@/models/tender-decision";

/**
 * The decisions a company has already made about tenders, in the two shapes
 * every feed needs: ids to hide, and pipeline labels to show.
 *
 * Shared by the classic and AI-matched feeds so a rejected tender disappears
 * from both and an "In workspace" badge appears on both — the two modes are
 * different rankings of the same corpus, not different products.
 */

export interface CompanyDecisions {
  /** Rejected / deleted — dropped from the feed entirely. */
  excludeIds: ObjectId[];
  /** tenderId (hex) → pipeline status, for the "In workspace" label. */
  pipelineByTender: Map<string, string>;
}

export async function loadCompanyDecisions(
  companyId: string,
): Promise<CompanyDecisions> {
  await connectMongoose();
  const decisions = await TenderDecision.find({ companyId })
    .select({ tenderId: 1, status: 1 })
    .lean();

  const hidden = new Set<string>(HIDDEN_STATUSES);
  const excludeIds = decisions
    .filter((decision) => hidden.has(decision.status))
    .filter((decision) => ObjectId.isValid(decision.tenderId))
    .map((decision) => new ObjectId(decision.tenderId));

  const pipelineByTender = new Map(
    decisions
      .filter((decision) => !hidden.has(decision.status))
      .map((decision) => [decision.tenderId, decision.status]),
  );

  return { excludeIds, pipelineByTender };
}
