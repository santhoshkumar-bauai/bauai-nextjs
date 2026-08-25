import { after, NextResponse } from "next/server";

import { ObjectId } from "mongodb";

import { aiEnv } from "@/lib/ai/config/env";
import {
  embeddingIdentity,
  getMatchProfileState,
} from "@/lib/ai/match/company-profile";
import { runCompanyMatchJob } from "@/lib/ai/match/job";
import { claimRun, getRun, serializeRun } from "@/lib/ai/match/runs";
import { MATCH_JUDGE_PROMPT_VERSION } from "@/lib/ai/match/schema";
import { getCompanyContext } from "@/lib/company/context";
import { aiRoleConfigured } from "@/lib/ai/gateway/config";

/**
 * Starts (or joins) an AI match refresh for the caller's company.
 *
 * Uses `after()` rather than only enqueuing to BullMQ so the feature works on
 * a dev machine with no worker running — the same tradeoff the report route
 * makes. `maxDuration` is generous because a cold refresh embeds the profile
 * and runs one ANN query per facet.
 */

export const maxDuration = 300;

export async function POST() {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!aiEnv().matchEnabled) {
    return NextResponse.json({ error: "AI matching is disabled" }, { status: 503 });
  }
  // Deliberately not the generic guard. Matching EMBEDS the company profile
  // against the Atlas vector index as well as judging with an LLM, and the
  // embedding role stays on Gemini — moving it would mean re-embedding the
  // whole corpus and rebuilding both vector indexes. So this route needs the
  // embedding provider specifically, not "some provider".
  if (!aiRoleConfigured("embedding") || !aiRoleConfigured("match")) {
    return NextResponse.json(
      { error: "No AI provider configured" },
      { status: 503 },
    );
  }

  const env = aiEnv();
  const tenantId = new ObjectId(String(context.company._id));
  const { companyDataHash } = await getMatchProfileState(tenantId);

  const claimed = await claimRun({
    tenantId,
    companyDataHash,
    promptVersion: MATCH_JUDGE_PROMPT_VERSION,
    pipelineVersion: env.matchPipelineVersion,
    embeddingIdentity: embeddingIdentity(),
    trigger: "manual",
    userId: context.userId,
  });

  if (!claimed) {
    // Someone else is already refreshing this company. Report their run rather
    // than paying for a second one.
    const existing = await getRun(tenantId);
    return NextResponse.json(
      { run: existing ? serializeRun(existing) : null, joined: true },
      { status: 202 },
    );
  }

  // Survives the response: the user is free to navigate away.
  after(() => runCompanyMatchJob({ tenantId, runId: claimed.runId }));

  return NextResponse.json(
    { run: serializeRun(claimed), joined: false },
    { status: 202 },
  );
}
