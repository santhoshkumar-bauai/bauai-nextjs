"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowUp,
  Bell,
  BriefcaseBusiness,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  FileSearch,
  FileText,
  Headphones,
  Languages,
  LayoutGrid,
  LogOut,
  Paperclip,
  Settings,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useLocale } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { localeCookie, type Locale } from "@/i18n/config";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

type Agent = {
  name: string;
  role: string;
  description: string;
  image: string;
  available: boolean;
  remaining?: string;
  /** When set, clicking the card navigates instead of selecting. */
  href?: string;
};
type DashboardCopy = {
  nav: {
    aiBoard: string;
    workspace: string;
    tenders: string;
    documentFiller: string;
    beta: string;
    tutorial: string;
    settings: string;
    notifications: string;
    pricing: string;
    support: string;
    collapse: string;
    expand: string;
  };
  greeting: string;
  chooseAgent: string;
  comingSoon: string;
  composerPlaceholder: string;
  attachDocument: string;
  send: string;
  profileMenu: {
    open: string;
    profileSettings: string;
    language: string;
    english: string;
    german: string;
    signOut: string;
    signingOut: string;
  };
  agents: Agent[];
};
type DashboardShellProps = {
  copy: DashboardCopy;
  dateLabel: string;
  firstName: string;
  fullName: string;
  email: string;
  adminPanel?: ReactNode;
  workspaceContent?: ReactNode;
};

const mainNavigation = [
  { key: "aiBoard" as const, icon: LayoutGrid, href: "/dashboard" },
  { key: "workspace" as const, icon: BriefcaseBusiness, href: "/kanban" },
  { key: "tenders" as const, icon: FileSearch, href: "/tenders" },
  {
    key: "documentFiller" as const,
    icon: FileText,
    href: "/document-filler",
    beta: true,
  },
];
const secondaryNavigation = [
  { key: "tutorial" as const, icon: Sparkles, href: "/tutorial" },
  { key: "settings" as const, icon: Settings, href: "/settings" },
  { key: "notifications" as const, icon: Bell, href: "/notifications" },
  { key: "pricing" as const, icon: CreditCard, href: "/pricing" },
  { key: "support" as const, icon: Headphones, href: "/support" },
];

const navItem =
  "relative flex min-h-[43px] items-center gap-3 whitespace-nowrap rounded-[13px] px-3 text-[13px] text-[#60636c] transition-colors hover:bg-[#f5f6f9] hover:text-[#30343d] max-[820px]:justify-center max-[820px]:px-0 max-[560px]:min-h-12";
const activeNavItem =
  "bg-white/95 text-[#22242a] shadow-[0_10px_24px_rgba(35,39,52,.065),inset_0_0_0_1px_rgba(242,243,247,.9)]";
const avatar =
  "grid size-[38px] shrink-0 place-items-center rounded-full border border-[#ddc5ff] bg-[#efe1ff] text-[13px] font-bold text-[#6d27c5]";
const profileText =
  "grid min-w-0 gap-0.5 max-[820px]:hidden [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:text-xs [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap [&_span]:text-[10px] [&_span]:text-[#777b85]";
const menuAction =
  "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-[9px] border-0 bg-transparent px-[7px] text-left text-xs text-[#555860] transition-colors hover:bg-[#f6f6f9] hover:text-[#2f3340]";
const composerButton =
  "grid size-[38px] shrink-0 place-items-center rounded-full border-0 bg-transparent text-[#44474f] transition-colors hover:bg-[#f0f2ff] hover:text-[#3048eb]";

function persistLocale(nextLocale: Locale) {
  document.cookie = `${localeCookie}=${nextLocale};path=/;max-age=31536000;samesite=lax`;
}

export function DashboardShell({
  copy,
  dateLabel,
  firstName,
  fullName,
  email,
  adminPanel,
  workspaceContent,
}: DashboardShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState("Clara");
  const [fileName, setFileName] = useState("");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!profileMenuOpen) return;
    const closeMenu = (event: MouseEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node))
        setProfileMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [profileMenuOpen]);

  const changeLocale = (nextLocale: Locale) => {
    persistLocale(nextLocale);
    setProfileMenuOpen(false);
    router.refresh();
  };
  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    const result = await authClient.signOut();
    if (result.error) {
      setSigningOut(false);
      return;
    }
    router.replace("/login");
    router.refresh();
  };

  const overlayLeft = collapsed ? "left-[76px]" : "left-[244px]";
  const hideWhenCollapsed = collapsed ? "hidden" : "";

  return (
    <main
      className={cn(
        "grid min-h-svh w-full overflow-hidden bg-[#f9fafc] text-[#171717] transition-[grid-template-columns] duration-200 motion-reduce:transition-none max-[820px]:grid-cols-[74px_minmax(0,1fr)] max-[560px]:block",
        collapsed
          ? "grid-cols-[76px_minmax(0,1fr)]"
          : "grid-cols-[244px_minmax(0,1fr)]",
      )}
    >
      <aside
        className="relative z-10 flex h-svh min-w-0 flex-col border-r border-[#e8eaf0] bg-white/94 shadow-[12px_0_34px_rgba(25,31,49,.035)] backdrop-blur-[18px] max-[560px]:fixed max-[560px]:inset-x-0 max-[560px]:bottom-0 max-[560px]:h-16 max-[560px]:w-full max-[560px]:flex-row max-[560px]:border-t max-[560px]:border-r-0"
        aria-label="BAU AI"
      >
        <div
          className={cn(
            "flex min-h-[74px] items-center justify-between gap-2.5 px-3.5 pt-4 pb-3 max-[820px]:flex-col max-[820px]:px-2 max-[820px]:py-3.5 max-[560px]:hidden",
            collapsed && "flex-col px-2.5 py-[15px]",
          )}
        >
          <Link
            href="/dashboard"
            className={cn(
              "flex min-w-[38px] items-center [&_img]:max-w-full [&_img]:object-contain",
              collapsed && "justify-center",
            )}
            aria-label="BAU AI dashboard"
          >
            <Image
              src={collapsed ? "/brand/logo_small.svg" : "/brand/logo_name.svg"}
              width={collapsed ? 36 : 112}
              height={36}
              alt="BAU AI"
              priority
              className="max-[820px]:w-9"
            />
          </Link>
          <button
            type="button"
            className="grid size-[34px] shrink-0 place-items-center rounded-full border border-[#eceef3] bg-white/85 text-[#5f6572] shadow-[0_4px_14px_rgba(29,33,48,.04)] transition hover:-translate-y-px hover:border-[#d9ddeb] hover:text-[#3146ed] motion-reduce:transition-none max-[820px]:hidden"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? copy.nav.expand : copy.nav.collapse}
            title={collapsed ? copy.nav.expand : copy.nav.collapse}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <nav
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pb-3 max-[820px]:px-2 max-[560px]:w-full max-[560px]:p-[7px_10px]",
            collapsed && "px-[9px]",
          )}
          aria-label="Primary navigation"
        >
          <div className="grid gap-1.5 max-[560px]:h-full max-[560px]:grid-cols-4">
            {mainNavigation.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={cn(
                    navItem,
                    pathname === item.href && activeNavItem,
                    collapsed && "justify-center px-0",
                  )}
                >
                  <Icon size={19} strokeWidth={1.7} />
                  <span className={cn("max-[820px]:hidden", hideWhenCollapsed)}>
                    {copy.nav[item.key]}
                  </span>
                  {item.beta && (
                    <small
                      className={cn(
                        "ml-auto rounded-full bg-[#f2e7ff] px-[7px] py-[3px] text-[9px] font-bold text-[#8a21dc] max-[820px]:hidden",
                        hideWhenCollapsed,
                      )}
                    >
                      {copy.nav.beta}
                    </small>
                  )}
                </Link>
              );
            })}
          </div>
          <div className="mt-auto grid gap-1.5 pt-6 max-[560px]:hidden">
            {secondaryNavigation.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={cn(
                    navItem,
                    pathname === item.href && activeNavItem,
                    collapsed && "justify-center px-0",
                  )}
                >
                  <Icon size={19} strokeWidth={1.7} />
                  <span className={cn("max-[820px]:hidden", hideWhenCollapsed)}>
                    {copy.nav[item.key]}
                  </span>
                </Link>
              );
            })}
          </div>
        </nav>

        <div
          className="relative shrink-0 border-t border-[#eff0f3] max-[560px]:hidden"
          ref={profileMenuRef}
        >
          {profileMenuOpen && (
            <div
              className="absolute bottom-3 left-[calc(100%-6px)] z-40 w-[232px] overflow-hidden rounded-2xl border border-[#e1e2e7] bg-white/98 shadow-[0_18px_48px_rgba(31,35,48,.16),0_3px_10px_rgba(31,35,48,.06)] backdrop-blur-[22px]"
              role="menu"
              aria-label={copy.profileMenu.open}
            >
              <div className="flex min-w-0 items-center gap-[11px] px-[15px] py-4">
                <div className={avatar}>
                  {fullName.trim().charAt(0).toUpperCase() || "U"}
                </div>
                <div className={profileText}>
                  <strong>{fullName}</strong>
                  <span>{email}</span>
                </div>
              </div>
              <div className="border-t border-[#e8e8eb] px-3 py-2.5">
                <Link
                  href="/profile"
                  className={menuAction}
                  role="menuitem"
                  onClick={() => setProfileMenuOpen(false)}
                >
                  <UserRound size={17} />
                  <span>{copy.profileMenu.profileSettings}</span>
                </Link>
              </div>
              <div className="border-t border-[#e8e8eb] px-3 py-2.5">
                <div className="flex min-h-9 w-full items-center gap-2.5 px-[7px] text-xs text-[#555860]">
                  <Languages size={17} />
                  <span>{copy.profileMenu.language}</span>
                </div>
                <div
                  className="flex gap-[9px] pt-0.5 pr-[7px] pb-[7px] pl-[34px]"
                  aria-label={copy.profileMenu.language}
                >
                  {(["en", "de"] as const).map((language) => (
                    <button
                      key={language}
                      type="button"
                      className={cn(
                        "min-h-[30px] cursor-pointer rounded-[9px] border border-[#d8dbe4] bg-white px-[11px] text-[10px] font-semibold text-[#565962] transition-colors hover:border-[#c4c9dc]",
                        locale === language &&
                          "border-[#eee2ff] bg-[#f1e7ff] text-[#7924c7]",
                      )}
                      onClick={() => changeLocale(language)}
                    >
                      {language === "en"
                        ? copy.profileMenu.english
                        : copy.profileMenu.german}
                    </button>
                  ))}
                </div>
              </div>
              <div className="border-t border-[#e8e8eb] px-3 py-2.5">
                <button
                  type="button"
                  className={cn(
                    menuAction,
                    "text-red-500 hover:bg-red-50 hover:text-red-600 disabled:cursor-wait disabled:opacity-60",
                  )}
                  onClick={handleSignOut}
                  disabled={signingOut}
                  role="menuitem"
                >
                  <LogOut size={17} />
                  <span>
                    {signingOut
                      ? copy.profileMenu.signingOut
                      : copy.profileMenu.signOut}
                  </span>
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            className={cn(
              "flex min-h-[78px] w-full cursor-pointer items-center gap-[11px] border-0 bg-transparent px-4 py-[13px] text-left text-inherit transition-colors hover:bg-[#faf9fd] aria-expanded:bg-[#faf9fd] max-[820px]:justify-center max-[820px]:px-0",
              collapsed && "justify-center px-2",
            )}
            onClick={() => setProfileMenuOpen((value) => !value)}
            aria-haspopup="menu"
            aria-expanded={profileMenuOpen}
            aria-label={copy.profileMenu.open}
          >
            <div className={avatar}>
              {fullName.trim().charAt(0).toUpperCase() || "U"}
            </div>
            <div className={cn(profileText, collapsed && "hidden")}>
              <strong>{fullName}</strong>
              <span>{email}</span>
            </div>
          </button>
        </div>
      </aside>

      <section className="relative h-svh min-w-0 overflow-auto bg-[#fbfbfd] max-[560px]:h-[calc(100svh-64px)]">
        {!workspaceContent && (
          <>
            <div
              className={cn(
                "pointer-events-none fixed inset-y-0 right-0 bg-[radial-gradient(circle_at_50%_35%,rgba(238,240,255,.62),transparent_35%),radial-gradient(circle_at_60%_82%,rgba(245,241,255,.45),transparent_28%)] transition-[left] duration-200 motion-reduce:transition-none max-[820px]:left-[74px] max-[560px]:left-0",
                overlayLeft,
              )}
              aria-hidden="true"
            />
            <div
              className={cn(
                "pointer-events-none fixed inset-y-0 right-0 bg-[radial-gradient(#d9dce6_.85px,transparent_.85px)] opacity-[.58] [background-size:24px_24px] transition-[left] duration-200 motion-reduce:transition-none max-[820px]:left-[74px] max-[560px]:left-0",
                overlayLeft,
              )}
              aria-hidden="true"
            />
          </>
        )}
        {workspaceContent ? (
          <div className="relative z-1 min-h-full w-full">
            {workspaceContent}
          </div>
        ) : (
          <div className="relative z-1 mx-auto flex min-h-full w-[min(1130px,calc(100%-48px))] flex-col items-center pt-[46px] pb-8 max-[820px]:w-[min(calc(100%-30px),740px)] max-[820px]:pt-7 max-[560px]:pb-[22px]">
            <header className="flex flex-col items-center text-center">
              <time className="rounded-full border border-white/95 bg-white/72 px-[18px] py-2.5 text-[10px] font-bold tracking-[.14em] text-[#6a6d74] uppercase shadow-[0_7px_24px_rgba(26,31,49,.055)] backdrop-blur-2xl">
                {dateLabel}
              </time>
              <h1 className="mt-4 text-[clamp(34px,4vw,48px)] font-bold leading-[1.08] tracking-[-.045em] max-[560px]:text-[31px]">
                {copy.greeting},{" "}
                <span className="text-[#3f55ef]">{firstName}</span>
              </h1>
              <p className="mt-2.5 text-base font-medium text-[#5e6068] max-[560px]:text-sm">
                {copy.chooseAgent}
              </p>
            </header>
            <div className="mt-[42px] grid w-full grid-cols-5 gap-3.5 max-[1180px]:grid-cols-3 max-[820px]:mt-[30px] max-[820px]:grid-cols-2 max-[560px]:grid-cols-1">
              {copy.agents.map((agent) => {
                const selected = selectedAgent === agent.name;
                return (
                  <button
                    type="button"
                    key={agent.name}
                    className={cn(
                      "relative flex min-h-[250px] min-w-0 flex-col items-start rounded-[27px] border border-[#eceef5] bg-white/82 px-[18px] pt-5 pb-[18px] text-left text-[#292b31] shadow-[0_18px_42px_rgba(38,43,65,.055)] backdrop-blur-[18px] transition-[transform,border-color,box-shadow] duration-200 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[rgba(63,84,239,.22)] motion-reduce:transition-none max-[560px]:min-h-[220px]",
                      agent.available
                        ? "cursor-pointer border-2 border-[#bcc5ff] hover:-translate-y-1 hover:border-[#7587fa] hover:shadow-[0_22px_48px_rgba(63,84,239,.14)]"
                        : "bg-[rgba(250,250,252,.64)] text-[#777980] saturate-20",
                      selected &&
                        agent.available &&
                        "-translate-y-1 border-[#7587fa] shadow-[0_22px_48px_rgba(63,84,239,.14)]",
                    )}
                    onClick={() => {
                      if (!agent.available) return;
                      if (agent.href) router.push(agent.href);
                      else setSelectedAgent(agent.name);
                    }}
                    disabled={!agent.available}
                    aria-pressed={agent.available ? selected : undefined}
                  >
                    <div className="mb-3 flex w-full items-start justify-between">
                      <span className="relative block size-[46px] overflow-hidden rounded-full border-[3px] border-[#8966f4] bg-[#e5dcff] shadow-[0_5px_14px_rgba(84,60,178,.2)]">
                        <Image
                          src={agent.image}
                          alt=""
                          width={46}
                          height={46}
                          unoptimized
                          className="h-full w-full object-cover"
                        />
                      </span>
                      {agent.available ? (
                        <span
                          className="size-[9px] rounded-full bg-[#5bda95] shadow-[0_0_0_3px_rgba(91,218,149,.12)]"
                          aria-label="Available"
                        />
                      ) : (
                        <span className="rounded-full border border-[#eaebef] bg-white/80 px-2.5 py-1.5 text-[9px] font-semibold text-[#a0a2a8]">
                          {copy.comingSoon}
                        </span>
                      )}
                    </div>
                    <strong
                      className={cn(
                        "text-base font-bold text-[#203df2]",
                        !agent.available && "text-[#5c5e63]",
                      )}
                    >
                      {agent.name}
                    </strong>
                    <span
                      className={cn(
                        "mt-2 text-xs font-medium text-[#5a70f3]",
                        !agent.available && "text-[#9b9da4]",
                      )}
                    >
                      {agent.role}
                    </span>
                    <p
                      className={cn(
                        "mt-[15px] line-clamp-3 overflow-hidden text-xs leading-[1.58] text-[#474950]",
                        !agent.available && "text-[#999ba1]",
                      )}
                    >
                      {agent.description}
                    </p>
                    {agent.remaining && (
                      <small className="mt-auto rounded-full border border-[#e3e6fb] bg-[#f8f9ff] px-2 py-1 text-[9px] font-bold text-[#6478f3]">
                        {agent.remaining}
                      </small>
                    )}
                  </button>
                );
              })}
            </div>
            {adminPanel && (
              <div className="mt-8 w-[min(760px,100%)]">{adminPanel}</div>
            )}
            <div className="min-h-[50px] flex-1" />
            <form
              className="sticky bottom-7 flex min-h-[54px] w-[min(650px,100%)] items-center gap-2.5 rounded-full border border-[rgba(219,221,228,.95)] bg-white/90 py-[7px] pr-2.5 pl-3.5 shadow-[0_12px_35px_rgba(35,38,55,.12)] backdrop-blur-[20px] max-[560px]:bottom-3.5"
              onSubmit={(event) => event.preventDefault()}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                accept=".pdf,.doc,.docx,.xls,.xlsx"
                onChange={(event) =>
                  setFileName(event.target.files?.[0]?.name || "")
                }
              />
              <button
                type="button"
                className={composerButton}
                onClick={() => fileInputRef.current?.click()}
                aria-label={copy.attachDocument}
                title={copy.attachDocument}
              >
                <Paperclip size={18} />
              </button>
              <span
                className={cn(
                  "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs",
                  fileName ? "font-semibold text-[#4a4d55]" : "text-[#a1a3aa]",
                )}
              >
                {fileName || copy.composerPlaceholder}
              </span>
              <button
                type="submit"
                className={composerButton}
                aria-label={copy.send}
                title={copy.send}
              >
                <ArrowUp size={18} />
              </button>
            </form>
          </div>
        )}
      </section>
    </main>
  );
}
