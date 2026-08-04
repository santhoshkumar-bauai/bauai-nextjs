import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { MembershipRequests } from "@/components/company/membership-requests";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");

  await connectMongoose();
  const profile = await AccountProfile.findOne({ userId: session.user.id }).lean();
  if (!profile?.onboardingCompleted) redirect("/onboarding");

  const [locale, t] = await Promise.all([getLocale(), getTranslations("Dashboard")]);

  if (profile.membershipStatus === "pending" || profile.membershipStatus === "rejected") {
    const isPending = profile.membershipStatus === "pending";
    return (
      <main className="dashboard-placeholder membership-status-page">
        <span>BAU AI</span>
        <div className={`membership-status-icon ${isPending ? "is-pending" : "is-rejected"}`} aria-hidden="true">
          {isPending ? "…" : "×"}
        </div>
        <h1>{isPending ? t("pendingTitle") : t("rejectedTitle")}</h1>
        <p>{isPending ? t("pendingDescription") : t("rejectedDescription")}</p>
      </main>
    );
  }

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? t("goodMorning") : hour < 18 ? t("goodAfternoon") : t("goodEvening");
  const fullName = session.user.name?.trim() || session.user.email.split("@")[0];
  const firstName = fullName.split(/\s+/)[0];
  const dateLabel = new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);
  const remaining = t("sevenLeft");
  const agents = [
    {
      name: "Patrick",
      role: t("agents.patrick.role"),
      description: t("agents.patrick.description"),
      image: "/agents/patrick.svg",
      available: false,
    },
    {
      name: "Dora",
      role: t("agents.dora.role"),
      description: t("agents.dora.description"),
      image: "/agents/dora.svg",
      available: true,
      remaining,
    },
    {
      name: "Clara",
      role: t("agents.clara.role"),
      description: t("agents.clara.description"),
      image: "/agents/clara.svg",
      available: true,
      remaining,
    },
    {
      name: "Dario",
      role: t("agents.dario.role"),
      description: t("agents.dario.description"),
      image: "/agents/dario.svg",
      available: false,
    },
    {
      name: "Nova",
      role: t("agents.nova.role"),
      description: t("agents.nova.description"),
      image: "/agents/nova.jpg",
      available: true,
      remaining,
    },
  ];

  return (
    <DashboardShell
      firstName={firstName}
      fullName={fullName}
      email={session.user.email}
      dateLabel={dateLabel}
      copy={{
        greeting,
        chooseAgent: t("chooseAgent"),
        comingSoon: t("comingSoon"),
        composerPlaceholder: t("composerPlaceholder"),
        attachDocument: t("attachDocument"),
        send: t("send"),
        profileMenu: {
          open: t("profileMenu.open"),
          profileSettings: t("profileMenu.profileSettings"),
          language: t("profileMenu.language"),
          english: t("profileMenu.english"),
          german: t("profileMenu.german"),
          signOut: t("profileMenu.signOut"),
          signingOut: t("profileMenu.signingOut"),
        },
        nav: {
          aiBoard: t("nav.aiBoard"),
          workspace: t("nav.workspace"),
          tenders: t("nav.tenders"),
          documentFiller: t("nav.documentFiller"),
          beta: t("nav.beta"),
          tutorial: t("nav.tutorial"),
          settings: t("nav.settings"),
          notifications: t("nav.notifications"),
          pricing: t("nav.pricing"),
          support: t("nav.support"),
          collapse: t("nav.collapse"),
          expand: t("nav.expand"),
        },
        agents,
      }}
      adminPanel={profile.role === "admin" ? <MembershipRequests /> : undefined}
    />
  );
}
