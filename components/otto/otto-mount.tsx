import { connectMongoose } from "@/lib/db/mongoose";
import { isMilestoneId, type MilestoneId } from "@/lib/onboarding/milestones";
import { AccountProfile } from "@/models/account-profile";
import { Otto } from "./otto";

/**
 * Server-side mount for Otto: reads the durable onboarding state and hands it
 * to the client component, so the launcher renders with the right label on the
 * first paint instead of flashing "Get started" at someone who is halfway
 * through.
 *
 * Returns null for a dismissed tour — the one-click exit has to actually stop
 * it from being rendered, not just hide it.
 */
export async function OttoMount({ userId }: { userId: string }) {
  await connectMongoose();
  const profile = await AccountProfile.findOne({ userId })
    .select({ onboardingAgent: 1 })
    .lean();

  const state = profile?.onboardingAgent;
  const status = state?.status ?? "not_started";
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
