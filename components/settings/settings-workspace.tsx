"use client";

import {
  BadgeCheck,
  Building2,
  Check,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  CreditCard,
  FileText,
  Globe2,
  Landmark,
  Mail,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UserPlus,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

type SettingsMember = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  joinedAt: string;
};
type SettingsRequest = { id: string; email: string; requestedAt: string };

type Copy = {
  tabs: {
    company: string;
    tender: string;
    employees: string;
    billing: string;
    dora: string;
  };
  common: { preview: string; save: string; refresh: string; optional: string };
  company: {
    title: string;
    subtitle: string;
    completion: string;
    profile: string;
    completeProfile: string;
    profileHint: string;
    tenderInformation: string;
    companyInformation: string;
    companyDetails: string;
    companyDetailsHint: string;
    legalForm: string;
    foundingYear: string;
    registrationCourt: string;
    description: string;
    descriptionPlaceholder: string;
    website: string;
    services: string;
    cpv: string;
    region: string;
    businessDomain: string;
  };
  tender: {
    title: string;
    subtitle: string;
    services: string;
    cpv: string;
    region: string;
    emptyValue: string;
    matchingTitle: string;
    matchingDescription: string;
  };
  employees: {
    title: string;
    description: string;
    invite: string;
    name: string;
    email: string;
    role: string;
    status: string;
    account: string;
    action: string;
    active: string;
    registered: string;
    admin: string;
    member: string;
    pendingTitle: string;
    pendingDescription: string;
    noPending: string;
  };
  billing: {
    title: string;
    subtitle: string;
    plan: string;
    trial: string;
    trialDescription: string;
    seats: string;
    usage: string;
    previewTitle: string;
    previewDescription: string;
  };
  dora: {
    title: string;
    subtitle: string;
    cards: { analysis: string; drafting: string; review: string };
    description: string;
    previewTitle: string;
    previewDescription: string;
  };
};

type SettingsWorkspaceProps = {
  company: {
    name: string;
    website: string;
    businessDomain: string;
    region: string;
    services: string[];
    cpvCodes: string[];
    trialEndsAt: string;
  };
  members: SettingsMember[];
  requests: SettingsRequest[];
  canManageEmployees: boolean;
  copy: Copy;
};

type Tab = keyof Copy["tabs"];

const companySteps = [
  [Building2, "Company info"],
  [ClipboardList, "Company details"],
  [MapPin, "Principal office"],
  [Mail, "Mailing address"],
  [UsersRound, "Primary contact"],
  [Landmark, "Financial information"],
  [ShieldCheck, "Insurance"],
  [BadgeCheck, "Certifications"],
] as const;

const card =
  "rounded-[18px] border border-[#ebeaf0] bg-white shadow-[0_12px_34px_rgba(37,32,51,.04)]";
const previewTag =
  "inline-flex w-fit items-center gap-1.5 rounded-full border border-[#e5d9ff] bg-[#f5efff] px-2.5 py-1.5 text-[11px] font-bold text-[#7a28d2] whitespace-nowrap";
const panelIcon =
  "grid size-9 shrink-0 place-items-center rounded-[11px] bg-[#f2e8ff] text-[#741bd3]";

function initial(value: string) {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "BA"
  );
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}
function PreviewTag({ children }: { children: string }) {
  return (
    <span className={previewTag}>
      <Sparkles size={13} />
      {children}
    </span>
  );
}

export function SettingsWorkspace({
  company,
  members,
  requests,
  canManageEmployees,
  copy,
}: SettingsWorkspaceProps) {
  const [tab, setTab] = useState<Tab>("company");
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();
  const tabs: Tab[] = ["company", "tender", "employees", "billing", "dora"];
  const refresh = () => {
    setRefreshing(true);
    router.refresh();
    window.setTimeout(() => setRefreshing(false), 500);
  };

  return (
    <div className="min-h-full bg-[#f7f7f8] p-4 pb-21 text-[#141417] sm:p-7 lg:p-12">
      <header className="mx-auto mb-5 flex max-w-[1320px] items-start justify-between gap-5">
        <div>
          <span className="mb-1 block text-[11px] font-bold tracking-[.08em] text-[#787681] uppercase">
            {company.name}
          </span>
          <h1 className="m-0 text-[26px] font-bold tracking-[-.035em]">
            {copy.company.title}
          </h1>
        </div>
        <span className="hidden sm:inline">
          <PreviewTag>{copy.common.preview}</PreviewTag>
        </span>
      </header>
      <div
        className="mx-auto flex max-w-[1320px] overflow-x-auto border-b border-[#dfdfe4]"
        role="tablist"
        aria-label={copy.company.title}
      >
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            onClick={() => setTab(item)}
            className={`shrink-0 border-b-2 px-4 py-3 text-[13px] font-bold ${tab === item ? "border-[#6e16cf] text-[#5f13bb]" : "border-transparent text-[#4a4850] hover:text-[#5f13bb]"}`}
          >
            {copy.tabs[item]}
          </button>
        ))}
      </div>
      {tab === "company" && <CompanyPanel copy={copy} />}
      {tab === "tender" && <TenderPanel company={company} copy={copy} />}
      {tab === "employees" && (
        <EmployeesPanel
          members={members}
          requests={requests}
          canManage={canManageEmployees}
          copy={copy}
          refreshing={refreshing}
          onRefresh={refresh}
        />
      )}
      {tab === "billing" && <BillingPanel company={company} copy={copy} />}
      {tab === "dora" && <DoraPanel copy={copy} />}
    </div>
  );
}

function CompanyPanel({ copy }: Pick<SettingsWorkspaceProps, "copy">) {
  const completionGroups: Array<{
    Icon: LucideIcon;
    title: string;
    labels: string[];
  }> = [
    {
      Icon: FileText,
      title: copy.company.tenderInformation,
      labels: [copy.company.region, copy.company.services, copy.company.cpv],
    },
    {
      Icon: Building2,
      title: copy.company.companyInformation,
      labels: [copy.company.website, copy.company.businessDomain],
    },
  ];
  return (
    <div className="mx-auto mt-7 grid max-w-[1320px] grid-cols-1 gap-7 lg:grid-cols-[234px_minmax(0,1fr)]">
      <aside className={`${card} hidden self-start p-[18px] lg:block`}>
        <div className="flex justify-between text-xs font-bold text-[#393641]">
          <span>{copy.company.profile}</span>
          <strong className="text-[#6816c8]">38%</strong>
        </div>
        <div className="my-3 h-1.5 rounded-full bg-[#eceaf2]">
          <span className="block h-full w-[38%] rounded-full bg-[#721ae0]" />
        </div>
        <div className="grid gap-1">
          {companySteps.map(([Icon, label], index) => (
            <button
              className={`flex min-w-0 items-center gap-2 rounded-[9px] px-2 py-2 text-left text-[11px] ${index === 1 ? "bg-[#f3eaff] font-bold text-[#5e12bf]" : "text-[#3f3c46]"}`}
              type="button"
              key={label}
            >
              <span
                className={`grid size-[25px] shrink-0 place-items-center rounded-[7px] ${index === 1 ? "bg-[#e5d0ff] text-[#6814d2]" : "bg-[#f1f2f7] text-[#7a8292]"}`}
              >
                <Icon size={16} />
              </span>
              {label}
              <small className="ml-auto rounded-full bg-[#f2f2f5] px-1.5 py-0.5 text-[9px] text-[#92909b]">
                {index === 0 ? "2/7" : `0/${index + 3}`}
              </small>
            </button>
          ))}
        </div>
      </aside>
      <div className="min-w-0">
        <section
          className={`${card} grid items-center gap-5 border-[#ebd4ff] p-5 sm:grid-cols-[auto_minmax(180px,.65fr)] xl:grid-cols-[auto_minmax(180px,.65fr)_minmax(330px,1fr)]`}
        >
          <div className="grid size-[58px] place-items-center rounded-full border-[6px] border-[#ff8a2e] border-l-[#f4edf8] text-xs font-extrabold">
            62%
          </div>
          <div>
            <h2 className="m-0 text-base font-bold tracking-[-.02em]">
              {copy.company.completeProfile}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
              {copy.company.profileHint}
            </p>
          </div>
          <div className="grid gap-3 border-t border-[#ece9ef] pt-3 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-5">
            {completionGroups.map(({ Icon, title, labels }) => (
              <div className="flex flex-wrap gap-1.5" key={title}>
                <strong className="flex w-full items-center gap-1 text-[11px]">
                  <Icon size={15} />
                  {title}
                  <CircleHelp size={13} />
                </strong>
                {labels.map((label) => (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-[#eafbf1] px-2 py-1 text-[10px] text-[#09834c]"
                    key={label}
                  >
                    <Check size={12} />
                    {label}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </section>
        <section className={`${card} mt-[18px] p-5 sm:p-[26px]`}>
          <h2 className="m-0 text-base font-bold tracking-[-.02em]">
            {copy.company.companyDetails}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
            {copy.company.companyDetailsHint}
          </p>
          <div className="mt-5 grid gap-4">
            {[
              [copy.company.legalForm, "GmbH"],
              [copy.company.foundingYear, "2008"],
              [copy.company.registrationCourt, "Amtsgericht München"],
            ].map(([label, value]) => (
              <label
                className="grid gap-2 text-xs font-bold text-[#29262e]"
                key={label}
              >
                <span>{label}</span>
                <input
                  value={value}
                  readOnly
                  className="w-full rounded-[9px] border border-[#e1e1e8] bg-[#fafbfe] px-3.5 py-3 text-xs font-normal text-[#a0a0aa]"
                />
              </label>
            ))}
            <label className="grid gap-2 text-xs font-bold text-[#29262e]">
              <span>{copy.company.description}</span>
              <textarea
                placeholder={copy.company.descriptionPlaceholder}
                readOnly
                className="min-h-[86px] w-full resize-y rounded-[9px] border border-[#e1e1e8] bg-[#fafbfe] px-3.5 py-3 text-xs font-normal text-[#a0a0aa]"
              />
            </label>
          </div>
        </section>
        <div className="mt-4 flex items-center gap-3 px-1 py-3">
          <span className="mr-auto text-[11px] text-[#8a8491]">
            {copy.common.preview}
          </span>
          <Button
            type="button"
            className="bg-[#6516dc] text-white hover:bg-[#5711c2]"
          >
            {copy.common.save}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TenderPanel({
  company,
  copy,
}: Pick<SettingsWorkspaceProps, "company" | "copy">) {
  const rows = [
    [Globe2, copy.tender.region, company.region],
    [
      Building2,
      copy.tender.services,
      company.services.join(", ") || copy.tender.emptyValue,
    ],
    [
      ClipboardList,
      copy.tender.cpv,
      company.cpvCodes.join(", ") || copy.tender.emptyValue,
    ],
  ] as const;
  return (
    <div className="mx-auto my-7 grid max-w-[1056px] gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(270px,.65fr)]">
      <section className={`${card} p-6`}>
        <div className="flex items-start justify-between gap-5">
          <div className="flex items-start gap-3">
            <span className={panelIcon}>
              <ClipboardList size={19} />
            </span>
            <div>
              <h2 className="m-0 text-base font-bold">{copy.tender.title}</h2>
              <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
                {copy.tender.subtitle}
              </p>
            </div>
          </div>
          <PreviewTag>{copy.common.preview}</PreviewTag>
        </div>
        {rows.map(([Icon, label, value]) => (
          <div
            className="flex items-center gap-3 border-t border-[#f0eef2] py-[18px] first:mt-[22px]"
            key={label}
          >
            <span className="grid size-8 place-items-center rounded-[9px] bg-[#f5f5f8] text-[#6b6872]">
              <Icon size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <strong className="text-xs">{label}</strong>
              <p className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[#85818c]">
                {value}
              </p>
            </div>
            <ChevronRight size={18} className="text-[#a5a2ab]" />
          </div>
        ))}
      </section>
      <section className={`${card} flex min-h-60 flex-col p-6`}>
        <span className={panelIcon}>
          <Sparkles size={20} />
        </span>
        <h2 className="mt-5 text-base font-bold">
          {copy.tender.matchingTitle}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
          {copy.tender.matchingDescription}
        </p>
        <div className="mt-auto grid gap-2">
          <span className="h-2 rounded-full bg-[linear-gradient(90deg,#7021db_60%,#efe9f8_60%)]" />
          <span className="h-2 rounded-full bg-[linear-gradient(90deg,#a850e6_38%,#efe9f8_38%)]" />
          <span className="h-2 rounded-full bg-[linear-gradient(90deg,#d5a5ff_75%,#efe9f8_75%)]" />
        </div>
      </section>
    </div>
  );
}

function EmployeesPanel({
  members,
  requests,
  canManage,
  copy,
  refreshing,
  onRefresh,
}: Pick<SettingsWorkspaceProps, "members" | "requests" | "copy"> & {
  canManage: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="mx-auto my-7 grid max-w-[1280px] gap-[18px]">
      <section className={`${card} p-5 sm:p-6`}>
        <header className="block sm:flex sm:items-start sm:justify-between sm:gap-5">
          <div>
            <h2 className="m-0 text-base font-bold tracking-[-.02em]">
              {copy.employees.title}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
              {copy.employees.description}
            </p>
          </div>
          <div className="mt-3 flex gap-2 sm:mt-0">
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={refreshing}
            >
              <RefreshCw
                size={15}
                className={refreshing ? "animate-spin" : ""}
              />
              {copy.common.refresh}
            </Button>
            {canManage && (
              <Button
                size="sm"
                disabled
                title={copy.common.preview}
                className="bg-[#6516dc] text-white"
              >
                <UserPlus size={15} />
                {copy.employees.invite}
              </Button>
            )}
          </div>
        </header>
        <div className="mt-5 overflow-x-auto">
          <table className="min-w-[760px] w-full border-collapse text-left">
            <thead>
              <tr>
                {[
                  copy.employees.name,
                  copy.employees.email,
                  copy.employees.role,
                  copy.employees.status,
                  copy.employees.account,
                  copy.employees.action,
                ].map((label) => (
                  <th
                    className="border-b border-[#e9e8ed] px-3 pb-3 text-[11px] font-bold text-[#66626c]"
                    key={label}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td className="border-b border-[#f0eff2] px-3 py-3">
                    <span className="flex items-center gap-2 text-[#222027]">
                      <i className="grid size-8 place-items-center rounded-full border border-[#dfc9ff] bg-[#f0e4ff] text-[10px] font-extrabold not-italic text-[#6423ba]">
                        {initial(member.name)}
                      </i>
                      <strong>{member.name}</strong>
                    </span>
                  </td>
                  <td className="border-b border-[#f0eff2] px-3 py-3 text-xs text-[#57535d]">
                    {member.email}
                  </td>
                  <td className="border-b border-[#f0eff2] px-3 py-3 text-xs text-[#57535d]">
                    {member.role === "admin"
                      ? copy.employees.admin
                      : copy.employees.member}
                  </td>
                  <td className="border-b border-[#f0eff2] px-3 py-3">
                    <span className="rounded-full bg-[#dbf9e9] px-2 py-1 text-[10px] font-bold text-[#0b8b4b]">
                      {copy.employees.active}
                    </span>
                  </td>
                  <td className="border-b border-[#f0eff2] px-3 py-3">
                    <span className="rounded-full bg-[#edf7ee] px-2 py-1 text-[10px] font-bold text-[#498350]">
                      {copy.employees.registered}
                    </span>
                  </td>
                  <td className="border-b border-[#f0eff2] px-3 py-3 text-[10px] text-[#93909a]">
                    {formatDate(member.joinedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className={`${card} p-5 sm:p-6`}>
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="m-0 text-base font-bold">
              {copy.employees.pendingTitle}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
              {copy.employees.pendingDescription}
            </p>
          </div>
          <span className="grid size-7 place-items-center rounded-full bg-[#f1e6ff] text-xs font-extrabold text-[#6f19c8]">
            {requests.length}
          </span>
        </header>
        {requests.length ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {requests.map((request) => (
              <div
                className="flex items-center gap-2 rounded-xl border border-[#eee9f3] p-2.5"
                key={request.id}
              >
                <span className="grid size-8 place-items-center rounded-full border border-[#dfc9ff] bg-[#f0e4ff] text-[10px] font-extrabold text-[#6423ba]">
                  {initial(request.email)}
                </span>
                <div className="min-w-0">
                  <strong className="block truncate text-[11px]">
                    {request.email}
                  </strong>
                  <p className="mt-0.5 text-[10px] text-[#8d8993]">
                    {formatDate(request.requestedAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-2 text-xs text-[#4e785e]">
            <Check size={18} className="text-[#1c9a5f]" />
            {copy.employees.noPending}
          </div>
        )}
      </section>
    </div>
  );
}

function BillingPanel({
  company,
  copy,
}: Pick<SettingsWorkspaceProps, "company" | "copy">) {
  return (
    <div className="mx-auto my-7 grid max-w-[920px] gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(270px,.65fr)]">
      <section className={`${card} flex flex-col gap-11 p-6`}>
        <div className="flex items-start gap-3">
          <span className={panelIcon}>
            <CreditCard size={19} />
          </span>
          <div>
            <h2 className="m-0 text-base font-bold">{copy.billing.plan}</h2>
            <p className="mt-1 text-xs text-[#85818c]">
              {copy.billing.subtitle}
            </p>
          </div>
        </div>
        <div className="grid gap-1.5">
          <strong className="text-[25px] text-[#6516dc]">
            {copy.billing.trial}
          </strong>
          <span className="text-xs text-[#837f89]">
            {copy.billing.trialDescription} {formatDate(company.trialEndsAt)}
          </span>
        </div>
      </section>
      <section className={`${card} flex flex-col p-6`}>
        <h2 className="m-0 text-base font-bold">{copy.billing.usage}</h2>
        <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
          {copy.billing.previewDescription}
        </p>
        <div className="my-6 grid gap-3">
          <span className="flex items-center gap-2 text-xs text-[#53505a]">
            <UsersRound size={17} className="text-[#7b25d5]" />
            {copy.billing.seats}
            <b className="ml-auto text-[#26232a]">1 / 10</b>
          </span>
          <span className="flex items-center gap-2 text-xs text-[#53505a]">
            <Sparkles size={17} className="text-[#7b25d5]" />
            AI actions<b className="ml-auto text-[#26232a]">0 / 100</b>
          </span>
        </div>
        <div className="mt-auto">
          <PreviewTag>{copy.billing.previewTitle}</PreviewTag>
        </div>
      </section>
    </div>
  );
}

function DoraPanel({ copy }: Pick<SettingsWorkspaceProps, "copy">) {
  return (
    <div className="mx-auto my-7 max-w-[980px]">
      <section
        className={`${card} flex items-start gap-3.5 p-6 sm:items-center`}
      >
        <span className={panelIcon}>
          <Sparkles size={23} />
        </span>
        <div className="flex-1">
          <h2 className="m-0 text-base font-bold">{copy.dora.title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
            {copy.dora.subtitle}
          </p>
        </div>
        <span className="hidden sm:inline">
          <PreviewTag>{copy.dora.previewTitle}</PreviewTag>
        </span>
      </section>
      <p className="my-5 max-w-[620px] text-xs leading-relaxed text-[#85818c]">
        {copy.dora.previewDescription}
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {Object.entries(copy.dora.cards).map(([key, title], index) => (
          <article className={`${card} p-5`} key={key}>
            <span className="grid size-[29px] place-items-center rounded-lg bg-[#f0e5ff] text-xs font-extrabold text-[#6817cd]">
              {index + 1}
            </span>
            <h3 className="mt-7 text-sm font-bold">{title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
              {copy.dora.description}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
