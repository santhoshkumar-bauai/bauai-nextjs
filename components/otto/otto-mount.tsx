import { getCompanyContext } from "@/lib/company/context";
import { connectMongoose } from "@/lib/db/mongoose";
import { isMilestoneId, type MilestoneId } from "@/lib/onboarding/milestones";
import { AccountProfile } from "@/models/account-profile";
import { Otto } from "./otto";

/**
 * Server-side mount for Otto, rendered from the ROOT layout.
 *
 * The root layout is the only place that survives client-side navigation. Otto
 * used to be mounted per page inside DashboardShell, which meant the agent
 * whose entire job is to drive navigation was torn down and remounted by every
 * route change it caused — the panel snapped shut mid-tour.
 *
 * Because this now also covers the marketing and auth routes, the session gate
 * matters: `getCompanyContext()` returns null for anyone not signed in with an
 * active membership, and Otto renders nothing.
 */
export async function OttoMount() {
  const context = await getCompanyContext();
  if (!context) return null;

  await connectMongoose();
  const profile = await AccountProfile.findOne({ userId: context.userId })
    .select({ onboardingAgent: 1 })
    .lean();

  const state = profile?.onboardingAgent;
  const status = state?.status ?? "not_started";
  // A one-click exit has to actually stop it being rendered, not just hide it.
  if (status === "dismissed") return null;

  const planned = (state?.plannedMilestoneIds ?? []).filter(isMilestoneId);
  const completed = (state?.completedMilestoneIds ?? []).filter(isMilestoneId);

  return (
    <Otto
      initialStatus={status}
      initialPlanned={planned as MilestoneId[]}
      initialCompleted={completed as MilestoneId[]}
    />
  );
}
