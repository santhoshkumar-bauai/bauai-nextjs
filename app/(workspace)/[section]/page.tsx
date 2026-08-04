import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { SettingsWorkspace } from "@/components/settings/settings-workspace";
import {
  ComingSoonPage,
  KanbanBoard,
} from "@/components/workspace/workspace-pages";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { mongoDatabase } from "@/lib/db/mongodb";
import { AccountProfile } from "@/models/account-profile";
import { Company } from "@/models/company";

const sectionKeys = {
  tenders: "tenders",
  "document-filler": "documentFiller",
  tutorial: "tutorial",
  settings: "settings",
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

  const [dashboard, workspace, settings] = await Promise.all([
    getTranslations("Dashboard"),
    getTranslations("Workspace"),
    getTranslations("Settings"),
  ]);
  const fullName =
    session.user.name?.trim() || session.user.email.split("@")[0];

  const company =
    section === "settings"
      ? await Company.findById(profile.companyId).lean()
      : null;
  const companyMembers = company?.members ?? [];
  const memberUserIds = companyMembers.map((member) => member.userId);
  const accountUsers = memberUserIds.length
    ? await mongoDatabase
        .collection<{ id: string; name?: string; email?: string }>("user")
        .find(
          { id: { $in: memberUserIds } },
          { projection: { id: 1, name: 1, email: 1 } },
        )
        .toArray()
    : [];
  const accountUsersById = new Map(accountUsers.map((user) => [user.id, user]));

  const settingsCopy = {
    tabs: {
      company: settings("tabs.company"),
      tender: settings("tabs.tender"),
      employees: settings("tabs.employees"),
      billing: settings("tabs.billing"),
      dora: settings("tabs.dora"),
    },
    common: {
      preview: settings("common.preview"),
      save: settings("common.save"),
      refresh: settings("common.refresh"),
      optional: settings("common.optional"),
    },
    company: {
      title: settings("company.title"),
      subtitle: settings("company.subtitle"),
      completion: settings("company.completion"),
      profile: settings("company.profile"),
      completeProfile: settings("company.completeProfile"),
      profileHint: settings("company.profileHint"),
      tenderInformation: settings("company.tenderInformation"),
      companyInformation: settings("company.companyInformation"),
      companyDetails: settings("company.companyDetails"),
      companyDetailsHint: settings("company.companyDetailsHint"),
      legalForm: settings("company.legalForm"),
      foundingYear: settings("company.foundingYear"),
      registrationCourt: settings("company.registrationCourt"),
      description: settings("company.description"),
      descriptionPlaceholder: settings("company.descriptionPlaceholder"),
      website: settings("company.website"),
      services: settings("company.services"),
      cpv: settings("company.cpv"),
      region: settings("company.region"),
      businessDomain: settings("company.businessDomain"),
    },
    tender: {
      title: settings("tender.title"),
      subtitle: settings("tender.subtitle"),
      services: settings("tender.services"),
      cpv: settings("tender.cpv"),
      region: settings("tender.region"),
      emptyValue: settings("tender.emptyValue"),
      matchingTitle: settings("tender.matchingTitle"),
      matchingDescription: settings("tender.matchingDescription"),
    },
    employees: {
      title: settings("employees.title"),
      description: settings("employees.description"),
      invite: settings("employees.invite"),
      name: settings("employees.name"),
      email: settings("employees.email"),
      role: settings("employees.role"),
      status: settings("employees.status"),
      account: settings("employees.account"),
      action: settings("employees.action"),
      active: settings("employees.active"),
      registered: settings("employees.registered"),
      admin: settings("employees.admin"),
      member: settings("employees.member"),
      pendingTitle: settings("employees.pendingTitle"),
      pendingDescription: settings("employees.pendingDescription"),
      noPending: settings("employees.noPending"),
    },
    billing: {
      title: settings("billing.title"),
      subtitle: settings("billing.subtitle"),
      plan: settings("billing.plan"),
      trial: settings("billing.trial"),
      trialDescription: settings("billing.trialDescription"),
      seats: settings("billing.seats"),
      usage: settings("billing.usage"),
      previewTitle: settings("billing.previewTitle"),
      previewDescription: settings("billing.previewDescription"),
    },
    dora: {
      title: settings("dora.title"),
      subtitle: settings("dora.subtitle"),
      cards: {
        analysis: settings("dora.cards.analysis"),
        drafting: settings("dora.cards.drafting"),
        review: settings("dora.cards.review"),
      },
      description: settings("dora.description"),
      previewTitle: settings("dora.previewTitle"),
      previewDescription: settings("dora.previewDescription"),
    },
  };

  const content =
    section === "settings" && company ? (
      <SettingsWorkspace
        company={{
          name: company.name,
          website: company.website,
          businessDomain: company.businessDomain,
          region: company.region,
          services: company.services,
          cpvCodes: company.cpvCodes,
          trialEndsAt: company.trial.endsAt.toISOString(),
        }}
        members={companyMembers.map((member) => {
          const accountUser = accountUsersById.get(member.userId);
          return {
            id: member.userId,
            name:
              accountUser?.name ||
              (member.userId === session.user.id
                ? fullName
                : member.email.split("@")[0]),
            email: accountUser?.email || member.email,
            role: member.role,
            joinedAt: member.joinedAt.toISOString(),
          };
        })}
        requests={company.membershipRequests
          .filter((request) => request.status === "pending")
          .map((request) => ({
            id: request.userId,
            email: request.email,
            requestedAt: request.requestedAt.toISOString(),
          }))}
        canManageEmployees={profile.role === "admin"}
        copy={settingsCopy}
      />
    ) : section === "kanban" ? (
      <KanbanBoard
        title={workspace("kanban.title")}
        tenderCount={workspace("kanban.tenderCount")}
        previewTitle={workspace("kanban.previewTitle")}
        previewDescription={workspace("kanban.previewDescription")}
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
      firstName={fullName.split(/\s+/)[0]}
      fullName={fullName}
      email={session.user.email}
      dateLabel=""
      workspaceContent={content}
      copy={{
        greeting: dashboard("goodMorning"),
        chooseAgent: dashboard("chooseAgent"),
        comingSoon: dashboard("comingSoon"),
        composerPlaceholder: dashboard("composerPlaceholder"),
        attachDocument: dashboard("attachDocument"),
        send: dashboard("send"),
        profileMenu: {
          open: dashboard("profileMenu.open"),
          profileSettings: dashboard("profileMenu.profileSettings"),
          language: dashboard("profileMenu.language"),
          english: dashboard("profileMenu.english"),
          german: dashboard("profileMenu.german"),
          signOut: dashboard("profileMenu.signOut"),
          signingOut: dashboard("profileMenu.signingOut"),
        },
        nav: {
          aiBoard: dashboard("nav.aiBoard"),
          workspace: dashboard("nav.workspace"),
          tenders: dashboard("nav.tenders"),
          documentFiller: dashboard("nav.documentFiller"),
          beta: dashboard("nav.beta"),
          tutorial: dashboard("nav.tutorial"),
          settings: dashboard("nav.settings"),
          notifications: dashboard("nav.notifications"),
          pricing: dashboard("nav.pricing"),
          support: dashboard("nav.support"),
          collapse: dashboard("nav.collapse"),
          expand: dashboard("nav.expand"),
        },
        agents: [],
      }}
    />
  );
}
