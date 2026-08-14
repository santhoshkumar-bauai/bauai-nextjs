import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { OttoMount } from "@/components/otto/otto-mount";
import { RelevantTenders } from "@/components/tenders/relevant-tenders";
import { buildDashboardCopy } from "@/lib/dashboard/shell-copy";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";

/**
 * Relevant-tenders workspace section. This static segment takes precedence over
 * the `[section]` dynamic route (which otherwise renders a ComingSoon placeholder
 * for `tenders`), the same way `settings` has its own route tree. Gating mirrors
 * `app/(workspace)/[section]/page.tsx`.
 */
export default async function TendersPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");

  await connectMongoose();
  const profile = await AccountProfile.findOne({ userId: session.user.id }).lean();
  if (!profile?.onboardingCompleted) redirect("/onboarding");
  if (
    profile.membershipStatus === "pending" ||
    profile.membershipStatus === "rejected"
  ) {
    redirect("/dashboard");
  }

  const copy = await buildDashboardCopy();
  const fullName = session.user.name?.trim() || session.user.email.split("@")[0];

  return (
    <DashboardShell

      onboardingAgent={<OttoMount userId={session.user.id} />}
      firstName={fullName.split(/\s+/)[0]}
      fullName={fullName}
      email={session.user.email}
      dateLabel=""
      workspaceContent={
        <Suspense>
          <RelevantTenders />
        </Suspense>
      }
      copy={copy}
    />
  );
}
