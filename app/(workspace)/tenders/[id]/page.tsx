import { ObjectId } from "mongodb";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { OttoMount } from "@/components/otto/otto-mount";
import { TenderDetailPage } from "@/components/tenders/tender-detail-page";
import { buildDashboardCopy } from "@/lib/dashboard/shell-copy";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";

/**
 * Full-screen view of a single tender — the expanded form of the detail popup
 * on /tenders. Gating mirrors the listing page; the tender itself is loaded
 * client-side from /api/tenders/[id], the same endpoint the popup uses.
 */
const TAB_VALUES = new Set(["about", "documents", "schedule", "ai"]);

export default async function TenderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();
  const { tab } = await searchParams;
  const initialTab = TAB_VALUES.has(tab ?? "")
    ? (tab as "about" | "documents" | "schedule" | "ai")
    : undefined;

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
      workspaceContent={<TenderDetailPage tenderId={id} initialTab={initialTab} />}
      copy={copy}
    />
  );
}
