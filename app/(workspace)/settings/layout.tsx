import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { OttoMount } from "@/components/otto/otto-mount";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { buildDashboardCopy } from "@/lib/dashboard/shell-copy";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";

export default async function SettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");

  await connectMongoose();
  const profile = await AccountProfile.findOne({
    userId: session.user.id,
  }).lean();
  if (!profile?.onboardingCompleted) redirect("/onboarding");
  if (
    profile.membershipStatus === "pending" ||
    profile.membershipStatus === "rejected"
  )
    redirect("/dashboard");

  const fullName = session.user.name?.trim() || session.user.email.split("@")[0];
  const copy = await buildDashboardCopy();

  const content = (
    <div className="min-h-full bg-[#f7f7f8] p-4 pb-21 text-[#141417] sm:p-7 lg:p-12">
      <header className="mx-auto mb-5 max-w-[1320px]">
        <span className="mb-1 block text-[11px] font-bold tracking-[.08em] text-[#787681] uppercase">
          {session.user.name?.trim() || session.user.email}
        </span>
        <h1 className="m-0 text-[26px] font-bold tracking-[-.035em]">
          {copy.nav.settings}
        </h1>
      </header>
      <SettingsTabs />
      {children}
    </div>
  );

  return (
    <DashboardShell

      onboardingAgent={<OttoMount userId={session.user.id} />}
      firstName={fullName.split(/\s+/)[0]}
      fullName={fullName}
      email={session.user.email}
      dateLabel=""
      workspaceContent={content}
      copy={copy}
    />
  );
}
