import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { OttoMount } from "@/components/otto/otto-mount";
import {
  ComingSoonPage,
  KanbanBoard,
} from "@/components/workspace/workspace-pages";
import { buildDashboardCopy } from "@/lib/dashboard/shell-copy";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";

// `settings` is intentionally not here — it has its own route tree under
// app/(workspace)/settings, which takes precedence over this dynamic segment.
const sectionKeys = {
  tenders: "tenders",
  tutorial: "tutorial",
  notifications: "notifications",
  pricing: "pricing",
  support: "support",
  profile: "profile",
} as const;

type WorkspaceSectionPageProps = {
  params: Promise<{ section: string }>;
};

export default async function WorkspaceSectionPage({
  params,
}: WorkspaceSectionPageProps) {
  const { section } = await params;
  if (section === "workspace") redirect("/kanban");
  if (section !== "kanban" && !(section in sectionKeys)) notFound();

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

  const [workspace, copy] = await Promise.all([
    getTranslations("Workspace"),
    buildDashboardCopy(),
  ]);
  const fullName =
    session.user.name?.trim() || session.user.email.split("@")[0];

  const content =
    section === "kanban" ? (
      <KanbanBoard
        title={workspace("kanban.title")}
        workspaceLabel={workspace("kanban.workspace")}
        deadZoneLabel={workspace("kanban.deadZone")}
        noTenders={workspace("kanban.noTenders")}
        emptyHint={workspace("kanban.emptyHint")}
        columns={[
          {
            key: "interested",
            title: workspace("kanban.columns.interested"),
            color: "#2d43f5",
            tint: "#eaf1ff",
          },
          {
            key: "preparing",
            title: workspace("kanban.columns.preparing"),
            color: "#ff873d",
            tint: "#fff4ec",
          },
          {
            key: "submitted",
            title: workspace("kanban.columns.submitted"),
            color: "#9a2ce7",
            tint: "#f6efff",
          },
          {
            key: "won",
            title: workspace("kanban.columns.won"),
            color: "#1dab72",
            tint: "#e9f9f3",
          },
          {
            key: "lost",
            title: workspace("kanban.columns.lost"),
            color: "#f05238",
            tint: "#fff0ed",
          },
        ]}
      />
    ) : (
      <ComingSoonPage
        section={workspace(
          `sections.${sectionKeys[section as keyof typeof sectionKeys]}`,
        )}
        eyebrow={workspace("comingSoon.eyebrow")}
        title={workspace("comingSoon.title")}
        description={workspace("comingSoon.description")}
        backLabel={workspace("comingSoon.back")}
      />
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
