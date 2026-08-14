import type { ObjectId } from "mongodb";

import { connectMongoose } from "../db/mongoose.ts";
import { getAiCollections } from "../ai/db/collections.ts";
import { Company } from "../../models/company.ts";
import { TenderDecision } from "../../models/tender-decision.ts";
import { WorkspaceDocument } from "../../models/workspace-document.ts";
import { MILESTONE_IDS, type MilestoneId } from "./milestones.ts";

/**
 * Server-side completion checks — one per milestone, all against real app data.
 *
 * Nothing here asks the model whether a step is done. A guide that advances on
 * the agent's say-so will confidently congratulate someone for work they never
 * did, and the whole progress checklist becomes fiction. Every advance goes
 * through one of these queries instead.
 *
 * Kept apart from ./milestones.ts, which must stay client-safe.
 */

export interface MilestoneContext {
  /** AI collections are tenant-scoped by this id. */
  tenantId: ObjectId;
  /** Mongoose models key off the company. */
  companyId: ObjectId;
  userId: string;
}

type CompletionCheck = (ctx: MilestoneContext) => Promise<boolean>;

/**
 * The profile signals that actually drive tender matching. Deliberately not
 * the sidebar's completion percentage: that meter counts 22 cosmetic fields,
 * and someone can hit 60% on address and VAT alone while matching still has
 * nothing to work with.
 */
async function hasUsableCompanyProfile(ctx: MilestoneContext): Promise<boolean> {
  await connectMongoose();
  const company = await Company.findById(ctx.companyId)
    .select({ services: 1, cpvCodes: 1, region: 1 })
    .lean();
  if (!company) return false;
  return (
    (company.services?.length ?? 0) > 0 &&
    (company.cpvCodes?.length ?? 0) > 0 &&
    Boolean(company.region?.trim())
  );
}

async function hasCompletedMatchRun(ctx: MilestoneContext): Promise<boolean> {
  const { companyMatchRuns } = await getAiCollections();
  // `lastCompletedRunId` is what readers pin to — a run that is still going
  // (or failed) has not produced matches the user can look at.
  const run = await companyMatchRuns.findOne({
    tenantId: ctx.tenantId,
    lastCompletedRunId: { $ne: null },
  });
  return run !== null;
}

async function hasSavedTender(ctx: MilestoneContext): Promise<boolean> {
  await connectMongoose();
  // TenderDecision stores companyId as a hex STRING, unlike the ObjectId refs
  // elsewhere — matching on the ObjectId silently returns nothing.
  const count = await TenderDecision.countDocuments({
    companyId: ctx.companyId.toHexString(),
  }).limit(1);
  return count > 0;
}

async function hasUploadedDocument(ctx: MilestoneContext): Promise<boolean> {
  await connectMongoose();
  const count = await WorkspaceDocument.countDocuments({
    companyId: ctx.companyId,
    deletedAt: null,
  }).limit(1);
  return count > 0;
}

async function hasAskedClara(ctx: MilestoneContext): Promise<boolean> {
  const { chatThreads } = await getAiCollections();
  const thread = await chatThreads.findOne({
    tenantId: ctx.tenantId,
    agent: "clara",
    messageCount: { $gt: 0 },
  });
  return thread !== null;
}

async function hasGeneratedReport(ctx: MilestoneContext): Promise<boolean> {
  const { tenderReports } = await getAiCollections();
  const report = await tenderReports.findOne({ tenantId: ctx.tenantId });
  return report !== null;
}

/**
 * Exhaustive by construction: `Record<MilestoneId, …>` means adding a
 * milestone without a completion check is a compile error, which is the point.
 */
const COMPLETION_CHECKS: Record<MilestoneId, CompletionCheck> = {
  complete_company_profile: hasUsableCompanyProfile,
  build_ai_matches: hasCompletedMatchRun,
  save_first_tender: hasSavedTender,
  // Reviewing the board is only meaningful once something is on it; there is
  // no separate "visited" record, and inventing one to track a page view would
  // be worse than deriving it from the work itself.
  review_pipeline: hasSavedTender,
  upload_first_document: hasUploadedDocument,
  ask_clara: hasAskedClara,
  generate_first_report: hasGeneratedReport,
};

export async function isMilestoneComplete(
  id: MilestoneId,
  ctx: MilestoneContext,
): Promise<boolean> {
  try {
    return await COMPLETION_CHECKS[id](ctx);
  } catch {
    // A failed check means "not verified", never "done". Advancing on a
    // database hiccup is the one outcome worth ruling out.
    return false;
  }
}

/** Every milestone's current state, for the checklist and the planner. */
export async function completedMilestones(
  ctx: MilestoneContext,
): Promise<MilestoneId[]> {
  const results = await Promise.all(
    MILESTONE_IDS.map(async (id) => ({
      id,
      done: await isMilestoneComplete(id, ctx),
    })),
  );
  return results.filter((result) => result.done).map((result) => result.id);
}
