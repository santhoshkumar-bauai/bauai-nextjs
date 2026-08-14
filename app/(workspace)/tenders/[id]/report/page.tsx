import { ObjectId } from "mongodb";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { TenderReportView } from "@/components/tenders/report/tender-report-view";
import { buildDashboardCopy } from "@/lib/dashboard/shell-copy";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";

/**
 * The full tender report on a page of its own — the deepest view in the
 * product, deliberately separate from the tender detail so it can be read,
 * printed and exported without the surrounding tabs. Gating mirrors the tender
 * pages; the report itself is fetched client-side from /api/tenders/[id]/report.
 */
export default async function TenderReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();

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
      workspaceContent={<TenderReportView tenderId={id} />}
      copy={copy}
    />
  );
}
