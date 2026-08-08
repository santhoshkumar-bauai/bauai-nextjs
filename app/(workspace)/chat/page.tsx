import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { DoraChatWorkspace } from "@/components/chat/dora-chat-workspace";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { buildDashboardCopy } from "@/lib/dashboard/shell-copy";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";

/**
 * Full-page Dora chat (sessions sidebar + thread view). Static segment beats
 * the `[section]` dynamic route, same as `tenders`. Gating mirrors
 * `app/(workspace)/tenders/page.tsx`. The client workspace reads `?thread=` /
 * `?tender=` itself, hence only a Suspense boundary here (useSearchParams).
 */
export default async function ChatPage() {
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
      firstName={fullName.split(/\s+/)[0]}
      fullName={fullName}
      email={session.user.email}
      dateLabel=""
      workspaceContent={
        <Suspense>
          <DoraChatWorkspace />
        </Suspense>
      }
      copy={copy}
    />
  );
}
