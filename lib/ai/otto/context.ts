import { ObjectId } from "mongodb";

import type { CompanyContext } from "../../company/context.ts";
import type { MilestoneContext } from "../../onboarding/completion.ts";
import type { OnboardingRole } from "../../onboarding/milestones.ts";
import { aiEnv } from "../config/env.ts";
import { CitationCollector } from "../agent/citations.ts";
import type { AgentRunContext } from "../agent/context.ts";
import { TenderRefCollector } from "../agent/tender-refs.ts";
import { UiCallCollector } from "../agent/ui-calls.ts";
import { forCompanyContext } from "../tenant/repository.ts";

/**
 * Everything an Otto run needs, derived SERVER-SIDE from the authenticated
 * request. Same rule as Clara's context: tools close over this, so no tool
 * input ever carries a tenant or company identifier and a prompt-injected
 * call cannot change scope.
 */
export interface OttoRunContext extends AgentRunContext {
  /** Company role, which decides what Otto is allowed to plan. */
  onboardingRole: OnboardingRole;
  /** Whether AI matching exists on this deployment; gates a milestone. */
  matchEnabled: boolean;
  /** The scope every completion check runs against. */
  milestoneContext: MilestoneContext;
  /**
   * Client-published readables for this turn. UNTRUSTED: rendered into the
   * prompt as context so Otto stops asking where the user is, but nothing is
   * decided from it — completion is always a database question.
   */
  clientContext: Record<string, unknown>;
}

export function buildOttoRunContext(input: {
  companyContext: CompanyContext;
  locale: "en" | "de";
  clientContext?: Record<string, unknown>;
}): OttoRunContext {
  const tenantId = forCompanyContext(input.companyContext).value;
  const companyId = new ObjectId(String(input.companyContext.company._id));

  return {
    tenantId,
    userId: input.companyContext.userId,
    locale: input.locale,
    companyContext: input.companyContext,
    citations: new CitationCollector(),
    tenderRefs: new TenderRefCollector(),
    uiCalls: new UiCallCollector(),
    // Otto is never bound to one tender; it guides around the whole product.
    tender: null,
    tenderCache: new Map(),
    onboardingRole: input.companyContext.role === "admin" ? "admin" : "member",
    matchEnabled: aiEnv().matchEnabled,
    clientContext: input.clientContext ?? {},
    milestoneContext: {
      tenantId,
      companyId,
      userId: input.companyContext.userId,
    },
  };
}
