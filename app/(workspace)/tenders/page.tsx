import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { RelevantTenders } from "@/components/tenders/relevant-tenders";
import { buildDashboardCopy } from "@/lib/dashboard/shell-copy";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";

/** Split-view chrome, drawn while the feed hydrates. */
function TendersFallback() {
  return (
    <div className="flex h-svh flex-col overflow-hidden max-[560px]:h-[calc(100svh-64px)]">
      <div className="h-14 shrink-0 border-b border-border" />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="h-52 animate-pulse rounded-2xl border border-border bg-muted/40"
            />
          ))}
        </div>
        <div className="hidden border-l border-border bg-card lg:block" />
      </div>
    </div>
  );
}

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
      firstName={fullName.split(/\s+/)[0]}
      fullName={fullName}
      email={session.user.email}
      dateLabel=""
      workspaceContent={
        // `RelevantTenders` reads the URL query, so it is client-rendered up to
        // this boundary. The fallback matters: without one the whole workspace
        // column is blank until hydration finishes.
        <Suspense fallback={<TendersFallback />}>
          <RelevantTenders />
        </Suspense>
      }
      copy={copy}
    />
  );
}
